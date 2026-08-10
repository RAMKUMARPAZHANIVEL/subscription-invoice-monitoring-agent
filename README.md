# SIMA — Subscription Invoice Monitoring Agent

SIMA is an AI agent that watches a single Gmail mailbox for subscription/vendor invoice emails,
extracts structured invoice data from them (amount, currency, billing period, line items), and
persists the result so it can be queried over HTTP instead of read by hand. It runs as an Express
HTTP service on GCP Cloud Run and is triggered once a day by Cloud Scheduler.

## What SIMA does

1. **Discover** — search the configured admin Gmail mailbox for messages from known vendors
   (sender/subject patterns are data, not code — see [Vendor configuration](#vendor-configuration)).
2. **Extract** — pull invoice text from a supported attachment (PDF/CSV) or, if there's no
   attachment, from the email body itself.
3. **Understand** — hand that text to an AI model (Claude, directly or via AWS Bedrock) with a
   strict tool-call schema, so it returns structured fields (amount, currency, dates, subscription
   type, line items) instead of free text. The model's output is Zod-validated before anything is
   persisted — an extraction that can't be validated fails loud rather than saving guessed data.
4. **Persist & dedupe** — every evaluated email becomes a `SourceEmail` row (upserted by Gmail
   message ID, which is what makes re-runs safe), successful extractions become an `Invoice` row,
   and every attempt — success, skip, or failure — writes a `ProcessingHistoryEntry` so nothing is
   silently dropped.
5. **Serve** — the same Express app exposes read endpoints (`GET /invoices`,
   `GET /processing-history`) so an operator can see what happened without reading raw logs.

## Architecture

```
Cloud Scheduler (daily, 08:00 UTC)
        │  POST /tasks/ingest-invoices  (OIDC-authenticated)
        ▼
┌───────────────────────────── Cloud Run service ─────────────────────────────┐
│  src/server.ts (Express)                                                    │
│    GET  /healthz                                                            │
│    POST /tasks/ingest-invoices  ──► src/agent/invoiceMonitor.ts             │
│    GET  /invoices, /invoices/:id, /processing-history  (read from Postgres) │
│                                                                              │
│  src/agent/invoiceMonitor.ts  (runInvoiceCheck — the orchestrator)          │
│    1. src/agent/vendors/vendorConfig.ts   load enabled Vendor rows          │
│    2. src/agent/gmail/discovery.ts        build a Gmail search query        │
│    3. src/agent/gmail/client.ts           list/get messages + attachments   │
│    4. src/agent/extraction/pdfExtractor.ts / csvExtractor.ts                │
│                                            deterministic text extraction    │
│    5. src/agent/extraction/aiExtractor.ts / bedrockExtractor.ts             │
│                                            AI structured extraction         │
│    6. src/storage/{gcs,local}AttachmentStore.ts   attachment bytes          │
│    7. src/storage/prisma.ts               Vendor/SourceEmail/Invoice/       │
│                                            Attachment/ProcessingHistoryEntry │
└───────────────────────────────────────────────────────────────────────────┘
        │                               │                          │
        ▼                               ▼                          ▼
   Gmail API                    Cloud SQL for Postgres      Cloud Storage bucket
 (OAuth2, gmail.readonly)         (via DATABASE_URL)        (invoice attachments)
```

### Data flow

```
Gmail mailbox
  → discovery (vendor sender/subject patterns + date floor, deterministic — no AI judgment)
  → attachment download (Gmail API) → AttachmentStore (GCS or local disk)
  → text extraction: supported attachment (PDF/CSV, deterministic parser) → email body fallback
  → AI extraction: Claude tool-use call → Zod-validated structured fields
  → persistence: SourceEmail upsert (idempotency key) → Invoice create → Attachment link
                 → ProcessingHistoryEntry (always written, one per attempt)
```

Every email evaluated in a run ends in exactly one of these `ProcessingHistoryEntry` outcomes:
`PROCESSED`, `FAILED`, `SKIPPED_NOT_INVOICE` (no vendor matched), `SKIPPED_DUPLICATE` (already has
an `Invoice`), or `RETRYING` (a recoverable failure is being retried within the same run). A
failure on one email never aborts the rest of the run — each candidate is processed in its own
try/catch.

### Vendor configuration

Vendors are rows in the `Vendor` table (`name`, `senderPatterns`, `subjectPatterns`,
`defaultSubscriptionType`, `enabled`), not code. Adding a new vendor to monitor means inserting a
row (e.g. via `pnpm db:studio` or editing `prisma/seed.ts` and re-running `pnpm db:seed`) — no
deployment required. Discovery only searches for vendors with `enabled = true`; matching is a
case-insensitive substring check against sender (required) and subject (optional — omit
`subjectPatterns` to match on sender alone). See [Seeding vendors](#seeding-vendors) for the
default vendor list.

### Supported providers

| Category               | Options                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AI extraction provider | `claude` (default) or `bedrock`, set via `INVOICE_EXTRACTION_PROVIDER`. **Both routes call the CoreValue AI gateway** (`GATEWAY_URL`, default `https://gateway.corevalue.dev`) using `COREVALUE_API_KEY` — `bedrock` uses the AWS Bedrock Runtime `InvokeModelCommand` shape against that gateway endpoint rather than talking to AWS directly with native AWS credentials. `ANTHROPIC_API_KEY` is only used as a fallback Anthropic SDK credential if `COREVALUE_API_KEY` is unset. |
| Attachment storage     | `gcs` (default, `GcsAttachmentStore`) or `local` (`LocalAttachmentStore`), set via `ATTACHMENT_STORE_DRIVER`. `local` is for development/testing only — Cloud Run's local disk is ephemeral, so every deployed environment must use `gcs`.                                                                                                                                                                                                                                           |
| Extractable content    | PDF and CSV attachments (`src/agent/extraction/pdfExtractor.ts`, `csvExtractor.ts`); if no supported attachment is present, the plain-text (or HTML, tags stripped) email body is used instead.                                                                                                                                                                                                                                                                                      |

## Project structure

```
src/
  agent/
    invoiceMonitor.ts        Ingestion run orchestrator (entry point: runInvoiceCheck)
    gmail/client.ts          OAuth2 Gmail API client (messages.list/get, attachments.get)
    gmail/discovery.ts       Vendor-driven Gmail search query building + candidate discovery
    gmail/attachments.ts     Attachment download helpers
    extraction/              pdfExtractor, csvExtractor, aiExtractor (Claude), bedrockExtractor
    vendors/vendorConfig.ts  Config-driven vendor loading + sender/subject matching
  storage/
    attachmentStore.ts       AttachmentStore interface (save/retrieve/delete/getMetadata)
    gcsAttachmentStore.ts    Cloud Storage implementation (used in all deployed environments)
    localAttachmentStore.ts  Local-disk implementation (dev/test convenience only)
    prisma.ts                Prisma client singleton
  config/env.ts               Zod-validated env schema — the only way config enters the app
  lib/logger.ts               Pino structured logger
  server.ts                   Express app + routes
  index.ts                    Process entry point (startServer())
  generated/prisma/           Generated Prisma client — do not hand-edit
prisma/schema.prisma           Vendor, SourceEmail, Invoice, Attachment, ProcessingHistoryEntry
specs/001-gmail-invoice-ingestion/  Spec-kit feature docs (spec, plan, data model, HTTP contract)
```

## Stack

- TypeScript / Node.js 20, pnpm
- Express (HTTP surface for Cloud Run health checks and task triggers)
- PostgreSQL via Prisma ORM
- Gmail API (`googleapis` + `google-auth-library`), Anthropic SDK, AWS Bedrock Runtime SDK
- Google Cloud Storage (attachments)
- ESLint + Prettier, Husky + lint-staged (pre-commit checks), Vitest
- Docker (multi-stage build), GitHub Actions (CI + Cloud Run deploy)

## Installation

Requires Node.js >=20 and [pnpm](https://pnpm.io/) (`packageManager: pnpm@9.15.0` in
`package.json`; `corepack enable` will pick this up automatically).

```bash
pnpm install
cp .env.example .env  # then fill in the values — see Environment Variables below
pnpm db:migrate       # apply the Prisma schema to your local Postgres database
pnpm db:seed          # populate the Vendor table with the default vendor list
pnpm run dev           # start the server with hot reload (tsx watch), default port 8080
```

`pnpm db:migrate` (`prisma migrate dev`) both applies existing migrations and lets you create a new
one if you've changed `prisma/schema.prisma`; it also regenerates the Prisma client into
`src/generated/prisma/`. For applying existing migrations only (CI, a fresh test database), use
`pnpm prisma migrate deploy` instead — see [Testing](#testing).

You need a running PostgreSQL instance before either command; a disposable one via Docker:

```bash
docker run --name sima-db \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=subscription_invoice_dev \
  -p 5432:5432 -d postgres:16
```

## Scripts

| Script               | Purpose                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `pnpm run dev`       | Run the server with hot reload                                         |
| `pnpm run build`     | Compile TypeScript to `dist/`                                          |
| `pnpm run start`     | Run the compiled server (`node dist/index.js`)                         |
| `pnpm run lint`      | Lint the codebase (`lint:fix` to auto-fix)                             |
| `pnpm run format`    | Format the codebase with Prettier (`format:check` to verify only)      |
| `pnpm run typecheck` | Type-check without emitting                                            |
| `pnpm run test`      | Run the Vitest suite once (`test:watch` to watch)                      |
| `pnpm db:migrate`    | Apply Prisma migrations to the local database (`prisma migrate dev`)   |
| `pnpm db:generate`   | Regenerate the Prisma client into `src/generated/prisma/`              |
| `pnpm db:reset`      | Drop and recreate the local database, reapply migrations, then re-seed |
| `pnpm db:seed`       | Populate/update the `Vendor` table from `prisma/seed.ts`               |
| `pnpm db:studio`     | Open Prisma Studio to browse/edit local data                           |

### Seeding vendors

`prisma/seed.ts` upserts the default vendor list (`Claude`, `GitHub`, `AWS`, `Jira`, `Tiny.cloud`,
`Coderabbit`, `Greptile`, `CoreValue`) into the `Vendor` table — each entry sets `name`, `enabled`,
`senderPatterns`, and `subjectPatterns` (see [Vendor configuration](#vendor-configuration)).
`pnpm db:seed` runs `prisma db seed`, which invokes the command configured in `prisma.config.ts`
(`migrations.seed: 'tsx prisma/seed.ts'`); it's also run automatically at the end of
`pnpm db:reset`. Upserting by `name` (which is `@unique` on `Vendor`) makes the script safe to
re-run — it updates existing rows rather than creating duplicates.

## Environment Variables

`src/config/env.ts` parses `process.env` through a Zod schema at process startup
(`import 'dotenv/config'` loads `.env` first) — the app **will not start** if a required variable
is missing or fails validation. Copy `.env.example` to `.env` and fill in every variable below that
has no default.

### Runtime

| Variable    | Required | Default       | Meaning                                                            |
| ----------- | -------- | ------------- | ------------------------------------------------------------------ |
| `NODE_ENV`  | no       | `development` | `development` \| `test` \| `production`                            |
| `PORT`      | no       | `8080`        | HTTP port the Express server listens on                            |
| `LOG_LEVEL` | no       | `info`        | Pino log level: `fatal`\|`error`\|`warn`\|`info`\|`debug`\|`trace` |

### Database

| Variable       | Required | Example                                                                                     | Meaning                                                           |
| -------------- | -------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `DATABASE_URL` | **yes**  | `postgresql://app_user:your_password@localhost:5433/subscription_invoice_dev?schema=public` | Postgres connection string Prisma uses for every query/migration. |

### GCP project (optional locally, used by GCS + informational)

| Variable               | Required | Example         | Meaning                                                                                        |
| ---------------------- | -------- | --------------- | ---------------------------------------------------------------------------------------------- |
| `GOOGLE_CLOUD_PROJECT` | no       | `sima-prod-123` | GCP project ID passed to the `@google-cloud/storage` client; omit locally to use ADC defaults. |
| `GCP_REGION`           | no       | `us-central1`   | Region used by CI/deploy tooling (Cloud Run, Artifact Registry, Cloud Scheduler).              |

### AI extraction provider

| Variable                      | Required | Default                                     | Meaning                                                                                                                                      |
| ----------------------------- | -------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVOICE_EXTRACTION_PROVIDER` | no       | `claude`                                    | `claude` or `bedrock` — selects the extraction code path (both call the CoreValue gateway; see [Supported providers](#supported-providers)). |
| `COREVALUE_API_KEY`           | **yes**  | —                                           | Bearer token for the CoreValue AI gateway. Required by both providers — the app fails to start without it.                                   |
| `GATEWAY_URL`                 | no       | `https://gateway.corevalue.dev`             | CoreValue gateway base URL. Override for a staging/alternate gateway.                                                                        |
| `ANTHROPIC_API_KEY`           | no       | —                                           | Fallback Anthropic SDK key, only used if `COREVALUE_API_KEY` is unset when calling the `claude` code path directly.                          |
| `AWS_REGION`                  | no       | `us-east-1`                                 | Region reported to the Bedrock Runtime SDK client (requests still go to `GATEWAY_URL`, not AWS directly).                                    |
| `BEDROCK_MODEL_ID`            | no       | `anthropic.claude-3-5-sonnet-20241022-v2:0` | Bedrock model ID sent in `InvokeModelCommand` when `INVOICE_EXTRACTION_PROVIDER=bedrock`.                                                    |

### Gmail

Domain-wide-delegated OAuth2 "installed app" credentials for a single admin mailbox (see
[research.md #1](specs/001-gmail-invoice-ingestion/research.md) for how the refresh token is
obtained). The client always reads the mailbox that issued the refresh token (Gmail API `userId:
'me'`); there is no per-request mailbox selection.

| Variable              | Required | Example                              | Meaning                                                                                                                                                    |
| --------------------- | -------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GMAIL_CLIENT_ID`     | **yes**  | `123-abc.apps.googleusercontent.com` | OAuth2 client ID for the Google Cloud project's OAuth consent screen.                                                                                      |
| `GMAIL_CLIENT_SECRET` | **yes**  | `GOCSPX-...`                         | OAuth2 client secret paired with `GMAIL_CLIENT_ID`.                                                                                                        |
| `GMAIL_REFRESH_TOKEN` | **yes**  | `1//0g...`                           | Long-lived refresh token for the admin mailbox, scoped to `gmail.readonly`.                                                                                |
| `GMAIL_ADMIN_EMAIL`   | **yes**  | `admin@example.com`                  | The mailbox address the refresh token belongs to — validated at startup for operator clarity; the Gmail API calls themselves don't take it as a parameter. |

### Attachment storage

| Variable                     | Required | Default             | Meaning                                                                                |
| ---------------------------- | -------- | ------------------- | -------------------------------------------------------------------------------------- |
| `GCS_BUCKET_NAME`            | **yes**  | —                   | Cloud Storage bucket used by `GcsAttachmentStore` to persist invoice attachment bytes. |
| `ATTACHMENT_STORE_DRIVER`    | no       | `gcs`               | `gcs` or `local`. Use `local` for development so you don't need a real bucket.         |
| `ATTACHMENT_STORE_LOCAL_DIR` | no       | `.data/attachments` | Directory used by `LocalAttachmentStore` when `ATTACHMENT_STORE_DRIVER=local`.         |

`GCS_BUCKET_NAME` is required by the schema even when `ATTACHMENT_STORE_DRIVER=local` (the schema
doesn't conditionally relax it) — set it to any placeholder value for local-only development.

### Legacy / not yet wired to the ingestion pipeline

| Variable                      | Required | Default       | Meaning                                                                                                                                                                                                                          |
| ----------------------------- | -------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVOICE_CHECK_INTERVAL_CRON` | no       | `0 */6 * * *` | Present in the env schema for the original `POST /tasks/check-invoices` scaffold; the actual daily schedule is owned by the Cloud Scheduler job created at deploy time (see [Deployment](#deployment)), not by this cron string. |
| `INVOICE_ALERT_WEBHOOK_URL`   | no       | —             | Reserved for a future anomaly-alert webhook; not currently called anywhere in the pipeline.                                                                                                                                      |

## API Documentation

All non-2xx JSON responses share the shape `{ "status": "error", "message"?: string }` unless noted
otherwise.

### `GET /healthz`

Liveness/readiness check.

**Request**: none.

**Response `200`**:

```json
{ "status": "ok" }
```

### `POST /tasks/ingest-invoices`

Runs one full discovery → extraction → persistence pass over the admin mailbox. This is what Cloud
Scheduler calls once daily (OIDC-authenticated); it can also be called manually for local testing.

**Request**: no body.

**Response `200`** — the run completed (per-email failures are reported via `failures`, not as an
HTTP error):

```json
{
  "runId": "3d1f9c2a-6b7e-4c1a-9e2f-5a0b8c1d2e3f",
  "startedAt": "2026-07-10T06:00:00.000Z",
  "finishedAt": "2026-07-10T06:01:42.000Z",
  "durationMs": 102000,
  "emailsScanned": 14,
  "invoicesProcessed": 11,
  "emailsSkipped": 2,
  "duplicateEmails": 1,
  "retryCount": 3,
  "failures": 1
}
```

**Response `500`** — the run itself couldn't complete (e.g. no vendors configured to build a valid
query, or an unrecoverable error before any email could be evaluated):

```json
{ "status": "error" }
```

There is also a legacy `POST /tasks/check-invoices` endpoint that runs the identical
`runInvoiceCheck()` orchestrator but returns the full internal run summary (including
`invoiceEmailsFound`) rather than the trimmed shape above; new integrations should use
`/tasks/ingest-invoices`.

### `GET /invoices`

Paginated, operator-facing list of extracted invoices.

**Query parameters** (all optional):

| Param              | Type                                              | Meaning                                   |
| ------------------ | ------------------------------------------------- | ----------------------------------------- |
| `vendor`           | string                                            | Exact vendor name filter                  |
| `subscriptionType` | `FIXED_MONTHLY` \| `USAGE_BASED` \| `PER_SEAT`    | Filter by subscription type               |
| `from` / `to`      | ISO date/date-time (parsed with `Date`)           | Filter on `invoiceDate` (inclusive range) |
| `limit`            | integer, 1-200                                    | Default `50`                              |
| `cursor`           | string (an invoice `id` from a previous response) | Opaque pagination cursor                  |

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

**Response `400`** — invalid query parameters: `{ "status": "error", "message": "Invalid query parameters" }`

**Response `500`** — unexpected server error: `{ "status": "error" }`

### `GET /invoices/:id`

Single invoice detail, including its full processing history and source email.

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
  "attachments": [{ "id": "att_1", "filename": "receipt.pdf", "mimeType": "application/pdf" }],
  "processingHistory": [
    { "outcome": "PROCESSED", "attemptNumber": 1, "evaluatedAt": "2026-07-10T06:00:12.000Z" }
  ]
}
```

**Response `404`** — no invoice with that ID: `{ "status": "error", "message": "Invoice not found" }`

**Response `500`** — unexpected server error: `{ "status": "error" }`

### `GET /processing-history`

Paginated, operator-facing view of every evaluated email — used to triage failures without reading
raw logs.

**Query parameters** (all optional):

| Param         | Type                                                                                  | Meaning                                   |
| ------------- | ------------------------------------------------------------------------------------- | ----------------------------------------- |
| `outcome`     | `PROCESSED` \| `FAILED` \| `SKIPPED_NOT_INVOICE` \| `SKIPPED_DUPLICATE` \| `RETRYING` | Filter by outcome                         |
| `from` / `to` | ISO date/date-time                                                                    | Filter on `evaluatedAt` (inclusive range) |
| `limit`       | integer, 1-200                                                                        | Default `50`                              |
| `cursor`      | string (a history entry `id` from a previous response)                                | Opaque pagination cursor                  |

**Response `200`**:

```json
{
  "entries": [
    {
      "id": "ph_789",
      "sourceEmail": {
        "gmailMessageId": "18f2b...",
        "sender": "billing@unknownvendor.com",
        "subject": "Invoice #492"
      },
      "outcome": "FAILED",
      "invoiceId": null,
      "attemptNumber": 3,
      "errorReason": "PDF text extraction returned empty content (likely a scanned image)",
      "evaluatedAt": "2026-07-10T06:00:45.000Z"
    }
  ],
  "nextCursor": null
}
```

`invoiceId` is populated only for `PROCESSED` and `SKIPPED_DUPLICATE` outcomes; `null` otherwise.

**Response `400` / `500`**: same shapes as `GET /invoices`.

## Testing

```bash
pnpm test        # Vitest, single pass
pnpm run lint     # ESLint
pnpm run build    # tsc -> dist/
pnpm run typecheck # tsc --noEmit, no output
```

`pnpm test` is **not just unit tests** — it includes integration tests that hit a real PostgreSQL
database via Prisma (no ORM mocking; the Gmail client is tested against a faked `gmail_v1.Gmail`
object instead of a live account). Because `src/config/env.ts` loads `.env` at import time, the
same `DATABASE_URL` used for `pnpm run dev` is also what `pnpm test` connects to — there is no
separate test-env loading mechanism.

1. Start a disposable local Postgres instance if you don't already have one from
   [Installation](#installation):

   ```bash
   docker run --name sima-test-db \
     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=subscription_invoice_test \
     -p 5432:5432 -d postgres:16
   ```

2. Point `DATABASE_URL` in `.env` at a **dedicated test database/schema** so test runs never touch
   dev or production data:

   ```
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/subscription_invoice_test?schema=public
   ```

3. Apply the schema, then run the tests:

   ```bash
   pnpm prisma migrate deploy
   pnpm test
   ```

Re-run step 3's migration after pulling schema changes; use `pnpm prisma migrate reset` to wipe the
test database back to a clean state.

CI (`.github/workflows/ci.yml`) runs, in order: `format:check` → `lint` → `typecheck` → `test` →
`build`, on every push/PR to `main`. Match that order when checking your own work locally.

## Docker

```bash
docker build -t sima .
docker run -p 8080:8080 --env-file .env sima
```

The multi-stage `Dockerfile` installs dependencies, runs `pnpm run build`, then copies only
production dependencies and `dist/` into a slim `node:20-slim` runtime image that runs as a
non-root `appuser` and listens on port `8080`.

## Deployment

The service is deployed to **GCP Cloud Run**, backed by **Cloud SQL for PostgreSQL**
(`DATABASE_URL`) and a **Cloud Storage** bucket (`GCS_BUCKET_NAME`) for attachments, triggered
daily by a **Cloud Scheduler** job. `.github/workflows/deploy.yml` runs automatically after CI
succeeds on `main` (or via manual `workflow_dispatch`):

1. Authenticates to GCP via Workload Identity Federation (no long-lived service account key).
2. Builds the Docker image and pushes it to Artifact Registry.
3. Deploys the image to Cloud Run (`google-github-actions/deploy-cloudrun`).
4. Grants the Cloud Scheduler service account `roles/run.invoker` on the deployed service.
5. Creates (or updates, if already present) a Cloud Scheduler job named
   `subscription-invoice-monitoring-agent-ingest-invoices` that calls
   `POST /tasks/ingest-invoices` daily at `08:00 UTC`, OIDC-authenticated as the scheduler service
   account, with up to 3 retry attempts and a 600s attempt deadline.

Required repository configuration for this workflow:

- **Secrets**: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`,
  `GCP_SCHEDULER_SERVICE_ACCOUNT`
- **Variables**: `GCP_PROJECT_ID`, `GCP_REGION`
- `GCP_SERVICE_ACCOUNT` (the deploy identity) needs `roles/run.admin`,
  `roles/iam.serviceAccountUser`, and `roles/cloudscheduler.admin`. `GCP_SCHEDULER_SERVICE_ACCOUNT`
  only needs to exist — the workflow grants it `roles/run.invoker` automatically.

### Secret Manager

Secret containers and the Cloud Run wiring to them are owned by Terraform, not manual `gcloud`
commands — `terraform/secrets.tf` (T202) creates the Secret Manager container for each application
secret and grants the Cloud Run runtime service account `roles/secretmanager.secretAccessor` on it;
`terraform/main.tf` wires each one onto the Cloud Run service by name (`var.secret_env_vars`).
`DATABASE_URL` (`sima-database-url`) is the one exception — its container is created by the Cloud
SQL setup in T203, not T202. Don't run `gcloud run services update --set-secrets`/`--set-env-vars`
by hand; it'll drift from what `terraform plan` expects on the next apply.

Terraform only creates the secret _containers_ — it never sets secret _values_, since those must
never live in source control or Terraform state as plain HCL. After `terraform apply`, populate
each one out-of-band:

```bash
printf '%s' "$GMAIL_CLIENT_ID" | gcloud secrets versions add sima-gmail-client-id --data-file=-
printf '%s' "$GMAIL_CLIENT_SECRET" | gcloud secrets versions add sima-gmail-client-secret --data-file=-
printf '%s' "$GMAIL_REFRESH_TOKEN" | gcloud secrets versions add sima-gmail-refresh-token --data-file=-
printf '%s' "$GMAIL_ADMIN_EMAIL" | gcloud secrets versions add sima-gmail-admin-email --data-file=-
printf '%s' "$COREVALUE_API_KEY" | gcloud secrets versions add sima-corevalue-api-key --data-file=-
```

Non-sensitive env vars (`NODE_ENV`, `LOG_LEVEL`, `ATTACHMENT_STORE_DRIVER`,
`INVOICE_EXTRACTION_PROVIDER`, `GCP_REGION`, `GOOGLE_CLOUD_PROJECT`, plus anything passed via
`var.plain_env_vars`) are likewise set by Terraform (`terraform/main.tf`), not `gcloud run services
update`. Cloud Run resolves an env-var-sourced secret (`version = "latest"` in the
`secret_key_ref`) once, at container start — it does not live-update an already-running instance.
Because this service scales to zero (`cloud_run_min_instances = 0`), the next cold start after
`gcloud secrets versions add` picks up the new value; adding or removing a secret _binding_ itself
still requires `terraform apply`.

### Prisma migrations

The deploy workflow does not run migrations automatically. Apply schema changes to the production
database before or as part of rolling out a release that depends on them:

```bash
DATABASE_URL="<production connection string>" pnpm prisma migrate deploy
```

Run this from CI (a dedicated step with access to the production `DATABASE_URL` secret) or from an
operator machine with network access to Cloud SQL (e.g. via the Cloud SQL Auth Proxy). Never use
`pnpm prisma migrate dev` or `pnpm prisma migrate reset` against production — `dev` can prompt to
reset on drift, and `reset` always wipes the database.

## Troubleshooting

**Gmail OAuth**

- `invalid_grant` / `Token has been expired or revoked` — `GMAIL_REFRESH_TOKEN` is stale or was
  revoked; re-run the OAuth "installed app" flow to mint a new refresh token and update the secret.
- `insufficientPermissions` / 403 from the Gmail API — the OAuth client's consent scope doesn't
  include `https://www.googleapis.com/auth/gmail.readonly`, or the token was minted for a different
  account than `GMAIL_ADMIN_EMAIL`.
- Nothing is discovered even though the mailbox has matching mail — check that a `Vendor` row
  exists with `enabled = true` and a `senderPatterns` entry that substring-matches the sender, and
  that the email's `receivedAt` is within the discovery lookback window
  (`resolveDiscoverySince` in `src/agent/invoiceMonitor.ts`).

**Prisma**

- `Environment variable not found: DATABASE_URL` — `.env` is missing or wasn't loaded; confirm
  you're running commands from the repo root so `dotenv/config` finds it.
- `P1001: Can't reach database server` — the Postgres instance isn't running or `DATABASE_URL`
  points at the wrong host/port (check `docker ps` if using the Docker one-liner above).
- Schema drift errors from `migrate dev` — someone changed `prisma/schema.prisma` without a
  migration, or the local database has out-of-band changes; for a disposable dev/test database,
  `pnpm prisma migrate reset` is usually the fastest fix.
- After pulling changes that touch `prisma/schema.prisma`, re-run `pnpm prisma migrate dev` (local)
  or `pnpm prisma migrate deploy` (test/CI) — the generated client in `src/generated/prisma/` is
  regenerated automatically as part of that command, not on `pnpm install`.

**Bedrock / CoreValue gateway credentials**

- Extraction fails immediately with `A Claude API key is required when using the Claude provider`
  — neither `COREVALUE_API_KEY` nor `ANTHROPIC_API_KEY` is set; since the env schema requires
  `COREVALUE_API_KEY`, this typically means it's set to an invalid/empty value rather than truly
  missing (the app wouldn't start at all with it unset).
- `INVOICE_EXTRACTION_PROVIDER=bedrock` still fails auth — remember this path also authenticates to
  `GATEWAY_URL` using `COREVALUE_API_KEY` as a bearer token, not native AWS credentials; `AWS_REGION`
  only affects what's reported to the SDK client, not which AWS account is billed.
- Repeated `AiExtractionError: ... failed validation after 3 attempts` — the model's tool-use output
  didn't match `ExtractedInvoiceSchema` even after retries; check the logged `errorReason` on the
  corresponding `ProcessingHistoryEntry` (`GET /processing-history?outcome=FAILED`) for the specific
  validation failure.

**Cloud Scheduler**

- The daily job never fires or logs a 403 — confirm `GCP_SCHEDULER_SERVICE_ACCOUNT` has
  `roles/run.invoker` on the Cloud Run service (the deploy workflow grants this automatically after
  every successful deploy; a manually-created job or account may be missing it).
- Job succeeds (200) but nothing changed — check the response body for `failures > 0` or an empty
  `invoicesProcessed`, then cross-reference `GET /processing-history` for the same time window
  rather than assuming the scheduler itself is broken.

**Database connection**

- Works locally but fails on Cloud Run — Cloud Run can't reach a `localhost`-style `DATABASE_URL`;
  production must use a Cloud SQL connection (Cloud SQL Auth Proxy / Unix socket connection string
  or the Cloud SQL connector), not a direct TCP host reachable only from your machine.
- Intermittent `P2034` (transaction write conflict) — already retried automatically up to 3 times
  by the ingestion orchestrator (`RETRYABLE_PRISMA_CODES` in `src/agent/invoiceMonitor.ts`); check
  `GET /processing-history?outcome=RETRYING` if it's happening more than occasionally.

## Spec-Driven Development

This repo follows the spec-kit workflow (`.specify/`, `specs/`). The active feature is
[`specs/001-gmail-invoice-ingestion/`](specs/001-gmail-invoice-ingestion/) (spec, plan, research,
data model, HTTP contract, task breakdown, and a scenario-based
[quickstart](specs/001-gmail-invoice-ingestion/quickstart.md)). See `CLAUDE.md` for the engineering
conventions and constitution this project is held to.
