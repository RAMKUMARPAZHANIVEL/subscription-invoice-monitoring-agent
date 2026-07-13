# Subscription Invoice Monitoring Agent

An AI agent that monitors subscription invoices for anomalies (unexpected price changes,
duplicate charges, missed renewals, etc.), deployed as an HTTP service on GCP Cloud Run.

## Stack

- TypeScript / Node.js 20
- pnpm
- Express (HTTP surface for Cloud Run health checks and task triggers)
- ESLint + Prettier
- Husky + lint-staged (pre-commit checks)
- Vitest
- Docker (multi-stage build)
- GitHub Actions (CI + Cloud Run deploy)

## Project structure

```
src/
  agent/         Agent logic (invoice checks, anomaly detection)
  config/        Environment/config loading and validation
  lib/           Shared utilities (logging, etc.)
  server.ts      Express app (routes)
  index.ts       Process entry point
```

## Getting started

```bash
pnpm install
cp .env.example .env
pnpm run dev
```

## Scripts

| Script               | Purpose                           |
| -------------------- | --------------------------------- |
| `pnpm run dev`       | Run the server with hot reload    |
| `pnpm run build`     | Compile TypeScript to `dist/`     |
| `pnpm run start`     | Run the compiled server           |
| `pnpm run lint`      | Lint the codebase                 |
| `pnpm run format`    | Format the codebase with Prettier |
| `pnpm run typecheck` | Type-check without emitting       |
| `pnpm run test`      | Run the test suite once           |

## Testing

`pnpm run test` runs Vitest, which includes integration tests that hit a real PostgreSQL
database via Prisma (no ORM mocking). `src/config/env.ts` loads `.env` at import time
(`import 'dotenv/config'`), so `DATABASE_URL` for `pnpm run test` comes from the same `.env`
file used for `pnpm run dev` — there's no separate test-only env loading mechanism.

1. Start a disposable local PostgreSQL instance, e.g. via Docker:

   ```bash
   docker run --name subscription-invoice-monitoring-agent-db \
     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=subscription_invoice_test \
     -p 5432:5432 -d postgres:16
   ```

   (A native local PostgreSQL install works too — a container is just the easiest way to get a
   disposable instance.)

2. Point `DATABASE_URL` in `.env` at that database, using a dedicated database/schema so test
   runs never touch dev or production data:

   ```
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/subscription_invoice_test?schema=public
   ```

3. Apply the Prisma schema to it:

   ```bash
   pnpm prisma migrate deploy
   ```

4. Run the tests:

   ```bash
   pnpm run test
   ```

Integration tests read/write against this database directly, so re-run step 3 after pulling
schema changes, and use `pnpm prisma migrate reset` if you need to wipe it back to a clean state.

## Docker

```bash
docker build -t subscription-invoice-monitoring-agent .
docker run -p 8080:8080 --env-file .env subscription-invoice-monitoring-agent
```

## Deployment

`.github/workflows/deploy.yml` builds the Docker image, pushes it to Artifact Registry, and
deploys it to Cloud Run after CI passes on `main`. It authenticates via Workload Identity
Federation and expects the following to be configured in the repository:

- Secrets: `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT`
- Variables: `GCP_PROJECT_ID`, `GCP_REGION`

## Endpoints

- `GET /healthz` — liveness/readiness check
- `POST /tasks/check-invoices` — trigger a single invoice monitoring pass
