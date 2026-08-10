# Production application secrets (T202).
#
# This file provisions the Secret Manager *containers* only, plus the IAM binding letting the
# Cloud Run runtime service account read them. It never sets a secret *version* (the actual
# sensitive value) — that must never live in source control or Terraform state as plain HCL.
# Populate each secret's initial version out-of-band once `terraform apply` has created the
# container, e.g.:
#
#   printf '%s' '<value>' | gcloud secrets versions add sima-gmail-client-id \
#     --project="$PROJECT_ID" --data-file=-
#
# `DATABASE_URL` (secret ID `sima-database-url`) is deliberately excluded — it's created and
# populated by T203 once the Cloud SQL connection string exists.

locals {
  # The subset of var.secret_env_vars this task owns: every app secret Cloud Run needs except
  # DATABASE_URL, which T203 creates once the Cloud SQL instance exists. Keying by the Cloud Run
  # env var name (not the secret ID) keeps this in lockstep with var.secret_env_vars.
  app_secret_env_vars = {
    for env_name, secret_id in var.secret_env_vars : env_name => secret_id
    if env_name != "DATABASE_URL"
  }
}

resource "google_secret_manager_secret" "app_secrets" {
  for_each  = local.app_secret_env_vars
  project   = var.project_id
  secret_id = each.value
  labels    = var.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

# Least-privilege: only the Cloud Run runtime identity can read these secret values, and only
# the accessor role (not editor/admin) — it never needs to create versions or manage the secret.
resource "google_secret_manager_secret_iam_member" "cloud_run_secret_access" {
  for_each  = google_secret_manager_secret.app_secrets
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run_runtime.email}"
}
