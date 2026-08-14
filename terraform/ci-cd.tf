# GitHub Actions -> GCP Workload Identity Federation (T210).
#
# `Deploy to Cloud Run` (.github/workflows/deploy.yml) has been failing at the
# `google-github-actions/auth@v2` step since 2026-08-10 because no WIF pool/provider existed in
# this project at all (see specs/001-gmail-invoice-ingestion/production-validation.md, T209). It
# was never IaC-managed before this. This file provisions the GCP side (pool, OIDC provider scoped
# to this exact repo, and a narrowly-scoped deployer service account) so it's reproducible and
# auditable like everything else here.
#
# This does NOT finish unblocking CI/CD by itself: the two GitHub Actions repo secrets
# (GCP_WORKLOAD_IDENTITY_PROVIDER, GCP_SERVICE_ACCOUNT) still need to be set to this file's outputs
# by someone with GitHub repo-admin access (`terraform output github_actions_secrets_to_set`) —
# that step is outside what a GCP-only credential (or Terraform itself) can do.

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "${var.name_prefix}-github-pool"
  display_name              = "GitHub Actions"
  description               = "Workload Identity Federation pool for GitHub Actions deploys of ${var.github_repository}."

  depends_on = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "${var.name_prefix}-github-provider"
  display_name                       = "GitHub OIDC"

  # Scoped to this exact repository only — a token minted for any other GitHub repo (even in the
  # same org) cannot exchange for a GCP credential through this provider.
  attribute_condition = "assertion.repository == \"${var.github_repository}\""

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Deploy-time identity used only by .github/workflows/deploy.yml. Scoped to exactly what that
# workflow does: push an image to this repo's Artifact Registry repository and roll out a new
# Cloud Run revision — nothing else (no project-wide admin, no access to secrets/database/GCS).
resource "google_service_account" "github_deployer" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-deployer"
  display_name = "Invoice Monitor GitHub Actions deployer"

  depends_on = [google_project_service.required]
}

resource "google_service_account_iam_member" "github_wif_impersonation" {
  service_account_id = google_service_account.github_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repository}"
}

resource "google_artifact_registry_repository_iam_member" "github_deployer_push" {
  project    = var.project_id
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.github_deployer.email}"
}

resource "google_cloud_run_v2_service_iam_member" "github_deployer_run_admin" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.app.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.github_deployer.email}"
}

# deploy-cloudrun@v2 reads the existing service's runtime service account when rolling out a new
# revision; it needs iam.serviceaccounts.actAs on that identity even though it never changes it.
resource "google_service_account_iam_member" "github_deployer_act_as_runtime" {
  service_account_id = google_service_account.cloud_run_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deployer.email}"
}
