variable "project_id" {
  type        = string
  description = "GCP project. ./deploy/tf.sh gcp uses the current gcloud project."
}

variable "region" {
  type        = string
  description = "Region for the Autopilot cluster and Artifact Registry."
  default     = "europe-west1"
}

variable "cluster_name" {
  type        = string
  description = "GKE Autopilot cluster name."
  default     = "ai-notes"
}

variable "repository_id" {
  type        = string
  description = "Artifact Registry repository id."
  default     = "ai-notes"
}
