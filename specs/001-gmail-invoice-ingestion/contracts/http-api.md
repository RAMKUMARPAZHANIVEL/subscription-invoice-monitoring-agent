# HTTP API Contract: Gmail Invoice Ingestion & Extraction (Phase 1)

This service's external interface is its HTTP surface (extends the existing Express app in
`src/server.ts`). Existing `GET /healthz` is unchanged and not repeated here.

## POST /tasks/ingest-invoices

Trigger for one full discovery-and-extraction run (FR-010). Invoked by Cloud Scheduler once daily;
authenticated via Cloud Scheduler's OIDC token (same pattern as the existing
`POST /tasks/check-invoices`), not intended for direct operator use.

**Request**: no body required.

**Response `200`** — run completed (with or without failures):

```json
{
  "startedAt": "2026-07-10T06:00:00.000Z",
  "finishedAt": "2026-07-10T06:01:42.000Z",
  "durationMs": 102000,
  "emailsScanned": 14,
  "invoicesProcessed": 11,
  "failures": 1
}
```

**Response `500`** — the run itself could not complete (e.g., Gmail auth failure before any email
could be evaluated). Per-email failures are NOT reported here — they show up as `failures > 0` in
a `200` response and are individually queryable via `GET /processing-history`.

```json
{ "status": "error" }
```

## GET /invoices

Operator-facing list of extracted invoices (FR-015).

**Query parameters** (all optional):

| Param | Type | Meaning |
|---|---|---|
| `vendor` | string | Filter by vendor name |
| `subscriptionType` | `FIXED_MONTHLY` \| `USAGE_BASED` \| `PER_SEAT` | Filter |
| `from` / `to` | ISO date | Filter by `invoiceDate` range |
| `limit` | number | Default 50, max 200 |
| `cursor` | string | Opaque pagination cursor |

**Response `200`**:

```json
{
  "invoices": [
    {
      "id": "inv_abc123",
      "vendor": "GitHub",
      "amount": "49.00",
      "currency": "USD",
      "invoiceDate": "2026-07-01",
      "billingPeriodStart": "2026-06-01",
      "billingPeriodEnd": "2026-06-30",
      "subscriptionType": "PER_SEAT",
      "extractionConfidence": "HIGH",
      "attachmentCount": 1
    }
  ],
  "nextCursor": null
}
```

## GET /invoices/:id

Single invoice detail, including its processing history (FR-015, NFR-005).

**Response `200`**:

```json
{
  "id": "inv_abc123",
  "vendor": "GitHub",
  "amount": "49.00",
  "currency": "USD",
  "invoiceDate": "2026-07-01",
  "billingPeriodStart": "2026-06-01",
  "billingPeriodEnd": "2026-06-30",
  "subscriptionType": "PER_SEAT",
  "lineItems": [{ "description": "5 seats", "amount": "49.00" }],
  "extractionConfidence": "HIGH",
  "sourceEmail": {
    "gmailMessageId": "18f2a...",
    "sender": "billing@github.com",
    "subject": "Your GitHub receipt",
    "receivedAt": "2026-07-01T08:00:00.000Z"
  },
  "attachments": [
    { "id": "att_1", "filename": "receipt.pdf", "mimeType": "application/pdf" }
  ],
  "processingHistory": [
    { "outcome": "PROCESSED", "attemptNumber": 1, "evaluatedAt": "2026-07-10T06:00:12.000Z" }
  ]
}
```

**Response `404`** — no invoice with that ID.

## GET /processing-history

Operator-facing view for triaging failures without reading raw logs (FR-008, FR-009, SC-005).

**Query parameters** (all optional): `outcome` (`PROCESSED` \| `FAILED` \| `SKIPPED_NOT_INVOICE` \|
`RETRYING`), `from` / `to` (ISO date range on `evaluatedAt`), `limit`, `cursor`.

**Response `200`**:

```json
{
  "entries": [
    {
      "id": "ph_789",
      "sourceEmail": { "gmailMessageId": "18f2b...", "sender": "billing@unknownvendor.com", "subject": "Invoice #492" },
      "outcome": "FAILED",
      "attemptNumber": 3,
      "errorReason": "PDF text extraction returned empty content (likely a scanned image)",
      "evaluatedAt": "2026-07-10T06:00:45.000Z"
    }
  ],
  "nextCursor": null
}
```

## Error format

All non-2xx JSON responses share the shape `{ "status": "error", "message"?: string }`, consistent
with the existing `POST /tasks/check-invoices` error handling in `src/server.ts`.
