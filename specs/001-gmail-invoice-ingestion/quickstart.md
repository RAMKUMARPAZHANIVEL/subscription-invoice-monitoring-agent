# Quickstart: Gmail Invoice Ingestion & Extraction (Phase 1)

Validation guide for proving the feature works end-to-end once implemented. See
`data-model.md` for entity details and `contracts/http-api.md` for the exact request/response
shapes referenced below.

## Prerequisites

- Node.js >=20, pnpm (existing repo requirement)
- A local PostgreSQL instance (or a disposable test database) reachable via `DATABASE_URL`
- A Gmail OAuth2 refresh token for the admin account under test (research.md #1), plus its client
  ID/secret, set via env vars
- An `ANTHROPIC_API_KEY` with access to the Claude model used for extraction
- For local runs only: `ATTACHMENT_STORE_DRIVER=local` to use `LocalAttachmentStore` instead of
  GCS (research.md #7); omit this in any deployed environment

```bash
pnpm install
cp .env.example .env   # fill in DATABASE_URL, Gmail OAuth vars, ANTHROPIC_API_KEY
pnpm prisma migrate deploy
```

## Seed a vendor for testing

Insert at least one `Vendor` row (e.g., GitHub) with a `senderPatterns` entry that matches a real
or fixture invoice email sender, per the `Vendor` shape in `data-model.md`. Vendors are
configuration, not code (Principle V), so this can be a Prisma seed script or a direct insert —
implementation decides the exact mechanism during `/speckit-tasks`.

## Scenario 1: End-to-end discovery and extraction (validates User Story 1)

1. Ensure the admin mailbox has at least one unread/recent invoice email from a seeded vendor.
2. Run the ingestion pass:
   ```bash
   pnpm run dev &
   curl -X POST http://localhost:8080/tasks/ingest-invoices
   ```
3. **Expected**: The response matches the `POST /tasks/ingest-invoices` `200` shape in
   `contracts/http-api.md`, with `invoicesProcessed >= 1`.
4. Verify the record:
   ```bash
   curl http://localhost:8080/invoices
   ```
   **Expected**: The new invoice appears with `vendor`, `amount`, `currency`, and `invoiceDate`
   populated (FR-004), and `attachmentCount >= 1` if the source email had an attachment.

## Scenario 2: Duplicate prevention (validates User Story 2)

1. Immediately re-run the same trigger:
   ```bash
   curl -X POST http://localhost:8080/tasks/ingest-invoices
   ```
2. **Expected**: `invoicesProcessed` for this second run does not include the email from
   Scenario 1 again; `GET /invoices` still shows exactly one record for that source email
   (SC-003). Confirm via `GET /processing-history` that the email now has multiple
   `ProcessingHistoryEntry` rows (one per run) but the `Invoice` table has no duplicate.

## Scenario 3: Failure visibility (validates User Story 3)

1. Seed or send a fixture "invoice-like" email that will fail extraction (e.g., a PDF attachment
   with no extractable text layer, simulating a scanned image).
2. Run the trigger again and inspect:
   ```bash
   curl "http://localhost:8080/processing-history?outcome=FAILED"
   ```
3. **Expected**: An entry exists with a populated `errorReason` (SC-005) and a link back to the
   source email — without the whole run reporting a `500` (per-email isolation, NFR-001).

## Scenario 4: Config-driven vendor addition (validates FR-002/NFR-008)

1. Add a new `Vendor` row (no code change) for a vendor not previously configured.
2. Re-run the trigger against a fixture email from that vendor's sender address.
3. **Expected**: The email is discovered and processed without any deployment — confirming vendor
   identification is genuinely configuration-driven.

## Cleanup

```bash
pnpm prisma migrate reset   # local/test database only
```
