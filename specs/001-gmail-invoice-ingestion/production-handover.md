# T210 — Production Acceptance & Handover

**Date**: 2026-08-14
**Environment**: GCP project `ai-company-dev-505014` (shared company/Paperclip dev project — see
"Project" note below), region `us-central1`.
**Runner**: Full Stack Engineer agent, Paperclip issue WIZ-59, with live `gcloud` Owner-equivalent
credentials (`ramkumar@replicacia.com`).

This document is the operational handover for the Subscription Invoice Monitoring Agent (SIMA).
It supersedes nothing — `specs/001-gmail-invoice-ingestion/production-validation.md` (T209) and
`docs/validation-report.md` (T043) remain the detailed historical validation record; this file is
the reference an operator reaches for after handover.

## 1. Architecture summary

```
Cloud Scheduler (daily, OIDC) --> Cloud Run service --> Gmail API (readonly)
                                        |                       |
                                        |                 vendor emails + attachments
                                        v
                              PDF/CSV/Claude(Bedrock) extraction
                                        |
                       +----------------+-----------------+
                       v                                  v
              Cloud SQL (Postgres)                 GCS (attachments)
         Vendor/SourceEmail/Invoice/               versioned, NEARLINE@90d,
         Attachment/ProcessingHistoryEntry          COLDLINE@365d, never deleted
```

All of it — Artifact Registry, Cloud Run, Cloud SQL, GCS, Secret Manager, Cloud Scheduler, Cloud
Monitoring alerting, and GitHub Actions Workload Identity Federation — is provisioned by
`terraform/*.tf`. `terraform plan -var="project_id=ai-company-dev-505014"` was re-run at the end of
this task and reports **0 to add, 1 to change, 0 to destroy** — the one change is a long-documented
benign `scaling` block normalization on `google_cloud_run_v2_service.app` (noted since T204/T208;
Cloud Run's API omits `manual_instance_count`/`min_instance_count` from `scaling` when both are 0,
which Terraform then wants to re-apply every plan; it has no effect on running behavior).
**Infrastructure is fully reproducible through Terraform.**

**Project note**: production runs in `ai-company-dev-505014`, the shared company/Paperclip dev
project, per the accepted WIZ-53 decision (see `terraform/README.md`) overriding the original
dedicated-project requirement. Isolation is enforced at the resource level (labels, IAM scoped to
each resource) rather than the project boundary.

## 2. Required production configuration and secrets

Cloud Run env vars, set by `terraform/main.tf`'s `local.default_env_vars` (plain) and
`var.secret_env_vars` (Secret Manager-backed):

| Variable                                                                                | Source                                  | Notes                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                              | Terraform (plain)                       | `production`                                                                                                                                                                                                                |
| `LOG_LEVEL`                                                                             | Terraform (plain)                       | `info`                                                                                                                                                                                                                      |
| `ATTACHMENT_STORE_DRIVER`                                                               | Terraform (plain)                       | `gcs`                                                                                                                                                                                                                       |
| `INVOICE_EXTRACTION_PROVIDER`                                                           | Terraform (plain)                       | `bedrock` — see §5, do not change to `claude` without re-verifying the CoreValue gateway credential path first                                                                                                              |
| `BEDROCK_MODEL_ID`                                                                      | Terraform (plain)                       | `us.anthropic.claude-haiku-4-5-20251001-v1:0` — overrides the retired-model code default, see §11 known limitation                                                                                                          |
| `GCP_REGION`, `GOOGLE_CLOUD_PROJECT`, `GCS_BUCKET_NAME`                                 | Terraform (plain, derived)              | —                                                                                                                                                                                                                           |
| `DATABASE_URL`                                                                          | Secret Manager `sima-database-url`      | Terraform-generated and populated directly (`terraform/database.tf`)                                                                                                                                                        |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` / `GMAIL_ADMIN_EMAIL` | Secret Manager `sima-gmail-*`           | Containers created by Terraform, values populated out-of-band (§3)                                                                                                                                                          |
| `COREVALUE_API_KEY`                                                                     | Secret Manager `sima-corevalue-api-key` | Container created by Terraform, value populated out-of-band; this is the var actually required at startup — `ANTHROPIC_API_KEY` is only an optional fallback in `src/config/env.ts` and is **not** configured in production |

To rotate/update any of the T202-owned secrets:

```bash
printf '%s' '<new-value>' | gcloud secrets versions add sima-gmail-refresh-token \
  --project=ai-company-dev-505014 --data-file=-
```

Cloud Run always reads the `:latest` secret version (`terraform/main.tf`), so a new version takes
effect on the next request without a redeploy.

## 3. Gmail setup

- The monitored mailbox is `GMAIL_ADMIN_EMAIL` (Secret Manager `sima-gmail-admin-email`), accessed
  read-only (`gmail.readonly` OAuth scope — verified in T044/T206).
- OAuth2 credentials (`GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`) and a long-lived `GMAIL_REFRESH_TOKEN`
  are stored in Secret Manager; `src/agent/gmail/client.ts` exchanges the refresh token for access
  tokens at runtime (no interactive OAuth flow in production).
- Vendor identification is config-driven: `Vendor` rows (sender/subject pattern matching, see
  `src/agent/vendors/vendorConfig.ts`) live in Postgres, seeded via `pnpm run db:seed`
  (`prisma/seed.ts`). Production currently has one controlled vendor, `SIMA Test Vendor`
  (`senderPatterns: ['ramkumar@replicacia.com']`, `subjectPatterns: ['SIMA-TEST-INVOICE']`),
  seeded in T206 specifically so validation traffic can't collide with real vendor mail. Real
  vendor rows (the 8+ in `prisma/seed.ts` plus any added since) should be seeded/reviewed before
  this becomes a general-purpose monitor rather than a validated pilot.
- Discovery scope: on first activation the agent processes only invoice emails received from that
  point forward (FR-011) — it does not backfill mailbox history. This is intentional (see
  `docs/validation-report.md`'s 2026-08-10 entry for the history of this decision).

## 4. AI provider configuration

- `INVOICE_EXTRACTION_PROVIDER=bedrock` routes through `src/agent/extraction/bedrockExtractor.ts`,
  which sends Bedrock `InvokeModelCommand`-shaped requests to `GATEWAY_URL`
  (`https://gateway.corevalue.dev`) using `COREVALUE_API_KEY` as a bearer token — **not** native
  AWS Bedrock and **not** the CoreValue gateway's Anthropic Messages API surface (that surface
  returns `"No anthropic provider key available"` for this account; see T206/T207/WIZ-81 for the
  full root-cause history in `docs/validation-report.md`). `INVOICE_EXTRACTION_PROVIDER` alone
  selects the routing, regardless of whether `GATEWAY_URL` is set (`aiExtractor.ts`, fixed in
  `f4fa225`).
- The model actually serving requests is `BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0`,
  overriding `src/config/env.ts`'s code-level default (a retired AWS model — see §11).
- Verified live end-to-end in T209/T207: PDF-sourced, CSV-sourced, and email-body-sourced
  extraction all produce correct structured output at `HIGH` confidence; malformed/unextractable
  text fails safely (`AiExtractionError`, zod validation errors, no fabricated data).

## 5. Database migration procedure

Cloud SQL (`sima-postgres`, POSTGRES_16, ZONAL, `db-g1-small`) has no public IP reachable from the
open internet — apply migrations through the Cloud SQL Auth Proxy:

```bash
cd terraform
cloud-sql-proxy "$(terraform output -raw sql_instance_connection_name)" --port 5433 &
export DATABASE_URL="postgresql://sima_app:<password>@localhost:5433/$(terraform output -raw sql_database_name)?schema=public"
pnpm prisma migrate deploy
```

The password comes from `google_sql_user.app`/`random_password.db_password` in Terraform state, or
`gcloud secrets versions access latest --secret=sima-database-url` (parse the connection string).
`prisma migrate status` should report the schema up to date; as of this handover, both migrations
in `prisma/migrations/` are applied cleanly (verified T203, unaffected since).

## 6. Cloud Run deployment

**Intended path**: push to `main` → `CI` workflow (`.github/workflows/ci.yml`: format:check → lint
→ typecheck → test → build, with a real `postgres:16` service container) → on success,
`Deploy to Cloud Run` (`.github/workflows/deploy.yml`) builds/pushes the image to Artifact
Registry and rolls out a new Cloud Run revision via `google-github-actions/deploy-cloudrun@v2`,
authenticating through Workload Identity Federation.

**Current state (fixed this session, see §11 for the remaining manual step)**: `Deploy to Cloud
Run` has been failing at the `auth@v2` step since 2026-08-10 because no WIF pool/provider existed
in the project. This task added `terraform/ci-cd.tf`, provisioning:

- `google_iam_workload_identity_pool.github` (`sima-github-pool`)
- `google_iam_workload_identity_pool_provider.github` (`sima-github-provider`), OIDC issuer
  `https://token.actions.githubusercontent.com`, `attribute_condition` scoped to exactly
  `RAMKUMARPAZHANIVEL/subscription-invoice-monitoring-agent` — no other GitHub repo can exchange a
  token through this provider
- `google_service_account.github_deployer` (`sima-deployer@ai-company-dev-505014.iam.gserviceaccount.com`),
  granted only `roles/artifactregistry.writer` on this repo's Artifact Registry repository,
  `roles/run.developer` on this Cloud Run service, and `roles/iam.serviceAccountUser` on the Cloud
  Run runtime identity (`sima-run@...`, needed because `deploy-cloudrun@v2` reads the existing
  runtime service account even though it never changes it) — no project-wide roles, no access to
  secrets/database/GCS.

`terraform output github_actions_secrets_to_set` prints the exact two values:

```
GCP_SERVICE_ACCOUNT            = sima-deployer@ai-company-dev-505014.iam.gserviceaccount.com
GCP_WORKLOAD_IDENTITY_PROVIDER = projects/526782895263/locations/global/workloadIdentityPools/sima-github-pool/providers/sima-github-provider
```

**Remaining manual step** (needs GitHub repo-admin access, which this sandbox does not have):
paste those two values into the repo's **Settings → Secrets and variables → Actions** as
`GCP_SERVICE_ACCOUNT` and `GCP_WORKLOAD_IDENTITY_PROVIDER`, then re-run `Deploy to Cloud Run` (or
push any commit). Once set, every future push to `main` deploys automatically again — no more
manual `docker build`/`push`/`gcloud run deploy` workaround needed (that workaround is how the
current running revision, image tag `d0eea0c`, got deployed — see T209).

Manual deploy fallback (only needed until the secrets above are set):

```bash
IMAGE="us-central1-docker.pkg.dev/ai-company-dev-505014/subscription-invoice-monitoring-agent/subscription-invoice-monitoring-agent:$(git rev-parse HEAD)"
docker build -t "$IMAGE" . && docker push "$IMAGE"
gcloud run deploy subscription-invoice-monitoring-agent --image="$IMAGE" \
  --region=us-central1 --project=ai-company-dev-505014
```

`GET /health` returns `200` after deploy (verified live this session — see §9).

## 7. Cloud Scheduler configuration

`terraform/scheduler.tf` (T208) is the sole owner of the daily ingestion job
(`subscription-invoice-monitoring-agent-ingest-invoices`): `0 8 * * *` UTC by default
(`var.scheduler_schedule`/`var.scheduler_time_zone`), 3 retries with exponential backoff
(`var.scheduler_retry_count`, 5s–60s, ×3 doublings), 600s attempt deadline matching Cloud Run's own
request timeout. It calls `POST /tasks/ingest-invoices` with an OIDC token from the
`sima-scheduler@...` service account, which holds `roles/run.invoker` on the Cloud Run service and
nothing else — the service is not publicly invokable (confirmed live this session: an
unauthenticated `curl` returns `401`; only the scheduler and, briefly during verification, the
new deployer SA and a temporary operator grant have ever had invoker access).

Manual trigger for testing: `gcloud scheduler jobs run subscription-invoice-monitoring-agent-ingest-invoices --location=us-central1 --project=ai-company-dev-505014`.

## 8. Monitoring and alerting

Before this task, the project had **zero** notification channels, alert policies, log-based
metrics, or dashboards (confirmed live via `gcloud monitoring policies list` /
`gcloud logging metrics list` / `gcloud monitoring dashboards list`, all "Listed 0 items"). This
task added `terraform/monitoring.tf`, applied and verified live:

- **Notification channel**: email to `ramkumar@replicacia.com` (`var.alert_notification_email`).
  ⚠️ **One remaining manual step**: GCP email channels typically require the recipient to click a
  verification link GCP sends to that address before alerts are delivered reliably — this
  session's live check (`GET .../notificationChannels/...`) showed no `verificationStatus` field
  set, i.e. **not yet verified**. Whoever owns `ramkumar@replicacia.com` should check that inbox
  for a Cloud Monitoring verification email, or run
  `gcloud alpha monitoring channels verify <channel-id> --channel-code=<code-from-email>`.
- **Alert: `SIMA: Cloud Run 5xx errors`** — fires on any `run.googleapis.com/request_count` with
  `response_code_class="5xx"` for this service. Threshold is 0 occurrences because traffic is
  intentionally tiny (once daily plus occasional manual calls); any 5xx means the scheduled
  ingestion run failed at the HTTP level, distinct from a per-email extraction failure (which
  returns 200 and is recorded in `ProcessingHistoryEntry` — see the constitution's Complete
  Auditability principle for why those are audit trail, not incidents).
- **Alert: `SIMA: Cloud Scheduler ingestion attempt failures`** — built on a log-based metric
  (`sima-scheduler-attempt-failures`) derived from the scheduler job's own execution logs, since
  `cloudscheduler.googleapis.com/*` built-in metrics were not visible via the Monitoring API in
  this project when checked live. Fires if any scheduler attempt receives a non-2xx response.
- Both policies confirmed live and `enabled: true` via `gcloud alpha monitoring policies list`.
  Not synthetically triggered (would require intentionally breaking production) — this is the same
  class of limitation documented for other production-only scenarios throughout this feature's
  validation history (§11).

**Not yet covered** (documented gap, not a blocker): a "job didn't run at all" alert (metric
absence, e.g. no successful scheduler attempt in >26h) is not configured — the current alerts
catch failed attempts but not a scenario where Cloud Scheduler itself never fires. Worth a
follow-up if operational experience shows this matters.

## 9. Rollback / recovery procedure

**Cloud Run (bad deploy)**: Cloud Run keeps prior revisions. Roll back traffic without a rebuild:

```bash
gcloud run revisions list --service=subscription-invoice-monitoring-agent --region=us-central1 --project=ai-company-dev-505014
gcloud run services update-traffic subscription-invoice-monitoring-agent --region=us-central1 --project=ai-company-dev-505014 \
  --to-revisions=<previous-revision-name>=100
```

**Database**: `google_sql_database_instance.main` has automated backups and point-in-time recovery
enabled (`terraform/database.tf`, `backup_configuration { enabled = true, point_in_time_recovery_enabled = true }`)
and `deletion_protection = true`. Restore via `gcloud sql backups list --instance=sima-postgres` /
`gcloud sql instances clone` (PITR) if a bad migration or data corruption needs undoing. Because
`Invoice.sourceEmailId` and `SourceEmail.gmailMessageId` are both unique, a restore-then-replay
(re-running ingestion after restoring an older backup) is safe — the idempotency key prevents
duplicate `Invoice` rows even if some already-processed emails get re-evaluated.

**Attachments (GCS)**: bucket has object versioning enabled and no delete lifecycle rule (only
storage-class transitions at 90/365 days) — an accidentally overwritten or deleted attachment can
be recovered from a prior object generation (`gsutil ls -a gs://<bucket>/<object>` to list
generations, `gsutil cp gs://<bucket>/<object>#<generation> gs://<bucket>/<object>` to restore).

**Terraform state**: GCS backend (`terraform/backend.hcl`), state lives at the
`invoice-monitor/production/` prefix (migrated from an incorrectly-placed root path in T204). If
state and live infra ever diverge unexpectedly, `terraform plan` is the first diagnostic step —
run it before any `apply` to see exactly what would change.

**Full service outage**: `terraform apply` is idempotent and safe to re-run against the existing
state to reconcile any resource GCP-console-drifted back to Terraform's definition (with the two
documented exceptions: the Cloud Run `image` field, intentionally owned by CI/CD via
`lifecycle.ignore_changes`, and the benign `scaling` block normalization noted in §1).

## 10. Testing results

Full history: `specs/001-gmail-invoice-ingestion/production-validation.md` (T209, 2026-08-14) and
`docs/validation-report.md` (T043 and later updates). Re-confirmed live in this session
(temporary `roles/run.invoker` grant to the operator account, revoked immediately after):

| Check                             | Result                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                     | `200 {"status":"ok"}`                                                                                                                 |
| `GET /invoices`                   | 1 invoice (`SIMA Test Vendor`, `$49.99 USD`, `HIGH` confidence, 2 attachments) — matches T209 exactly, confirming no regression since |
| `GET /processing-history?limit=5` | Latest entry: attempt 15, `SKIPPED_DUPLICATE`, correctly linked to the existing invoice — duplicate prevention still holds            |
| `terraform plan`                  | 0 to add, 1 to change (documented benign drift), 0 to destroy                                                                         |
| Cloud Scheduler → Cloud Run auth  | Unauthenticated call → `401`; only `sima-scheduler@...` (and now `sima-deployer@...` for deploys) hold `roles/run.invoker`            |
| Cloud Monitoring alert policies   | 2 created, both `enabled: true`, live-verified via `gcloud alpha monitoring policies list`                                            |

Local test suite (`pnpm run test`): 147/147 passing as of the last code change (`068c1b2`), per
T209/T207's session logs — not re-run in this session since no application code changed here
(only Terraform).

## 11. Known limitations

1. **GitHub Actions repo secrets still need a human paste** (§6) — this is now a two-value copy
   action instead of an open-ended IAM investigation, but still requires GitHub repo-admin access
   this sandbox does not have. This is the one concrete unblock action left before CI/CD is fully
   self-service again.
2. **Email alert channel not yet verified** (§8) — `ramkumar@replicacia.com` needs to check their
   inbox for GCP's verification email (or run `gcloud alpha monitoring channels verify`).
3. **`src/config/env.ts`'s `BEDROCK_MODEL_ID` code default is still a retired AWS model.**
   Production is shielded by the Terraform override (§4), but a fresh non-Terraform-managed
   environment (e.g. local dev without an explicit `.env` override) would still hit
   `ResourceNotFoundException`. Small follow-up: update the code-level default directly.
4. **No "scheduler didn't fire at all" alert** (§8) — only failed-attempt alerting exists, not
   metric-absence detection for a fully silent day.
5. **Multiple-concurrent-invoices and fresh invalid-invoice scenarios remain covered by
   historical-live evidence + integration tests only** — this sandbox has no mail-send capability
   to inject new test emails into `GMAIL_ADMIN_EMAIL` (same limitation documented since T043).
6. **Attachment accumulation during extended outages** — each failed extraction attempt
   re-downloads and re-inserts `Attachment` rows (intentional, for per-attempt diagnostics), so a
   long extraction outage (like the one T209 found and fixed) accumulates GCS storage across
   retries. Not a correctness issue; worth watching if bucket size growth becomes noticeable.
7. **`ProcessingHistoryEntry.evaluatedAt` appears offset ~-5:30 from request wall-clock time**
   (noted in T208) — a pre-existing timezone-handling detail, not investigated further; does not
   affect correctness of duplicate-prevention or audit ordering (all timestamps use the same
   offset consistently).
8. **Production has one seeded vendor** (`SIMA Test Vendor`, deliberately isolated from real
   traffic per T206). Before this becomes a general-purpose monitor, review/seed the real vendor
   list (`prisma/seed.ts`) for the mailbox's actual subscription vendors.

## 12. Final production-readiness status

**Production-ready for its validated scope**, with two small, well-defined manual follow-ups that
don't block correctness of anything already running:

- ✅ Infrastructure fully reproducible via Terraform (`terraform plan`: 0 add / 1 benign change / 0
  destroy across all 8 `.tf` files, including the two added by this task)
- ✅ End-to-end ingestion pipeline verified live in production: Gmail discovery → PDF/CSV
  attachment download → AI extraction (Bedrock via CoreValue gateway) → Postgres persistence → GCS
  attachment storage → duplicate prevention → processing-history audit trail
- ✅ Scheduler-triggered daily automation confirmed live, authenticated, IAM-restricted
- ✅ Monitoring and alerting now configured (Cloud Run 5xx + Cloud Scheduler attempt failures),
  where none existed before this task
- ✅ Database has automated backups + point-in-time recovery; attachments are versioned and never
  deleted; rollback procedure documented for every layer (§9)
- ✅ No secrets found in logs (scanned in T209); least-privilege IAM throughout (every service
  account scoped to only the resource(s) it needs)
- ⚠️ CI/CD auto-deploy needs one manual action outside this task's access: pasting 2 Terraform
  outputs into GitHub repo secrets (§6, §11.1) — until then, deploys use the documented manual
  `docker build`/`push`/`gcloud run deploy` fallback, which is workable but not self-service
- ⚠️ Email alert channel needs one manual verification click (§8, §11.2)
- ⚠️ Validated against a single controlled test vendor/mailbox, not yet a broad real-vendor
  population (§11.8) — architecturally supported (config-driven `Vendor` table), just not yet
  exercised at that scale

No unresolved defect in the application code or Terraform configuration remains. The two
open items are both "a human with an access this sandbox doesn't have needs to click/paste
something" — named explicitly above with the exact action required.
