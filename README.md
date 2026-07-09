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
