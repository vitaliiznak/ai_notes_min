#!/usr/bin/env bash
# Build the repo image with Cloud Build and run deploy/k8s on GKE Autopilot.
# Creates the Artifact Registry repo and the cluster when they are missing.
source "$(dirname "$0")/common.sh"

USAGE="Usage: ./deploy/gke.sh [--dry-run]"
parse_dry_run "${1:-}"
load_ai_settings

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  log "Set PROJECT_ID, or run: gcloud config set project YOUR_PROJECT"
  exit 1
fi

IMAGE_REPO="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/ai-notes"

log "Project:  ${PROJECT_ID}"
log "Region:   ${REGION}"
log "Cluster:  ${CLUSTER}"
log "Image:    ${IMAGE_REPO}:${TAG}"
log "Provider: ${AI_PROVIDER}"

stage_bundle deploy/k8s "$IMAGE_REPO"
if [[ "$DRY_RUN" -eq 1 ]]; then
  kubectl kustomize "$stage"
  exit 0
fi

gcloud_cmd() {
  gcloud --quiet --project="$PROJECT_ID" "$@"
}

log "Enabling APIs"
gcloud_cmd services enable \
  container.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  compute.googleapis.com

created_repo=0
if ! gcloud_cmd artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1; then
  log "Creating Artifact Registry repo ${REPO}"
  gcloud_cmd artifacts repositories create "$REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="AI Notes images"
  created_repo=1
fi

PROJECT_NUMBER="$(gcloud_cmd projects describe "$PROJECT_ID" --format='value(projectNumber)')"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
# Output is either the email or a small YAML object, depending on the gcloud version.
build_sa_raw="$(gcloud_cmd builds get-default-service-account --format=yaml 2>/dev/null || true)"
BUILD_SA="$(printf '%s\n' "$build_sa_raw" | grep -Eo '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com' | head -n 1 || true)"
if [[ -z "$BUILD_SA" ]]; then
  BUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
fi

grant_repo() {
  local sa="$1" role="$2"
  log "Granting ${role} to ${sa}"
  gcloud_cmd artifacts repositories add-iam-policy-binding "$REPO" \
    --location="$REGION" \
    --member="serviceAccount:${sa}" \
    --role="$role" >/dev/null
}

grant_repo "$BUILD_SA" roles/artifactregistry.writer
legacy_sa="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
if [[ "$legacy_sa" != "$BUILD_SA" ]] && gcloud_cmd iam service-accounts describe "$legacy_sa" >/dev/null 2>&1; then
  grant_repo "$legacy_sa" roles/artifactregistry.writer
fi
grant_repo "$COMPUTE_SA" roles/artifactregistry.reader

log "Granting roles/logging.logWriter to ${BUILD_SA}"
gcloud_cmd projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${BUILD_SA}" \
  --role=roles/logging.logWriter >/dev/null

if ! gcloud_cmd container clusters describe "$CLUSTER" --region="$REGION" >/dev/null 2>&1; then
  log "Creating Autopilot cluster ${CLUSTER} in ${REGION}. This takes several minutes and starts billing."
  gcloud_cmd container clusters create-auto "$CLUSTER" --region="$REGION"
fi

log "Fetching cluster credentials (this switches the current kubectl context)"
gcloud_cmd container clusters get-credentials "$CLUSTER" --region="$REGION"

log "Building ${IMAGE_REPO}:${TAG}"
# A repo created in this run does not accept pushes until the IAM binding is visible.
if [[ "$created_repo" -eq 1 ]]; then
  sleep 20
fi
gcloud_cmd builds submit --config deploy/cloudbuild.yaml \
  --substitutions="_REGION=${REGION},_REPO=${REPO},_TAG=${TAG}"

apply_bundle ingress
