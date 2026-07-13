# Data Model: Gmail Invoice Ingestion & Extraction (Phase 1)

Entities correspond to the Key Entities in `spec.md`. Types are expressed as Prisma/PostgreSQL
conventions since that is the ratified persistence layer (see `research.md` #6).

## Vendor

Configuration-driven definition of a subscription provider the agent recognizes (FR-002, NFR-008).

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid, PK) | |
| `name` | `String`, unique | e.g., "GitHub", "AWS" |
| `senderPatterns` | `String[]` | Sender addresses/domains used to match candidate emails (e.g., `billing@github.com`, `@aws.amazon.com`) |
| `subjectPatterns` | `String[]`, optional | Optional subject-line substrings/regex to narrow matches |
| `defaultSubscriptionType` | `Enum(SubscriptionType)`, optional | Hint used when extraction can't determine it from the email itself |
| `enabled` | `Boolean`, default `true` | Disabling a vendor stops discovery without deleting history |
| `createdAt` / `updatedAt` | `DateTime` | |

**Validation rules**: `senderPatterns` MUST be non-empty for an enabled vendor. Adding/editing a
vendor is a configuration change (seed data or an admin-managed table), never a code change
(Principle V).

## SourceEmail

The originating Gmail message for a candidate invoice (FR-006, NFR-003, NFR-005).

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid, PK) | |
| `gmailMessageId` | `String`, **unique** | Gmail's immutable message ID — the idempotency key (research.md #9) |
| `vendorId` | `String`, FK → `Vendor.id`, optional | Null if the email matched no configured vendor at scan time |
| `sender` | `String` | |
| `subject` | `String` | |
| `receivedAt` | `DateTime` | |
| `bodyTextExcerpt` | `String`, optional | Truncated body text kept for diagnostics, not full storage |
| `createdAt` | `DateTime` | When this row was first created (i.e., first evaluation) |

**Validation rules**: `gmailMessageId` uniqueness is enforced at the DB level — this is the
mechanism that guarantees FR-007 (no duplicate processing) even under concurrent/retried runs.

## Attachment

A file downloaded from a `SourceEmail` (FR-003, FR-006).

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid, PK) | |
| `sourceEmailId` | `String`, FK → `SourceEmail.id` | |
| `invoiceId` | `String`, FK → `Invoice.id`, optional | Set once linked to an extracted invoice |
| `filename` | `String` | Original attachment filename |
| `mimeType` | `String` | e.g., `application/pdf`, `text/csv` |
| `storageRef` | `String` | Opaque reference resolved by the active `AttachmentStore` (GCS object path in deployed envs) |
| `sizeBytes` | `Int` | |
| `createdAt` | `DateTime` | |

**Validation rules**: `mimeType` MUST be one of the supported types (PDF, CSV at minimum, per
FR-003); unsupported types are recorded as a failed `ProcessingHistoryEntry`, not silently dropped.

## Invoice

The structured record extracted from a vendor billing email (FR-004, FR-006).

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid, PK) | |
| `sourceEmailId` | `String`, FK → `SourceEmail.id`, unique | One invoice per source email |
| `vendorId` | `String`, FK → `Vendor.id` | |
| `amount` | `Decimal` | |
| `currency` | `String` (ISO 4217 code) | |
| `invoiceDate` | `DateTime` | |
| `billingPeriodStart` | `DateTime`, optional | |
| `billingPeriodEnd` | `DateTime`, optional | |
| `subscriptionType` | `Enum(SubscriptionType)`, optional | `FIXED_MONTHLY`, `USAGE_BASED`, `PER_SEAT` |
| `lineItems` | `Json`, optional | Best-effort itemization when present in the source (spec Assumptions) |
| `extractionConfidence` | `Enum(ExtractionConfidence)` | `HIGH`, `LOW` — surfaces best-effort/uncertain extractions for operator review (SC-002) |
| `createdAt` / `updatedAt` | `DateTime` | |

**Validation rules**: `amount`, `currency`, `invoiceDate`, and `vendorId` are required — an
extraction that cannot populate these is a failed `ProcessingHistoryEntry`, not a partial
`Invoice` row (keeps FR-004's "at minimum" fields a hard floor, not a soft one).

## ProcessingHistoryEntry

One evaluation of one email (FR-008, FR-009, NFR-001, NFR-005).

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid, PK) | |
| `sourceEmailId` | `String`, FK → `SourceEmail.id` | |
| `invoiceId` | `String`, FK → `Invoice.id`, optional | Set only when `outcome = PROCESSED` |
| `outcome` | `Enum(ProcessingOutcome)` | `PROCESSED`, `FAILED`, `SKIPPED_NOT_INVOICE`, `RETRYING` |
| `attemptNumber` | `Int`, default `1` | Increments on each retry of the same `sourceEmailId` |
| `errorReason` | `String`, optional | Required when `outcome = FAILED` |
| `evaluatedAt` | `DateTime` | |

**State transitions**:

```text
(new email discovered)
        │
        ▼
   RETRYING/pending ──(recoverable error, retries remain)──► RETRYING (attemptNumber += 1)
        │                                                        │
        │(success)                                     (retries exhausted OR
        ▼                                                non-recoverable error)
   PROCESSED                                                     │
                                                                  ▼
                                                                FAILED

   (email matched no vendor / classified as non-invoice) ──► SKIPPED_NOT_INVOICE
```

A `SourceEmail` may have multiple `ProcessingHistoryEntry` rows (one per attempt) but at most one
`Invoice`. This is what makes the audit trail complete (Principle VI) — the full retry history is
visible, not just the final outcome.

## RunSummary (in-memory / log record, not persisted as its own table)

Produced at the end of every scheduled run (FR-014, NFR-006) and emitted as a structured log line;
derivable at query time from `ProcessingHistoryEntry` rows within the run's time window, so no
separate table is required for Phase 1.

| Field | Type |
|---|---|
| `startedAt` | `DateTime` |
| `finishedAt` | `DateTime` |
| `durationMs` | `Int` |
| `emailsScanned` | `Int` |
| `invoicesProcessed` | `Int` |
| `failures` | `Int` |

## Enums

- `SubscriptionType`: `FIXED_MONTHLY` \| `USAGE_BASED` \| `PER_SEAT`
- `ExtractionConfidence`: `HIGH` \| `LOW`
- `ProcessingOutcome`: `PROCESSED` \| `FAILED` \| `SKIPPED_NOT_INVOICE` \| `RETRYING`

## Relationships

```text
Vendor 1───* SourceEmail 1───1 Invoice 1───* Attachment
                  │                              ▲
                  │                              │
                  └──────* ProcessingHistoryEntry ┘ (via invoiceId, optional)
                  1───* ProcessingHistoryEntry (via sourceEmailId)
```
