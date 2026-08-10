variable "project_id" {
  description = "GCP project ID dedicated to the Invoice Monitor (SIMA). Must not be shared with Paperclip or other unrelated workloads."
  type        = string
}

variable "region" {
  description = "GCP region for all regional resources (Cloud Run, Artifact Registry, Cloud SQL, Cloud Scheduler)."
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Deployment environment name, used in resource labels."
  type        = string
  default     = "production"
}

variable "name_prefix" {
  description = "Short prefix used for resource names that have tight length limits (service accounts, secrets). Keep it short: GCP service account IDs are capped at 30 characters."
  type        = string
  default     = "sima"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,10}$", var.name_prefix))
    error_message = "name_prefix must be lowercase alphanumeric/hyphens, 2-11 characters, starting with a letter."
  }
}

variable "service_name" {
  description = "Cloud Run service name and Artifact Registry repository ID. Must match the SERVICE_NAME used in .github/workflows/deploy.yml."
  type        = string
  default     = "subscription-invoice-monitoring-agent"
}

variable "labels" {
  description = "Labels applied to all Invoice Monitor resources that support labels. Used to keep this project's resources identifiable and isolated from any other workload sharing the GCP org/billing account."
  type        = map(string)
  default = {
    app        = "invoice-monitor"
    managed-by = "terraform"
  }
}

variable "container_image" {
  description = "Initial container image for the Cloud Run service. The deploy workflow (.github/workflows/deploy.yml) updates the running image on every push to main; Terraform ignores drift on this field after initial creation so CI/CD and Terraform don't fight over ownership."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "cloud_run_cpu" {
  description = "vCPU limit per Cloud Run container instance."
  type        = string
  default     = "1"
}

variable "cloud_run_memory" {
  description = "Memory limit per Cloud Run container instance."
  type        = string
  default     = "512Mi"
}

variable "cloud_run_min_instances" {
  description = "Minimum Cloud Run instance count. 0 enables scale-to-zero, which is appropriate for a low-traffic, once-daily-triggered service."
  type        = number
  default     = 0
}

variable "cloud_run_max_instances" {
  description = "Maximum Cloud Run instance count, as a safety cap on cost/blast radius."
  type        = number
  default     = 2
}

variable "cloud_run_timeout_seconds" {
  description = "Request timeout for the Cloud Run service, in seconds. The ingestion trigger endpoint can run long during large mailbox scans."
  type        = number
  default     = 600
}

variable "sql_instance_connection_name" {
  description = "Cloud SQL instance connection name (PROJECT:REGION:INSTANCE) to attach to Cloud Run via the built-in Cloud SQL connector. Left empty until the Cloud SQL instance is provisioned (see tasks.md T203); when empty, no Cloud SQL volume is attached."
  type        = string
  default     = ""
}

variable "sql_tier" {
  description = "Machine tier for the Cloud SQL for PostgreSQL instance provisioned in T203. Recorded here so Cloud Run sizing and Cloud SQL sizing are reviewed together; smallest tier that comfortably fits a low-QPS, once-daily invoice ingestion workload."
  type        = string
  default     = "db-g1-small"
}

variable "sql_availability_type" {
  description = "Cloud SQL availability type for T203. ZONAL (single zone, no HA) is the cost-efficient default for this workload; switch to REGIONAL only if uptime requirements change."
  type        = string
  default     = "ZONAL"
}

variable "secret_env_vars" {
  description = "Map of Cloud Run environment variable name -> Secret Manager secret ID it should be sourced from (:latest version). The secret containers for every entry except DATABASE_URL are created by secrets.tf (T202) with IAM access granted to the Cloud Run runtime identity; DATABASE_URL's container is created by T203 once the Cloud SQL connection string exists. Actual secret *values* are never set here — see secrets.tf for how to populate them out-of-band."
  type        = map(string)
  default = {
    DATABASE_URL        = "sima-database-url"
    GMAIL_CLIENT_ID     = "sima-gmail-client-id"
    GMAIL_CLIENT_SECRET = "sima-gmail-client-secret"
    GMAIL_REFRESH_TOKEN = "sima-gmail-refresh-token"
    GMAIL_ADMIN_EMAIL   = "sima-gmail-admin-email"
    COREVALUE_API_KEY   = "sima-corevalue-api-key"
  }
}

variable "gcs_bucket_name" {
  description = "Name of the GCS bucket used for attachment storage (provisioned in T204). Passed through as the GCS_BUCKET_NAME env var; left empty until the bucket exists."
  type        = string
  default     = ""
}

variable "plain_env_vars" {
  description = "Additional non-secret Cloud Run environment variables, merged with the built-in defaults (NODE_ENV, LOG_LEVEL, ATTACHMENT_STORE_DRIVER, INVOICE_EXTRACTION_PROVIDER, GCP_REGION, GOOGLE_CLOUD_PROJECT)."
  type        = map(string)
  default     = {}
}
