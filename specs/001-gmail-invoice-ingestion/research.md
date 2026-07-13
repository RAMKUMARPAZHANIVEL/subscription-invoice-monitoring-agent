# Research: Gmail Invoice Ingestion & Extraction (Phase 1)

All items below were open technical questions in the Technical Context; each is resolved with a
decision, rationale, and the alternatives considered.

## 1. Gmail authentication for a single admin account

**Decision**: OAuth2 "installed app" flow, run interactively once to obtain a refresh token, which
is then stored in Secret Manager (and mirrored to a local `.env` value for development). The
running service uses `google-auth-library` to mint short-lived access tokens from that refresh
token at request time, scoped to `https://www.googleapis.com/auth/gmail.readonly`.

**Rationale**: The spec only requires access to "the admin Gmail account" — it does not state the
account is on Google Workspace, so domain-wide delegation (which requires Workspace admin console
configuration) cannot be assumed available. OAuth2 with a stored refresh token works for any Gmail
account, needs no organizational admin action, and is the standard pattern for a single-account,
unattended service. Read-only scope satisfies least privilege (Principle IV) since Gmail labels
are never written — processing state lives entirely in Postgres.

**Alternatives considered**:
- *Domain-wide delegation (service account)*: Cleaner for unattended refresh (no refresh-token
  rotation risk), but requires Google Workspace and a domain admin to grant delegation — an
  assumption not supported by the spec. Revisit if/when the account is confirmed to be Workspace.
- *Gmail `gmail.modify` scope with label-based tracking*: Rejected — would duplicate the
  processing-history responsibility across Gmail labels and Postgres, and needs a wider, riskier
  scope for no added benefit given IX/idempotency is already handled by the DB.

## 2. Invoice email discovery strategy

**Decision**: Deterministic Gmail search: build a query from the configured vendor list's sender
domains/addresses (e.g., `from:(billing@github.com OR invoices@aws.amazon.com ...)`), scoped to
messages newer than the agent's first-activation timestamp (per FR-011 — no historical backfill).
Each scheduled run queries for messages since the last successful run's high-water mark.

**Rationale**: Keeps invoice *discovery* deterministic (Principle III) — AI is not used to decide
"is this an invoice," only to extract structured fields once a candidate email is already matched
to a configured vendor. This also directly satisfies FR-002 (config-driven vendor identification)
and keeps false-positive risk low, since only mail from configured vendor senders is even
considered.

**Alternatives considered**:
- *AI-based email classification across the entire inbox*: More flexible (could catch invoices
  from not-yet-configured vendors) but violates Principle III's requirement that core discovery
  stay deterministic, and risks false positives across unrelated mail. Rejected for Phase 1;
  configured-vendor-only matching is the documented Assumption in the spec.
- *Gmail push notifications (Cloud Pub/Sub watch)*: Real-time, but adds infrastructure (Pub/Sub
  topic, watch renewal every 7 days) for no benefit given FR-010 only requires a daily cadence.
  Rejected as unnecessary complexity (Principle XII).

## 3. PDF text extraction

**Decision**: `pdf-parse` for extracting the text layer from PDF attachments before handing the
text to the extraction step.

**Rationale**: Lightweight, no native build step (works cleanly in the existing Docker multi-stage
build), and sufficient for the common case of digitally-generated vendor invoices (not scanned
images). Handles the two named formats (PDF and CSV) in FR-003 without adding a heavy dependency.

**Alternatives considered**:
- *`pdfjs-dist`*: More capable (rendering, not just text extraction) but heavier and intended for
  browser/rendering use cases we don't need.
- *OCR (e.g., Cloud Vision)*: Needed only for scanned/image-only PDFs, which the spec's Edge Cases
  and Risks explicitly acknowledge as a known failure mode to surface diagnosably, not solve in
  Phase 1. Deferred.

## 4. CSV parsing

**Decision**: `csv-parse` (from the `csv` package family) for CSV attachment parsing.

**Rationale**: Well-maintained, streaming-capable, TypeScript-friendly, and matches the project's
existing preference for small, focused dependencies over heavier frameworks.

**Alternatives considered**: `papaparse` — more commonly used browser-side; `csv-parse` is the
more idiomatic choice for a Node backend.

## 5. Structured invoice extraction approach

**Decision**: Use the Claude API (`@anthropic-ai/sdk`) with a strict JSON-schema tool-use call to
convert extracted text (email body, or PDF/CSV text) into the structured `Invoice` fields from
FR-004. The response is validated with a Zod schema before it's allowed to reach persistence
(Principle IX) — any response that fails validation is treated as an extraction failure (FR-009),
not written to the `Invoice` table.

**Rationale**: `ANTHROPIC_API_KEY` is already provisioned in `src/config/env.ts`, and Principle III
explicitly scopes AI to "invoice understanding, vendor identification, metadata extraction" —
which is exactly this step. Using structured tool-use output (rather than free-text parsing)
keeps the AI boundary tightly typed and testable.

**Alternatives considered**:
- *Regex/rule-based extraction per vendor template*: More deterministic, but brittle against the
  Risk already identified in the spec ("vendor invoice formats change over time") and would need a
  bespoke parser per vendor, contradicting configuration-over-code (Principle V) for anything
  beyond field position. Reserved as a possible per-vendor optimization later, not the Phase 1
  default.
- *Non-Claude LLM provider*: No other provider key exists in this codebase; introducing one adds
  an unjustified new dependency/secret with no stated requirement (Principle XII).

## 6. PostgreSQL hosting for Cloud Run

**Decision**: Cloud SQL for PostgreSQL, connected from Cloud Run via the Cloud SQL connector
(`DATABASE_URL` supplied through Secret Manager); Prisma migrations run as a CI/deploy step.

**Rationale**: The constitution mandates PostgreSQL + Prisma + Cloud Run; Cloud SQL is the
standard managed Postgres offering that integrates with Cloud Run without custom networking, and
keeps the service itself stateless (Principle VII).

**Alternatives considered**: Self-hosted Postgres — rejected, adds operational burden with no
benefit for a small, low-volume service.

## 7. Attachment storage: reconciling "local storage" with Cloud Run durability

**Decision**: Store attachment bytes in Google Cloud Storage from Phase 1, behind an
`AttachmentStore` interface. A `LocalAttachmentStore` (writes to local disk) exists only for local
development/testing convenience (selected via an env var, default off); every deployed environment
uses `GcsAttachmentStore`.

**Rationale**: The spec's phrase "stores invoices ... locally (and later in cloud storage)" is
resolved in favor of durability: Cloud Run instances have ephemeral, non-shared local disks, so
literal local-disk storage cannot satisfy NFR-002 ("survive a service restart or redeployment") or
the constitution's Reliability First principle once deployed. The constitution's own Technology &
Deployment Constraints already list Cloud Storage as part of the required stack — it is not a
"later" item at the governance level. "Local" in the spec is therefore interpreted as "storage the
service owns directly" (satisfied by Cloud Storage + Postgres), not "the container's local disk."
This resolution is also recorded in the spec's Assumptions section.

**Alternatives considered**:
- *Store attachment bytes directly in Postgres (`bytea`)*: Simpler (one system, one durability
  guarantee) and would technically satisfy NFR-002. Rejected in favor of Cloud Storage because the
  constitution explicitly ratifies Cloud Storage as required technology, and keeping large binary
  blobs out of the primary OLTP database is standard practice that avoids future migration work.
- *Literal Cloud Run local disk*: Rejected outright — does not survive restarts/redeploys,
  directly violates NFR-002.

## 8. Scheduling mechanism

**Decision**: Cloud Scheduler invokes a new `POST /tasks/ingest-invoices` endpoint once daily,
authenticated via an OIDC token (Cloud Scheduler's built-in service-account-to-Cloud-Run auth),
matching the existing `POST /tasks/check-invoices` pattern already scaffolded in `server.ts`.

**Rationale**: Reuses the exact trigger pattern already established in this codebase and by the
constitution's required stack (Cloud Scheduler), and needs no new infrastructure beyond one
Scheduler job.

**Alternatives considered**: In-process cron (e.g., `node-cron`) — rejected because Cloud Run
instances are not guaranteed to stay warm/running continuously, making in-process scheduling
unreliable; Cloud Scheduler hitting an HTTP endpoint is the standard Cloud Run pattern.

## 9. Idempotency key

**Decision**: `SourceEmail.gmailMessageId` (Gmail's immutable per-account message ID) is the
unique natural key. Ingestion is implemented as an upsert keyed on this field; a `SourceEmail` row
is created (or found) before any extraction work happens, so even a crash mid-extraction cannot
lead to double-processing on retry.

**Rationale**: Gmail message IDs are unique and stable within an account, directly satisfying
FR-007/NFR-003 without needing a separate dedup table or content hashing.

**Alternatives considered**: Content hash of email body — unnecessary given Gmail already provides
a stable unique ID; would only help if de-duplicating across multiple mailboxes, which is out of
Phase 1 scope.

## 10. Testing strategy for Gmail API and the database

**Decision**: Unit tests cover pure logic (vendor matching, PDF/CSV text extraction, Zod
validation of Claude's output) with no network/DB dependency. Integration tests run against a real
test PostgreSQL database (via Prisma, a dedicated test schema/database — no ORM mocking) and a
hand-written fake Gmail API client that implements the same narrow interface `client.ts` consumes,
seeded with fixture message payloads.

**Rationale**: Matches Principle X (test-first for critical business logic: email processing,
dedup, extraction, vendor classification, retry, config loading) and avoids the false confidence
of mocking the database, consistent with treating dedup/idempotency as a DB-constraint-level
guarantee that must be exercised for real.

**Alternatives considered**: Mocking Prisma entirely — rejected; the unique-constraint-based
idempotency guarantee (item 9 above) is precisely the kind of behavior a mock would fail to catch
if the constraint were ever accidentally dropped from the schema.
