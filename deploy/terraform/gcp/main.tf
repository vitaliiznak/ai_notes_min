data "google_project" "this" {
  project_id = var.project_id
}

locals {
  cloud_build_sa = "${data.google_project.this.number}@cloudbuild.gserviceaccount.com"
  compute_sa     = "${data.google_project.this.number}-compute@developer.gserviceaccount.com"
}

resource "google_project_service" "services" {
  for_each = toset([
    "container.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "compute.googleapis.com",
  ])
  project = var.project_id
  service = each.value
  # Destroying this stack must not turn off APIs the rest of the project uses.
  disable_on_destroy = false
}

# The Container and Cloud Build APIs are not usable the moment they are enabled.
resource "time_sleep" "apis" {
  depends_on      = [google_project_service.services]
  create_duration = "45s"
}

resource "google_artifact_registry_repository" "ai_notes" {
  location      = var.region
  repository_id = var.repository_id
  format        = "DOCKER"
  description   = "AI Notes images"
  labels = {
    app = "ai-notes"
  }

  depends_on = [time_sleep.apis]
}

# Cloud Build's default identity is either the legacy Cloud Build account or the
# Compute Engine account, depending on when the project was created. Grant both.
resource "google_artifact_registry_repository_iam_member" "builder" {
  for_each   = toset([local.cloud_build_sa, local.compute_sa])
  project    = var.project_id
  location   = google_artifact_registry_repository.ai_notes.location
  repository = google_artifact_registry_repository.ai_notes.repository_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${each.value}"
}

resource "google_artifact_registry_repository_iam_member" "nodes" {
  project    = var.project_id
  location   = google_artifact_registry_repository.ai_notes.location
  repository = google_artifact_registry_repository.ai_notes.repository_id
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${local.compute_sa}"
}

resource "google_project_iam_member" "build_logs" {
  for_each = toset([local.cloud_build_sa, local.compute_sa])
  project  = var.project_id
  role     = "roles/logging.logWriter"
  member   = "serviceAccount:${each.value}"
}

resource "google_container_cluster" "ai_notes" {
  name                = var.cluster_name
  location            = var.region
  enable_autopilot    = true
  deletion_protection = false
  resource_labels = {
    app = "ai-notes"
  }

  depends_on = [time_sleep.apis]
}
