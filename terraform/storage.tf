# Production GCS bucket for invoice attachment storage (T204).
#
# Bucket names are globally unique across all of GCP, so a short literal default would likely
# collide with another project; the name is derived from the project ID unless var.gcs_bucket_name
# overrides it. Cloud Run's GCS_BUCKET_NAME env var (main.tf) references this resource directly
# rather than the raw variable, so the running service can never point at a bucket Terraform
# didn't actually create.

resource "google_storage_bucket" "attachments" {
  project                     = var.project_id
  name                        = var.gcs_bucket_name != "" ? var.gcs_bucket_name : "${var.project_id}-${var.name_prefix}-attachments"
  location                    = var.region
  uniform_bucket_level_access = true
  force_destroy               = false
  labels                      = var.labels

  versioning {
    enabled = true
  }

  # Invoice attachments back Complete Auditability (every Invoice must trace back to its source
  # attachment) — objects are never deleted by policy, only moved to cheaper storage classes as
  # they age out of the window they're likely to be re-read in.
  lifecycle_rule {
    condition {
      age = 90
    }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }

  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  depends_on = [google_project_service.required]
}

# Least-privilege: the Cloud Run runtime identity can read/write/delete objects in this bucket
# only (roles/storage.objectAdmin scoped to the bucket itself), not manage bucket-level settings
# and not touch any other bucket in the project (no project-wide roles/storage.admin).
resource "google_storage_bucket_iam_member" "cloud_run_attachments_access" {
  bucket = google_storage_bucket.attachments.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.cloud_run_runtime.email}"
}
