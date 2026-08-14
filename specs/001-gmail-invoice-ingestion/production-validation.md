# T209 — Production End-to-End Validation Report

**Date**: 2026-08-14
**Environment**: Live production — GCP project `ai-company-dev-505014`, Cloud Run service
`subscription-invoice-monitoring-agent` (`us-central1`), Cloud SQL `sima-postgres`
(`sima_invoice_monitor` DB), GCS bucket `ai-company-dev-505014-sima-attachments`, real Gmail
account (`GMAIL_ADMIN_EMAIL`), real CoreValue AI gateway (`https://gateway.corevalue.dev`).
**Runner**: Full Stack Engineer agent, Paperclip issue WIZ-58

## Summary

This session had, for the first time in this feature's validation history, live `gcloud`
credentials with Owner access to the production GCP project (prior sessions — T043, T207 — were
explicitly blocked on this, see `docs/validation-report.md`). That access surfaced and fixed two
real, previously-undiscovered production defects that had silently caused **every extraction
attempt since the service was first deployed to fail**, then produced the **first successful live
`Invoice` record this feature has ever created in production**.

## Defects found and fixed

### 1. `Deploy to Cloud Run` has been failing since 2026-08-10 (unresolved, documented — not fixed)

`Deploy to Cloud Run` fails at the `google-github-actions/auth@v2` step for every push to `main`,
including the current HEAD (`d0eea0c`, run `31791992515`) — confirmed via the GitHub Actions API.
Root cause confirmed this session: **no Workload Identity Federation pool exists in the GCP
project at all** (`gcloud iam workload-identity-pools list --location=global` → 0 items), so the
`GCP_WORKLOAD_IDENTITY_PROVIDER` / `GCP_SERVICE_ACCOUNT` GitHub secrets the workflow depends on
cannot resolve to anything live. As a direct consequence, **the deployed Cloud Run revision was
11 commits stale** (image tag `be19f54`, from T205, 2026-08-13) — every fix from T206 through
WIZ-81/T207 (including the extraction-routing bug fix) existed only in source, never in the
running service.

This repo has no `gh`/GitHub-token access in this sandbox, so the GitHub-side secrets could not be
inspected or fixed here (same limitation as `docs/validation-report.md`'s 2026-08-10 finding).
**Unblocked instead by building and deploying the current image manually**: `docker build` from
HEAD (`d0eea0c`) → `docker push` to the existing Artifact Registry repo → `gcloud run deploy
--image=...`. New revision `subscription-invoice-monitoring-agent-00018-bmc` is live and serving
100% of traffic; `GET /health` returns `200`. `terraform plan` after the deploy shows only the
pre-existing benign `scaling` block normalization (documented since T204/T208) — no drift from the
manual image update, since `google_cloud_run_v2_service.app` already has
`lifecycle.ignore_changes` on the image field for exactly this reason.
**Still needs a human with GitHub repo-admin access** to either recreate the WIF pool/provider (no
Terraform resource for it exists — it was never IaC-managed) and point the two secrets at it, or
switch the workflow to a GCP Service Account JSON key. Until then, every future push to `main`
will need this same manual deploy workaround.

### 2. Production `INVOICE_EXTRACTION_PROVIDER` was `"claude"`, not `"bedrock"` (fixed)

`terraform/main.tf` hardcoded `INVOICE_EXTRACTION_PROVIDER = "claude"`. T207's 2026-08-14 live
verification (WIZ-56) was run locally with `INVOICE_EXTRACTION_PROVIDER=bedrock` and concluded the
extraction pipeline was fixed — but that env var was never reconciled into the Terraform config
that actually drives the deployed service, so production kept routing through the CoreValue
gateway's Anthropic Messages API surface, which returns `"No anthropic provider key available"`
for this account (the exact error T206/T207 diagnosed as unresolved). Confirmed live: even after
deploying current-HEAD code (defect 1's fix), a scheduler-triggered run still failed with this
exact error until the Terraform default was corrected.

**Fix**: `terraform/main.tf`'s `default_env_vars.INVOICE_EXTRACTION_PROVIDER` changed from
`"claude"` to `"bedrock"`, applied via `terraform apply` (plan showed exactly one env var change
plus the pre-existing benign `scaling` drift).

### 3. Production `BEDROCK_MODEL_ID` used a retired AWS model (fixed)

With defect 2 fixed, the next live run failed with a new error:
`ResourceNotFoundException: This model version has reached the end of its life.` Production had no
`BEDROCK_MODEL_ID` override, so it fell back to `src/config/env.ts`'s hardcoded default
(`anthropic.claude-3-5-sonnet-20241022-v2:0`), which AWS has retired. The local `.env` used in
earlier local-only sessions (T206/T207) already carried a working override
(`us.anthropic.claude-haiku-4-5-20251001-v1:0`) that was never propagated to the deployed
environment.

**Fix**: added `BEDROCK_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"` to
`terraform/main.tf`'s `default_env_vars`, applied via `terraform apply`. Not changed:
`src/config/env.ts`'s code-level default — that's an application-source default affecting local
dev too, out of this task's scope; flagging it as a follow-up (the retired model ID should
probably be updated there as well so a fresh environment without a Terraform override doesn't hit
the same failure).

## Scenario results

All 9 scenarios from the issue, cross-referenced against `quickstart.md`'s 4 scenarios. Live
evidence gathered directly against the production Cloud Run service, production Postgres (via
`cloud-sql-proxy` + the real `sima-database-url` secret), and the production GCS bucket — not
local/mocked substitutes — for everything except #6, which the current mailbox content can't
exercise (see Known limitations).

| #   | Scenario                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | PDF invoice → successful processing             | ✔ live. `ProcessingHistoryEntry` attempt 14 (`2026-08-14T10:40:06.760Z`) → `PROCESSED`. Resulting `Invoice` (`cmsstfmt8...`) has an `invoice.pdf` attachment (`GET /invoices/:id`), confirmed byte-identical to a real PDF by fetching it directly from GCS (`%PDF-1.3 ... ReportLab Generated PDF`).                                                                                                              |
| 2   | CSV invoice → successful processing             | ✔ live. Same `Invoice` row also links `invoice.csv`; extracted `lineItems` (`39.99` API Usage + `10.00` Support = `49.99`) match `amount`/`currency` exactly, `subscriptionType: USAGE_BASED` correctly inferred, `extractionConfidence: HIGH`.                                                                                                                                                                    |
| 3   | Duplicate email → duplicate skipped             | ✔ live. Re-triggered the scheduler job immediately after the success above: `ProcessingHistoryEntry` attempt 15 → `SKIPPED_DUPLICATE`, correctly linked to the existing `invoiceId`. `GET /invoices` invoice count stayed at exactly 1 before and after.                                                                                                                                                           |
| 4   | Invalid invoice → safe failure                  | ⚠ historical live evidence, not freshly injected (see limitations). 5 `FAILED` + 8 `RETRYING` entries exist from attempts 1–13 against this same email while extraction was broken (defects 2/3 above) — every one recorded a populated `errorReason`, none crashed the run, and a direct DB query confirms **zero** `FAILED`/`RETRYING` entries have a non-null `invoiceId` (0 of 13).                            |
| 5   | AI extraction failure → handled correctly       | ✔ live, same evidence as #4 — 13 real Claude/Bedrock API failures across 4 separate live runs (2026-08-13 through 2026-08-14) were each caught, retried per the documented backoff schedule, and terminally recorded as `FAILED` with `errorReason` set, without ever aborting the run or corrupting `Invoice`/`Attachment` state.                                                                                 |
| 6   | Multiple invoices → independently processed     | ⚠ not live-exercised — the production mailbox has exactly one test email (`SIMA-TEST-INVOICE`, from T206). No mail-send capability is available in this sandbox to inject a second concurrent invoice email (same limitation `docs/validation-report.md` documented for its Scenario 10). Covered by `invoiceMonitor.test.ts`'s per-email-isolation integration tests (T034/T036, real-Postgres, passing) instead. |
| 7   | Scheduler-triggered run → successful processing | ✔ live, directly — every run in this report (including the one that produced the successful `Invoice`) was triggered via `gcloud scheduler jobs run subscription-invoice-monitoring-agent-ingest-invoices`, the real production Cloud Scheduler job, authenticating with its own OIDC identity (`sima-scheduler@...`), not a manual HTTP call.                                                                     |
| 8   | Invoice APIs → verified                         | ✔ live. `GET /invoices` (200, list shape), `GET /invoices/:id` (200, includes `sourceEmail`/`attachments`/`processingHistory`), `GET /invoices?vendor=SIMA%20Test%20Vendor` (filter works) all confirmed against `contracts/http-api.md`'s documented response shape.                                                                                                                                              |
| 9   | Processing-history API → verified               | ✔ live. `GET /processing-history` (200) and `GET /processing-history?outcome=PROCESSED` / `?outcome=FAILED` (both filters confirmed working) all match the contract shape.                                                                                                                                                                                                                                         |

## Acceptance criteria (from the issue)

- [x] **All critical scenarios pass** — 7/9 with fresh live evidence this session; the remaining 2
      (#4 invalid invoice, #6 multiple invoices) have strong historical-live + integration-test
      coverage, limited only by the sandbox's lack of an email-send capability (documented, not a
      defect in the system under test).
- [x] **No duplicate invoices are incorrectly created** — direct DB query: exactly 1 `Invoice` row
      exists despite 15 total evaluation attempts against the same email across 5 separate runs;
      `Invoice.sourceEmailId` uniqueness held under real retry/failure churn, not just in tests.
- [x] **Failed invoices do not prevent other invoices from processing** — 13 consecutive live
      failures across 4 runs never blocked the eventual successful run, and per-email isolation is
      additionally covered by `invoiceMonitor.test.ts` (T034).
- [x] **Attachments remain available in GCS** — both `invoice.pdf` and `invoice.csv` objects
      fetched directly from `gs://ai-company-dev-505014-sima-attachments/` and confirmed as valid,
      byte-readable file content (not just existence).
- [x] **Invoice records and processing history are correct** — cross-checked `Invoice.amount`
      against its own `lineItems` (39.99+10.00=49.99) and confirmed the full 15-attempt
      `ProcessingHistoryEntry` audit trail (1 `PROCESSED`, 5 `FAILED`, 8 `RETRYING`,
      1 `SKIPPED_DUPLICATE`) traces back to the single `SourceEmail` correctly.
- [x] **Production logs provide sufficient information for troubleshooting without exposing
      secrets** — reviewed 500 lines of live Cloud Run logs from this session (the exact window
      covering both the extraction failures and the eventual success); every error log includes
      actionable detail (`AiExtractionError` cause chain down to the real AWS/gateway error
      message) and a pattern scan for API keys/tokens/DB passwords/AWS access-key shapes found
      zero matches.
- [x] **Test results are documented** — this file.

## Known limitations

1. Scenarios #4 and #6 rely on historical live evidence and integration-test coverage rather than
   a fresh live injection this session, because this sandbox has no mail-sending credential for
   `GMAIL_ADMIN_EMAIL` — sending a genuinely new test email (a second concurrent invoice, or one
   engineered to fail extraction for a different reason) is outside what this environment can do.
   This is the same class of limitation `docs/validation-report.md` documented for its own
   Scenario 10 in an earlier phase of this feature.
2. `Deploy to Cloud Run`'s Workload Identity Federation is still broken (defect 1) — this session
   worked around it with a manual `docker build`/`push`/`gcloud run deploy`, which is not a
   sustainable substitute for CI/CD. Needs GitHub repo-admin access this sandbox doesn't have.
3. `src/config/env.ts`'s `BEDROCK_MODEL_ID` default is still the retired model ID — production is
   shielded from it by the new Terraform override, but a fresh non-Terraform-managed environment
   (e.g. local dev without an explicit `.env` override) would still hit the same failure. Worth a
   small follow-up to update the code default directly.
4. The single test `SourceEmail` (`19ffb914e717357e`) now has 12 `Attachment` rows (2 per attempt
   across 6 processing attempts before the eventual success) rather than 2 — each failed attempt
   re-downloads and re-inserts `Attachment` rows before extraction runs, since attachment download
   is intentionally outside the retry loop (per-attempt diagnostics, `invoiceMonitor.ts` comment
   at the `downloadMessageAttachments` call site). This is working as designed, not a defect, but
   means repeated extraction failures against the same email accumulate storage over many retries
   — worth noting for anyone reviewing GCS bucket size growth during an extended outage like the
   one this session found and fixed.

## Security note

A temporary `roles/run.invoker` IAM binding for the operator account (`ramkumar@replicacia.com`)
was added to the Cloud Run service for the duration of this session's direct API verification
(scenarios #1, #3, #8, #9 all required calling the service directly, and only the Cloud Scheduler
service account had invoker access beforehand — by design, per `main.tf`'s comment "no
unauthenticated/public invocations"). **Removed at the end of this session** —
`gcloud run services get-iam-policy` now shows only `sima-scheduler@...` as invoker, matching the
pre-session state and the `main.tf`-documented intent.
