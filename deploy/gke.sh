#!/usr/bin/env bash
# Build the repo image with Cloud Build and run deploy/k8s on GKE Autopilot.
# Creates the Artifact Registry repo and the cluster when they are missing.
# Does not rotate an existing ai-notes secret (that password is the database password).
set -euo pipefail

log() { printf '%s\n' "$*" >&2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGION="${REGION:-europe-west1}"
REPO="${REPO:-ai-notes}"
CLUSTER="${CLUSTER:-ai-notes}"
NAMESPACE="${NAMESPACE:-ai-notes}"
DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ -n "${1:-}" ]]; then
  log "Usage: ./deploy/gke.sh [--dry-run]" >&2
  exit 2
fi

# Read one KEY=value from .env. The file is not executed and the value is not printed.
dotenv_get() {
  local key="$1" line value
  [[ -f .env ]] || return 0
  line="$(grep -E "^${key}=" .env | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  printf '%s' "$value"
}

if [[ -z "${AI_PROVIDER:-}" ]]; then
  AI_PROVIDER="$(dotenv_get AI_PROVIDER)"
fi
AI_PROVIDER="${AI_PROVIDER:-openai}"
if [[ "$AI_PROVIDER" != "openai" && "$AI_PROVIDER" != "fake" ]]; then
  log "AI_PROVIDER must be openai or fake." >&2
  exit 1
fi

if [[ "$DRY_RUN" -eq 0 && "$AI_PROVIDER" == "openai" && -z "${OPENAI_API_KEY:-}" ]]; then
  OPENAI_API_KEY="$(dotenv_get OPENAI_API_KEY)"
fi
if [[ "$DRY_RUN" -eq 0 && "$AI_PROVIDER" == "openai" && -z "${OPENAI_API_KEY:-}" ]]; then
  log "OPENAI_API_KEY is required when AI_PROVIDER=openai. Export it, put it in .env, or run with AI_PROVIDER=fake." >&2
  exit 1
fi

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
  log "Set PROJECT_ID, or run: gcloud config set project YOUR_PROJECT" >&2
  exit 1
fi

# A repository with no commits yet has no HEAD. A timestamp still gives the build a unique tag.
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/ai-notes:${TAG}"

log "Project:  ${PROJECT_ID}"
log "Region:   ${REGION}"
log "Cluster:  ${CLUSTER}"
log "Image:    ${IMAGE}"
log "Provider: ${AI_PROVIDER}"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp deploy/k8s/namespace.yaml deploy/k8s/postgres.yaml deploy/k8s/app.yaml deploy/k8s/ingress.yaml "$stage/"
if [[ "$AI_PROVIDER" == "fake" ]]; then
  rendered="$(mktemp)"
  sed 's/AI_PROVIDER: openai/AI_PROVIDER: fake/' "$stage/app.yaml" >"$rendered"
  mv "$rendered" "$stage/app.yaml"
fi
cat >"$stage/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: ${NAMESPACE}
resources:
  - namespace.yaml
  - postgres.yaml
  - app.yaml
  - ingress.yaml
images:
  - name: ai-notes
    newName: ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/ai-notes
    newTag: "${TAG}"
EOF

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

log "Building ${IMAGE}"
# A repo created in this run does not accept pushes until the IAM binding is visible.
if [[ "$created_repo" -eq 1 ]]; then
  sleep 20
fi
gcloud_cmd builds submit --config deploy/cloudbuild.yaml \
  --substitutions="_REGION=${REGION},_REPO=${REPO},_TAG=${TAG}"

kubectl apply -f deploy/k8s/namespace.yaml

if kubectl -n "$NAMESPACE" get secret ai-notes >/dev/null 2>&1; then
  log "Secret ${NAMESPACE}/ai-notes already exists; leaving the database password as it is."
else
  password="$(openssl rand -hex 24)"
  create_args=(kubectl -n "$NAMESPACE" create secret generic ai-notes --from-literal="POSTGRES_PASSWORD=${password}")
  if [[ "$AI_PROVIDER" == "openai" ]]; then
    create_args+=(--from-literal="OPENAI_API_KEY=${OPENAI_API_KEY}")
  fi
  "${create_args[@]}"
fi

kubectl apply -k "$stage"
kubectl -n "$NAMESPACE" rollout status "deploy/ai-notes" --timeout=600s
log ""
kubectl -n "$NAMESPACE" get ingress ai-notes
log "The address appears after a few minutes. Open http://<address>."
