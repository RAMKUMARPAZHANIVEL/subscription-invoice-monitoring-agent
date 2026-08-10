terraform {
  required_version = ">= 1.7"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Partial backend configuration: the state bucket is itself GCP infrastructure and must exist
  # before `terraform init` can use it, so its name/prefix are supplied at init time rather than
  # hardcoded here (keeps this config project-agnostic across environments).
  #
  #   terraform init -backend-config="bucket=<state-bucket-name>" -backend-config="prefix=invoice-monitor/production"
  #
  # or via a gitignored backend.hcl (see terraform/backend.hcl.example).
  backend "gcs" {}
}
