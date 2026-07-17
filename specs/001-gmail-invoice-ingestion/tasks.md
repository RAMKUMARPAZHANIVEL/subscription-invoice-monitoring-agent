---
description: 'Task list for Gmail Invoice Ingestion & Extraction (Phase 1)'
---

# Tasks: Gmail Invoice Ingestion & Extraction (Phase 1)

**Input**: Design documents from `specs/001-gmail-invoice-ingestion/`

**Prerequisites**: plan.md, spec.md, data-model.md, contracts/http-api.md, research.md,
quickstart.md (all present)

**Tests**: Included. The constitution's Principle X (Test-First for Critical Business Logic)
mandates automated coverage for email processing, duplicate detection, invoice extraction, vendor
classification, retry behavior, and configuration loading — the exact scope of this feature — so
test tasks are generated ahead of/alongside their implementation tasks rather than being optional.

**Organization**: Tasks are grouped by user story (from spec.md) to enable independent
implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Every task includes an exact file path

## Path Conventions

Single project, extending the existing repo layout (see plan.md's Project Structure):
`src/agent/**`, `src/storage/**`, `src/config/env.ts`, `src/server.ts`, `prisma/schema.prisma`.
Tests are co-located as `*.test.ts` next to their source file, matching the existing
`src/agent/invoiceMonitor.test.ts` convention — there is no separate top-level `tests/` directory.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization for the new dependencies and configuration this feature needs

- [ ] T001 Add `googleapis`, `google-auth-library`, `@anthropic-ai/sdk`, `@google-cloud/storage`,
      `pdf-parse`, `csv-parse` to `dependencies` and `prisma`, `@prisma/client` to
      `devDependencies`/`dependencies` in `package.json`; run `pnpm install`
- [ ] T002 [P] Initialize Prisma in `prisma/schema.prisma` with the `postgresql` datasource (from
      `DATABASE_URL`) and the Prisma Client generator block
- [ ] T003 [P] Extend the env schema in `src/config/env.ts` with `DATABASE_URL`,
      `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_ADMIN_EMAIL`,
      `GCS_BUCKET_NAME`, `ATTACHMENT_STORE_DRIVER` (`local` \| `gcs`, default `gcs`), and make
      `ANTHROPIC_API_KEY` required (it already exists as optional)
- [ ] T004 [P] Add the new environment variables (with short comments) to `.env.example`
- [x] T005 [P] Document local/test PostgreSQL setup for Vitest integration tests (how
      `DATABASE_URL` is supplied for `pnpm run test`) in `README.md`

**Checkpoint**: Dependencies installed, configuration schema extended — ready for foundational work.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T006 Define the `Vendor`, `SourceEmail`, `Invoice`, `Attachment`, and
      `ProcessingHistoryEntry` models and the `SubscriptionType`, `ExtractionConfidence`,
      `ProcessingOutcome` enums in `prisma/schema.prisma`, per `data-model.md` (depends on T002)
- [x] T007 Generate and apply the initial migration with `pnpm prisma migrate dev` (depends on
      T006)
- [x] T008 [P] Create the Prisma client singleton in `src/storage/prisma.ts` (depends on T007)
- [x] T009 [P] Define the `AttachmentStore` interface in `src/storage/attachmentStore.ts`
- [x] T010 [P] Implement `GcsAttachmentStore` in `src/storage/gcsAttachmentStore.ts` (depends on
      T009)
- [x] T011 [P] Implement `LocalAttachmentStore` in `src/storage/localAttachmentStore.ts` (depends
      on T009)
- [ ] T012 [P] Unit tests for both `AttachmentStore` implementations in
      `src/storage/attachmentStore.test.ts` (depends on T010, T011)
- [ ] T013 Implement the Gmail OAuth2 client (token refresh, `messages.list`, `messages.get`,
      `attachments.get` wrappers) in `src/agent/gmail/client.ts` (depends on T003)
- [ ] T014 [P] Unit tests for the Gmail client against a fake HTTP layer in
      `src/agent/gmail/client.test.ts` (depends on T013)

**Checkpoint**: Foundation ready — user story implementation can now begin.

---

## Phase 3: User Story 1 - Automatic invoice discovery and extraction (Priority: P1) 🎯 MVP

**Goal**: The agent connects to Gmail, finds invoice emails from configured vendors, downloads
attachments, extracts structured invoice data, and stores it.

**Independent Test**: Seed one `Vendor` and ensure one matching invoice email exists in the
mailbox; call `POST /tasks/ingest-invoices`; confirm a structured `Invoice` (vendor, amount,
currency, invoice date) and its attachment appear via `GET /invoices` (quickstart Scenario 1).

### Tests for User Story 1

- [x] T015 [P] [US1] Unit tests for vendor sender/subject matching in
      `src/agent/vendors/vendorConfig.test.ts`
- [x] T016 [P] [US1] Unit tests for vendor-driven Gmail query building in
      `src/agent/gmail/discovery.test.ts`
- [x] T017 [P] [US1] Unit tests for PDF text extraction in
      `src/agent/extraction/pdfExtractor.test.ts`
- [x] T018 [P] [US1] Unit tests for CSV parsing in `src/agent/extraction/csvExtractor.test.ts`
- [ ] T019 [P] [US1] Unit tests for Claude extraction output validation, including a malformed/
      incomplete response, in `src/agent/extraction/aiExtractor.test.ts`
- [ ] T020 [US1] Integration test: ingesting one fixture invoice email (fake Gmail client + test
      database) produces a structured `Invoice` row with its `Attachment` linked, in
      `src/agent/invoiceMonitor.test.ts`

### Implementation for User Story 1

- [x] T021 [P] [US1] Implement the vendor config loader (read enabled `Vendor` rows) in
      `src/agent/vendors/vendorConfig.ts` (depends on T008)
- [x] T022 [US1] Implement vendor-driven Gmail query building and candidate email discovery in
      `src/agent/gmail/discovery.ts` (depends on T013, T021)
- [x] T023 [P] [US1] Implement PDF text extraction in `src/agent/extraction/pdfExtractor.ts`
- [x] T024 [P] [US1] Implement CSV parsing in `src/agent/extraction/csvExtractor.ts`
- [ ] T025 [US1] Implement Claude-based structured extraction (tool-use call with a Zod-validated
      response) in `src/agent/extraction/aiExtractor.ts` (depends on T023, T024)
- [ ] T026 [US1] Implement attachment download and storage via `AttachmentStore` in
      `src/agent/gmail/attachments.ts` (depends on T010, T011, T013)
- [ ] T027 [US1] Rewrite `runInvoiceCheck` as the ingestion orchestrator (discover → download →
      extract → persist `SourceEmail`/`Invoice`/`Attachment`) in `src/agent/invoiceMonitor.ts`
      (depends on T022, T025, T026, T008)
- [ ] T028 [US1] Add the `POST /tasks/ingest-invoices` route in `src/server.ts` (depends on T027)
- [ ] T029 [US1] Add `GET /invoices` and `GET /invoices/:id` routes per `contracts/http-api.md` in
      `src/server.ts` (depends on T027)

**Checkpoint**: User Story 1 is fully functional and independently testable (quickstart
Scenario 1) — this is the MVP.

---

## Phase 4: User Story 2 - Duplicate prevention & processing history (Priority: P2)

**Goal**: The same email is never processed into a duplicate invoice, and every evaluation is
recorded for audit.

**Independent Test**: Run ingestion twice against an unchanged mailbox; confirm the second run
creates zero new `Invoice` rows and `GET /processing-history` shows an entry for both attempts
(quickstart Scenario 2).

### Tests for User Story 2

- [ ] T030 [P] [US2] Integration test: re-running ingestion against an already-processed email
      creates no duplicate `Invoice`, in `src/agent/invoiceMonitor.test.ts`
- [ ] T031 [P] [US2] Unit test: upserting a `SourceEmail` by `gmailMessageId` never creates two
      rows for the same ID, in `src/storage/prisma.test.ts`

### Implementation for User Story 2

- [ ] T032 [US2] Implement `SourceEmail` upsert-by-`gmailMessageId` and a `ProcessingHistoryEntry`
      write for every evaluated email (processed / failed / skipped-as-not-an-invoice) in
      `src/agent/invoiceMonitor.ts` (depends on T027)
- [ ] T033 [US2] Add the `GET /processing-history` route per `contracts/http-api.md` in
      `src/server.ts` (depends on T032)

**Checkpoint**: User Stories 1 and 2 both work independently — duplicate-run safety and the audit
trail are verified.

---

## Phase 5: User Story 3 - Reliable daily automated run with failure visibility (Priority: P3)

**Goal**: The agent runs automatically every day; a failure on one email never blocks the rest of
the run, failed emails carry enough diagnostic detail to triage, and every run produces a summary.

**Independent Test**: Trigger a run that includes one intentionally-unparseable fixture email;
confirm the run still returns `200` with `failures >= 1`, the other emails in the batch still
process, and `GET /processing-history?outcome=FAILED` shows a populated `errorReason` (quickstart
Scenario 3).

### Tests for User Story 3

- [ ] T034 [P] [US3] Integration test: a failing email does not abort the rest of the run
      (per-email isolation), in `src/agent/invoiceMonitor.test.ts`
- [ ] T035 [P] [US3] Unit test: a recoverable error is retried up to the configured limit, then
      recorded as `FAILED` with an `errorReason`, in `src/agent/invoiceMonitor.test.ts`
- [ ] T036 [P] [US3] Unit test: the run summary (scanned/processed/failures/duration) is computed
      correctly for a mixed batch of outcomes, in `src/agent/invoiceMonitor.test.ts`

### Implementation for User Story 3

- [ ] T037 [US3] Add per-email try/catch isolation with attempt-count tracking and
      recoverable-error retry in `src/agent/invoiceMonitor.ts` (depends on T032)
- [ ] T038 [US3] Compute the `RunSummary` (start/end/duration/scanned/processed/failures) and
      return it from `POST /tasks/ingest-invoices` in `src/agent/invoiceMonitor.ts` and
      `src/server.ts` (depends on T037)
- [ ] T039 [US3] Emit structured Pino logs for the run summary and for each per-email failure in
      `src/agent/invoiceMonitor.ts` (depends on T038)
- [ ] T040 [US3] Add the daily Cloud Scheduler job (OIDC-authenticated call to
      `POST /tasks/ingest-invoices`) to the deployment pipeline in
      `.github/workflows/deploy.yml` (depends on T028)

**Checkpoint**: All user stories are independently functional — full daily automation with
failure visibility is in place.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T041 [P] Update `README.md` with the new endpoints, environment variables, and Prisma setup
      steps
- [ ] T042 [P] Add `db:migrate` and `db:seed` scripts (for `Vendor` seed data) to `package.json`
- [ ] T043 Run the `quickstart.md` validation scenarios end-to-end against a real or sandbox
      Gmail account and record the results
- [ ] T044 [P] Security review: confirm no secrets appear in logs (Pino redaction for tokens/keys)
      and the Gmail OAuth scope stays `gmail.readonly`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational only
- **User Story 2 (Phase 4)**: Depends on Foundational; builds on the write path US1 creates
  (T027) but adds no new foundational infrastructure
- **User Story 3 (Phase 5)**: Depends on Foundational; builds on the write path US2 extends
  (T032)
- **Polish (Phase 6)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: No dependency on other stories — the MVP
- **User Story 2 (P2)**: Extends the ingestion write path US1 builds (T027) — cannot be
  meaningfully tested until US1 exists, but adds no new foundational pieces of its own
- **User Story 3 (P3)**: Extends the per-email evaluation loop US2 builds (T032) — same relationship

Because each story's implementation tasks modify the same orchestrator file
(`src/agent/invoiceMonitor.ts`) that the prior story introduced, these three stories are best
delivered **sequentially in priority order** (P1 → P2 → P3) rather than in parallel across
developers, even though each is independently testable once its turn arrives.

### Within Each User Story

- Tests are written first and must fail before implementation
- Vendor/discovery/extraction pieces before the orchestrator that wires them together
- Orchestrator before the HTTP routes that expose it
- Story complete and checkpoint-verified before moving to the next priority

### Parallel Opportunities

- All Setup tasks marked [P] (T002-T005) can run in parallel after T001
- Within Foundational: T009-T011 (AttachmentStore + implementations) and T013-T014 (Gmail client)
  can proceed in parallel once T002/T003 land; T008 depends on T007
- Within US1: all five test tasks (T015-T019) can run in parallel; T023/T024 (PDF/CSV extractors)
  can run in parallel
- Within US2: T030 and T031 can run in parallel
- Within US3: T034, T035, T036 can run in parallel

---

## Parallel Example: User Story 1

```bash
# Launch all independent tests for User Story 1 together:
Task: "Unit tests for vendor sender/subject matching in src/agent/vendors/vendorConfig.test.ts"
Task: "Unit tests for vendor-driven Gmail query building in src/agent/gmail/discovery.test.ts"
Task: "Unit tests for PDF text extraction in src/agent/extraction/pdfExtractor.test.ts"
Task: "Unit tests for CSV parsing in src/agent/extraction/csvExtractor.test.ts"
Task: "Unit tests for Claude extraction output validation in src/agent/extraction/aiExtractor.test.ts"

# Launch the independent extractor implementations together:
Task: "Implement PDF text extraction in src/agent/extraction/pdfExtractor.ts"
Task: "Implement CSV parsing in src/agent/extraction/csvExtractor.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Run quickstart Scenario 1 independently
5. Deploy/demo if ready — this alone delivers the core "stop manually reading invoice emails" value

### Incremental Delivery

1. Setup + Foundational → foundation ready
2. Add User Story 1 → validate (quickstart Scenario 1) → deploy/demo (MVP!)
3. Add User Story 2 → validate (quickstart Scenario 2) → deploy/demo
4. Add User Story 3 → validate (quickstart Scenarios 3-4) → deploy/demo — full daily automation
5. Polish (Phase 6)

---

## Notes

- [P] tasks touch different files with no unmet dependency
- [Story] labels map every user-story-phase task back to spec.md's US1/US2/US3
- Commit after each task or logical group
- Stop at any checkpoint to validate a story independently before moving on
- Avoid: vague tasks, two tasks editing the same file marked [P] together, cross-story edits that
  break independence
