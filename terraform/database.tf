# Production Cloud SQL for PostgreSQL — instance, database, user, and the resulting
# DATABASE_URL secret (T203).
#
# Unlike the app secrets in secrets.tf (T202), whose values come from external providers (Gmail
# OAuth, the CoreValue gateway) and must never enter Terraform state, DATABASE_URL is derived
# entirely from resources this file creates — the generated password already lives in state the
# moment `random_password` is created, so writing the composed connection string as the initial
# secret version here doesn't add a new secret-handling risk; it just avoids a manual
# `gcloud secrets versions add` step for a value Terraform already knows.

resource "random_password" "db_password" {
  length  = 32
  special = false # keep it free of characters that would need URL-encoding in DATABASE_URL
}

resource "google_sql_database_instance" "main" {
  project             = var.project_id
  name                = "${var.name_prefix}-postgres"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = true

  settings {
    tier              = var.sql_tier
    availability_type = var.sql_availability_type
    disk_autoresize   = true
    disk_size         = 10

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }

    # No public IP: reachable only through the Cloud Run built-in Cloud SQL connector
    # (Unix socket, wired up in main.tf) — no custom VPC needed, matching T201's design.
    ip_configuration {
      ipv4_enabled = false
    }

    user_labels = var.labels
  }

  depends_on = [google_project_service.required]
}

resource "google_sql_database" "app" {
  project  = var.project_id
  instance = google_sql_database_instance.main.name
  name     = "${var.name_prefix}_invoice_monitor"
}

resource "google_sql_user" "app" {
  project  = var.project_id
  instance = google_sql_database_instance.main.name
  name     = "${var.name_prefix}_app"
  password = random_password.db_password.result
}

locals {
  # node-postgres (via @prisma/adapter-pg) treats a `host` query param as a Unix socket path,
  # which is how the Cloud Run built-in Cloud SQL connector exposes the instance at
  # /cloudsql/<connection_name> — no host:port pair or sslmode needed, the connector handles
  # encryption in transit.
  database_url = "postgresql://${google_sql_user.app.name}:${random_password.db_password.result}@localhost/${google_sql_database.app.name}?host=/cloudsql/${google_sql_database_instance.main.connection_name}&schema=public"
}

resource "google_secret_manager_secret" "database_url" {
  project   = var.project_id
  secret_id = var.secret_env_vars["DATABASE_URL"]
  labels    = var.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.required]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.database_url.id
  secret_data = local.database_url
}

resource "google_secret_manager_secret_iam_member" "cloud_run_database_url_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run_runtime.email}"
}
