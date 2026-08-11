locals {
  default_env_vars = {
    NODE_ENV                    = var.environment == "production" ? "production" : var.environment
    LOG_LEVEL                   = "info"
    ATTACHMENT_STORE_DRIVER     = "gcs"
    INVOICE_EXTRACTION_PROVIDER = "claude"
    GCP_REGION                  = var.region
    GOOGLE_CLOUD_PROJECT        = var.project_id
    GCS_BUCKET_NAME             = google_storage_bucket.attachments.name
  }

  plain_env_vars = merge(local.default_env_vars, var.plain_env_vars)
}

# ---------------------------------------------------------------------------
# APIs
# ---------------------------------------------------------------------------

resource "google_project_service" "required" {
  for_each = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudscheduler.googleapis.com",
    "storage.googleapis.com",
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
  ])

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# Artifact Registry
# ---------------------------------------------------------------------------

resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = var.service_name
  format        = "DOCKER"
  description   = "Invoice Monitor (SIMA) container images"
  labels        = var.labels

  depends_on = [google_project_service.required]
}

# ---------------------------------------------------------------------------
# Service accounts
# ---------------------------------------------------------------------------

resource "google_service_account" "cloud_run_runtime" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-run"
  display_name = "Invoice Monitor Cloud Run runtime identity"

  depends_on = [google_project_service.required]
}

resource "google_service_account" "scheduler_invoker" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-scheduler"
  display_name = "Invoice Monitor Cloud Scheduler invoker identity"

  depends_on = [google_project_service.required]
}

# The Cloud Run runtime identity needs to reach the Cloud SQL Admin API to use the built-in
# connector (Cloud SQL Auth Proxy under the hood). Granted at project scope now so it's ready
# before the instance itself exists (see sql_instance_connection_name / T203).
resource "google_project_iam_member" "cloud_run_sql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.cloud_run_runtime.email}"
}

# ---------------------------------------------------------------------------
# Cloud Run service
# ---------------------------------------------------------------------------

resource "google_cloud_run_v2_service" "app" {
  project  = var.project_id
  name     = var.service_name
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  labels   = var.labels

  template {
    service_account = google_service_account.cloud_run_runtime.email
    timeout         = "${var.cloud_run_timeout_seconds}s"

    scaling {
      min_instance_count = var.cloud_run_min_instances
      max_instance_count = var.cloud_run_max_instances
    }

    containers {
      image = var.container_image

      resources {
        limits = {
          cpu    = var.cloud_run_cpu
          memory = var.cloud_run_memory
        }
      }

      ports {
        container_port = 8080
      }

      dynamic "env" {
        for_each = local.plain_env_vars
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env_vars
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
    }

    # Cloud SQL instance itself is provisioned in database.tf (T203); referencing it directly
    # here (rather than through a variable) means Terraform tracks the dependency automatically.
    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.main.connection_name]
      }
    }
  }

  # The deploy workflow (.github/workflows/deploy.yml) rolls out new image tags on every push to
  # main; Terraform owns every other field here, but must not fight CI/CD over the image field.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.required,
    google_project_iam_member.cloud_run_sql_client,
    google_secret_manager_secret_iam_member.cloud_run_secret_access,
    google_secret_manager_secret_iam_member.cloud_run_database_url_access,
    google_storage_bucket_iam_member.cloud_run_attachments_access,
  ]
}

# Only the Cloud Scheduler invoker identity may call the service (no unauthenticated/public
# invocations) — matches the current manual `gcloud run services add-iam-policy-binding` step in
# deploy.yml, which T208 will remove once Terraform owns the Cloud Scheduler job.
resource "google_cloud_run_v2_service_iam_member" "scheduler_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler_invoker.email}"
}
