# Implementation Plan: Gmail Invoice Ingestion & Extraction (Phase 1)

**Branch**: `001-gmail-invoice-ingestion` | **Date**: 2026-07-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-gmail-invoice-ingestion/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Extend the existing Express/Cloud Run service with a daily-scheduled ingestion pipeline that
connects to a single admin Gmail account, identifies subscription invoice emails from a
config-driven vendor list, downloads their attachments, extracts structured invoice data
(deterministically where possible, via Claude where extraction genuinely requires understanding),
and persists invoices, attachments, and a full processing history — without ever creating a
duplicate record for an email already seen. Storage is Postgres (via Prisma) for structured data
and Cloud Storage for attachment blobs, so results survive Cloud Run restarts/redeploys. An
operator-facing read API exposes invoices and processing history for review.

## Technical Context

**Language/Version**: TypeScript 5.7 on Node.js >=20 (existing repo stack; `strict` mode per
constitution Principle IX)

**Primary Dependencies**:
- `googleapis` + `google-auth-library` — Gmail API access via OAuth2 (existing account, not
  Workspace domain-wide delegation; see research.md)
- `@anthropic-ai/sdk` — Claude-based structured invoice extraction (the `ANTHROPIC_API_KEY` env
  var already exists in `src/config/env.ts`, currently unused)
- `@prisma/client` + `prisma` (dev) — ORM over PostgreSQL (constitution-mandated)
- `@google-cloud/storage` — durable attachment blob storage
- `pdf-parse` — PDF text extraction; `csv-parse` — CSV parsing
- `zod` (existing), `pino` (existing), `express` (existing)

**Storage**: PostgreSQL via Prisma for `Vendor`, `SourceEmail`, `Invoice`, `Attachment` (metadata),
`ProcessingHistoryEntry`; Google Cloud Storage for attachment blob bytes (see research.md for why
Cloud Run's local disk cannot satisfy the durability requirement)

**Testing**: Vitest (existing). Unit tests for pure parsing/extraction/vendor-matching logic;
integration tests against a real test PostgreSQL database (no DB mocking) and a faked Gmail API
client (contract-level fake, not a live account) per constitution Principle X

**Target Platform**: GCP Cloud Run (Linux container), invoked daily by Cloud Scheduler via an
authenticated HTTP call — extends the existing `Dockerfile`/`deploy.yml` pipeline

**Project Type**: Single project — extends the existing Express web service; no new deployable
units

**Performance Goals**: A full daily run over current volume (1 mailbox, ~10 configured vendors,
monthly billing cadence — on the order of tens of emails per run) completes in well under 5
minutes; a failure on one email must never block evaluation of the rest of the run

**Constraints**: No hardcoded credentials (Secret Manager / env vars only, per Principle IV);
Gmail auth, scheduling, storage, and retries are deterministic code — Claude is scoped to invoice
understanding/extraction only, per Principle III; invoice records and attachments must survive a
Cloud Run restart or redeploy, per NFR-002

**Scale/Scope**: Single Gmail account, ~10 configured vendors at launch (config-driven, so this
grows without code changes), low email volume — a correctness- and auditability-first system, not
a high-throughput one

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan satisfies it |
|---|---|---|
| I. Reliability First | PASS | Every candidate email produces a `ProcessingHistoryEntry`; recoverable failures are retried, exhausted retries are recorded with diagnostics (FR-008/FR-009, NFR-001). Per-email try/catch isolation so one bad email never aborts a run. |
| II. Idempotent Processing | PASS | `SourceEmail.gmailMessageId` is a unique key; ingestion is an upsert-by-message-id, so retries/re-runs cannot create duplicate `Invoice` rows (FR-007, NFR-003). |
| III. Deterministic Before AI | PASS | Gmail auth, search/discovery, scheduling, storage, and retry logic are all deterministic TypeScript. Claude is invoked only to extract/normalize fields from email body or attachment text and to assist vendor identification when deterministic rules are ambiguous. |
| IV. Security by Default | PASS | Gmail OAuth refresh token, `ANTHROPIC_API_KEY`, and DB credentials all sourced from env vars / Secret Manager (never committed); Gmail scope limited to `gmail.readonly` (least privilege — no write/modify scope needed since processing state lives in Postgres, not Gmail labels). |
| V. Configuration over Code | PASS | Vendors and their identification rules (sender domains, subject patterns) live in a `Vendor` config table seeded from a config file, not a hardcoded switch statement (FR-002, NFR-008). |
| VI. Complete Auditability | PASS | `ProcessingHistoryEntry` links every evaluation back to its `SourceEmail` and any resulting `Invoice`, with timestamps and error detail (NFR-005). |
| VII. Cloud Native Design | PASS | The service stays stateless; all durable state lives in Postgres + Cloud Storage, not on the Cloud Run instance's local disk (NFR-007). |
| VIII. Extensibility | PASS | Vendor config, a pluggable attachment-extraction strategy (PDF/CSV/body-text), and a `AttachmentStore` interface keep the design open to future providers/accounts without redesign. |
| IX. Type Safety & Validated Boundaries | PASS | Zod schemas validate Gmail API responses, Claude extraction output, and env vars before they enter business logic. |
| X. Test-First for Critical Business Logic | PASS (enforced in tasks) | Email processing, dedup, extraction, vendor classification, retry behavior, and config loading are all named as required-test areas; `/speckit-tasks` must generate test tasks ahead of/alongside their implementation tasks. |
| XI. Structured Observability | PASS | Pino logs each run's start/end time, duration, emails scanned, invoices processed, and failures (NFR-006), plus structured per-email failure detail. |
| XII. Simplicity & Minimal Surface (YAGNI) | PASS | No dashboards, alerts, forecasting, or anomaly detection are built; one new trigger endpoint plus a minimal read API for operator review (FR-015). |
| XIII. Automated Quality Gates | PASS | Existing ESLint/Prettier/`tsc --noEmit`/Vitest CI gates apply unchanged; Prisma schema changes are type-checked and migrated as part of the same CI run. |
| Technology & Deployment Constraints | PASS | Chosen stack (Node 20/TS/pnpm/PostgreSQL/Prisma/Gmail API/Cloud Run/Cloud Scheduler/Cloud Storage/Secret Manager/Pino/Vitest/GitHub Actions) matches the ratified list exactly — no deviation to justify. |

No violations identified — the Complexity Tracking table below is intentionally empty.

## Project Structure

### Documentation (this feature)

```text
specs/001-gmail-invoice-ingestion/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── http-api.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
prisma/
└── schema.prisma            # Vendor, SourceEmail, Invoice, Attachment, ProcessingHistoryEntry

src/
├── agent/
│   ├── invoiceMonitor.ts        # existing stub; repurposed as the ingestion run orchestrator
│   ├── invoiceMonitor.test.ts
│   ├── gmail/
│   │   ├── client.ts            # OAuth2 client + Gmail API list/get calls
│   │   ├── client.test.ts
│   │   ├── discovery.ts         # vendor-driven query building + candidate email discovery
│   │   └── discovery.test.ts
│   ├── extraction/
│   │   ├── pdfExtractor.ts
│   │   ├── csvExtractor.ts
│   │   ├── aiExtractor.ts       # Claude-based structured extraction from body/attachment text
│   │   └── *.test.ts
│   └── vendors/
│       ├── vendorConfig.ts      # config-driven vendor identification rules
│       └── vendorConfig.test.ts
├── storage/
│   ├── attachmentStore.ts       # AttachmentStore interface
│   ├── gcsAttachmentStore.ts    # Cloud Storage implementation (used in all deployed envs)
│   ├── localAttachmentStore.ts  # local-disk implementation (dev/test convenience only)
│   └── prisma.ts                # Prisma client singleton
├── config/
│   └── env.ts                   # extended with Gmail OAuth, DB, GCS, vendor-config vars
│   └── vendors.yaml                   
├── lib/
│   └── logger.ts                # existing
├── server.ts                    # existing; adds POST /tasks/ingest-invoices, GET /invoices, GET /invoices/:id, GET /processing-history
└── index.ts                     # existing
```

**Structure Decision**: Single project (Option 1), extending the existing `src/` tree in place —
this repo has no frontend/mobile component, so the web-application and mobile+API options do not
apply. Tests stay co-located as `*.test.ts` next to their source file, matching the existing
convention (`src/agent/invoiceMonitor.test.ts`), rather than introducing a separate top-level
`tests/` directory. A new top-level `prisma/` directory holds the schema/migrations, as is
standard for Prisma projects and keeps DB schema out of `src/`.

## Complexity Tracking

*No Constitution Check violations were identified — this table is intentionally empty.*

## Post-Design Constitution Re-check

Re-evaluated after Phase 1 design (`research.md`, `data-model.md`, `contracts/http-api.md`,
`quickstart.md`): no new violations were introduced. Notably, the storage design (research.md #7)
resolves the spec's "local storage" language in favor of Cloud Storage + Postgres specifically
*because* the constitution's Reliability First and Cloud Native Design principles require it —
design tightened compliance rather than trading it away. All gates from the pre-design Constitution
Check above still hold; Complexity Tracking remains empty.
