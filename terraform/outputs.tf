output "cloud_run_service_url" {
  description = "URL of the deployed Cloud Run service."
  value       = google_cloud_run_v2_service.app.uri
}

output "cloud_run_service_name" {
  description = "Cloud Run service name (used by deploy.yml and gcloud scheduler commands)."
  value       = google_cloud_run_v2_service.app.name
}

output "artifact_registry_repository" {
  description = "Full Artifact Registry repository path for building/pushing images."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "cloud_run_runtime_service_account_email" {
  description = "Email of the Cloud Run runtime service account. Grant this identity access to secrets (T202) and the GCS bucket (T204) as those resources are created."
  value       = google_service_account.cloud_run_runtime.email
}

output "scheduler_invoker_service_account_email" {
  description = "Email of the Cloud Scheduler invoker service account. Use as the OIDC service account when T208 creates the Cloud Scheduler job."
  value       = google_service_account.scheduler_invoker.email
}
