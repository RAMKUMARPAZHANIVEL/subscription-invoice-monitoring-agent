# Daily invoice ingestion trigger (T208).
#
# Terraform is the sole owner of this job — .github/workflows/deploy.yml no longer creates or
# updates it (that duplicate-ownership step was removed as part of this task) — so schedule,
# retry, and auth configuration only ever change through this file, never silently via CI.
#
# Authentication: Cloud Scheduler calls the Cloud Run service as the scheduler_invoker service
# account (main.tf), presenting a Google-signed OIDC token whose audience is the service URL
# itself. That identity holds roles/run.invoker on this service and nothing else
# (google_cloud_run_v2_service_iam_member.scheduler_invoker in main.tf) — Cloud Run is not
# publicly invokable, so a valid OIDC token from that exact service account is the only way in.

resource "google_cloud_scheduler_job" "ingest_invoices" {
  project     = var.project_id
  region      = var.region
  name        = "${var.service_name}-ingest-invoices"
  description = "Triggers daily subscription invoice ingestion (POST /tasks/ingest-invoices)."
  schedule    = var.scheduler_schedule
  time_zone   = var.scheduler_time_zone

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.app.uri}/tasks/ingest-invoices"

    oidc_token {
      service_account_email = google_service_account.scheduler_invoker.email
      audience              = google_cloud_run_v2_service.app.uri
    }
  }

  # attempt_deadline governs a single attempt, so it must stay within Cloud Run's own request
  # timeout (var.cloud_run_timeout_seconds) — otherwise Cloud Scheduler could give up and retry a
  # request that was still legitimately in flight, risking overlapping ingestion runs.
  attempt_deadline = "${var.scheduler_attempt_deadline_seconds}s"

  retry_config {
    retry_count          = var.scheduler_retry_count
    max_retry_duration   = "0s" # 0s = no overall cap beyond retry_count itself
    min_backoff_duration = "5s"
    max_backoff_duration = "60s"
    max_doublings        = 3
  }

  depends_on = [
    google_project_service.required,
    google_cloud_run_v2_service_iam_member.scheduler_invoker,
  ]
}
