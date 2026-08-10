# Invoice Monitor (SIMA) — Terraform

Terraform configuration for the Invoice Monitor's GCP infrastructure. This config targets a
**dedicated GCP project** used only for the Invoice Monitor — do not point `project_id` at a
project shared with Paperclip or any other workload; that project-level boundary is what keeps
this infrastructure isolated, on top of the `labels` applied to every resource here.

Provisioned by this configuration (T201/T202 — see `specs/001-gmail-invoice-ingestion/tasks.md`
Phase 7 for the full rollout sequence):

- Required API enablement
- Artifact Registry (Docker) repository
- Cloud Run v2 service, scaled to zero when idle, with the built-in Cloud SQL connector wired up
  (no custom VPC)
- Cloud Run runtime service account (`roles/cloudsql.client`)
- Cloud Scheduler invoker service account, granted `roles/run.invoker` on the Cloud Run service
- Secret Manager containers for the application secrets Cloud Run needs (`GMAIL_CLIENT_ID`,
  `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_ADMIN_EMAIL`, `COREVALUE_API_KEY`), with
  `roles/secretmanager.secretAccessor` granted to the Cloud Run runtime identity (`secrets.tf`,
  T202). Terraform never sets the secret _values_ — see `secrets.tf` for how to populate them via
  `gcloud secrets versions add` after `terraform apply`.

Deliberately **not** provisioned here — later tasks in the same Phase 7 sequence own these, using
the outputs from this config:

- Cloud SQL instance/database/user + `DATABASE_URL` secret (T203)
- GCS bucket for attachments (T204)
- The Cloud Scheduler job itself (T208)

## Usage

```bash
cd terraform
cp backend.hcl.example backend.hcl   # fill in your state bucket name; backend.hcl is gitignored
terraform init -backend-config=backend.hcl
terraform validate
terraform plan -var="project_id=<your-gcp-project-id>"
terraform apply -var="project_id=<your-gcp-project-id>"
```

The state bucket referenced in `backend.hcl` must already exist (create it once, by hand or with a
separate bootstrap config, before the first `terraform init`) — a bucket can't be its own backend's
prerequisite.

All project/environment-specific values are variables (see `variables.tf`); nothing here is
hardcoded to a specific GCP project, and no secret values are stored in this configuration —
Cloud Run's env vars are wired to Secret Manager secrets **by name** (`var.secret_env_vars`), so
the actual secret contents are created and rotated independently (T202/T203).
