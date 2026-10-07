#!/usr/bin/env bash
# Create the cluster and registry with Terraform, build the image, and apply the matching bundle.
# gcp: GKE Autopilot + Artifact Registry, then deploy/k8s (GCE Ingress).
# azure: AKS + Container Registry, then deploy/k8s/azure (Azure load balancer).
# Does not rotate an existing ai-notes secret (that password is the database password).
# Does not put the API key in Terraform state.
set -euo pipefail

log() { printf '%s\n' "$*" >&2; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

usage() {
  log "Usage: ./deploy/tf.sh gcp|azure [--dry-run]"
}

CLOUD="${1:-}"
DRY_RUN=0
if [[ "${2:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ -n "${2:-}" ]]; then
  usage
  exit 2
fi
case "$CLOUD" in
  gcp | azure) ;;
  *)
    usage
    exit 2
    ;;
esac

command -v terraform >/dev/null || { log "terraform is required."; exit 1; }
command -v kubectl >/dev/null || { log "kubectl is required."; exit 1; }

REGION="${REGION:-europe-west1}"
REPO="${REPO:-ai-notes}"
CLUSTER="${CLUSTER:-ai-notes}"
NAMESPACE="${NAMESPACE:-ai-notes}"
AZURE_LOCATION="${AZURE_LOCATION:-westeurope}"

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

if [[ "$DRY_RUN" -eq 0 && -z "${AI_PROVIDER:-}" ]]; then
  AI_PROVIDER="$(dotenv_get AI_PROVIDER)"
fi
AI_PROVIDER="${AI_PROVIDER:-openai}"
if [[ "$AI_PROVIDER" != "openai" && "$AI_PROVIDER" != "fake" ]]; then
  log "AI_PROVIDER must be openai or fake."
  exit 1
fi
if [[ "$DRY_RUN" -eq 0 && "$AI_PROVIDER" == "openai" && -z "${OPENAI_API_KEY:-}" ]]; then
  OPENAI_API_KEY="$(dotenv_get OPENAI_API_KEY)"
fi
if [[ "$DRY_RUN" -eq 0 && "$AI_PROVIDER" == "openai" && -z "${OPENAI_API_KEY:-}" ]]; then
  log "OPENAI_API_KEY is required when AI_PROVIDER=openai. Export it, put it in .env, or run with AI_PROVIDER=fake."
  exit 1
fi

TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"

short_hash() {
  if command -v shasum >/dev/null; then
    printf '%s' "$1" | shasum -a 256 | awk '{print substr($1, 1, 8)}'
  else
    printf '%s' "$1" | sha256sum | awk '{print substr($1, 1, 8)}'
  fi
}

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

render_gcp() {
  local image_repo="$1"
  cp deploy/k8s/namespace.yaml deploy/k8s/postgres.yaml deploy/k8s/app.yaml deploy/k8s/ingress.yaml "$stage/"
  if [[ "$AI_PROVIDER" == "fake" ]]; then
    local rendered
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
    newName: ${image_repo}
    newTag: "${TAG}"
EOF
}

render_azure() {
  local image_repo="$1"
  mkdir -p "$stage/azure"
  cp deploy/k8s/namespace.yaml deploy/k8s/postgres.yaml deploy/k8s/app.yaml "$stage/azure/"
  cp deploy/k8s/azure/kustomization.yaml deploy/k8s/azure/service.yaml deploy/k8s/azure/storage.yaml "$stage/azure/"
  if [[ "$AI_PROVIDER" == "fake" ]]; then
    local rendered
    rendered="$(mktemp)"
    sed 's/AI_PROVIDER: openai/AI_PROVIDER: fake/' "$stage/azure/app.yaml" >"$rendered"
    mv "$rendered" "$stage/azure/app.yaml"
  fi
  local rendered
  rendered="$(mktemp)"
  awk -v name="$image_repo" -v tag="$TAG" '
    $0 == "    newName: ai-notes" { print "    newName: " name; found = found + 1; next }
    $0 == "    newTag: latest" { print "    newTag: \"" tag "\""; found = found + 1; next }
    { print }
    END { if (found != 2) exit 1 }
  ' "$stage/azure/kustomization.yaml" >"$rendered" || {
    log "azure kustomization image block not found"
    exit 1
  }
  mv "$rendered" "$stage/azure/kustomization.yaml"
}

apply_workloads() {
  local kustomize_dir="$1" address_kind="$2"
  kubectl apply -f deploy/k8s/namespace.yaml
  if kubectl -n "$NAMESPACE" get secret ai-notes >/dev/null 2>&1; then
    log "Secret ${NAMESPACE}/ai-notes already exists; leaving the database password as it is."
  else
    local password
    password="$(openssl rand -hex 24)"
    local create_args=(kubectl -n "$NAMESPACE" create secret generic ai-notes --from-literal="POSTGRES_PASSWORD=${password}")
    if [[ "$AI_PROVIDER" == "openai" ]]; then
      create_args+=(--from-literal="OPENAI_API_KEY=${OPENAI_API_KEY}")
    fi
    "${create_args[@]}"
  fi
  kubectl apply -k "$kustomize_dir"
  kubectl -n "$NAMESPACE" rollout status "deploy/ai-notes" --timeout=600s
  log ""
  if [[ "$address_kind" == "ingress" ]]; then
    kubectl -n "$NAMESPACE" get ingress ai-notes
  else
    kubectl -n "$NAMESPACE" get svc ai-notes
  fi
  log "The address appears after a few minutes. Open http://<address>."
}

if [[ "$CLOUD" == "gcp" ]]; then
  command -v gcloud >/dev/null || { log "gcloud is required for gcp."; exit 1; }
  if [[ "$DRY_RUN" -eq 1 ]]; then
    PROJECT_ID="${PROJECT_ID:-example-project}"
  else
    PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
  fi
  if [[ -z "${PROJECT_ID}" || "${PROJECT_ID}" == "(unset)" ]]; then
    log "Set PROJECT_ID, or run: gcloud config set project YOUR_PROJECT"
    exit 1
  fi
  IMAGE_REPO="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/ai-notes"
  log "Cloud:    gcp"
  log "Project:  ${PROJECT_ID}"
  log "Region:   ${REGION}"
  log "Cluster:  ${CLUSTER}"
  log "Image:    ${IMAGE_REPO}:${TAG}"
  log "Provider: ${AI_PROVIDER}"
  render_gcp "$IMAGE_REPO"
  log "Validating deploy/terraform/gcp"
  terraform -chdir=deploy/terraform/gcp init -backend=false -input=false
  terraform -chdir=deploy/terraform/gcp validate
  if [[ "$DRY_RUN" -eq 1 ]]; then
    kubectl kustomize "$stage"
    exit 0
  fi
  log "Applying Terraform. This creates a billable Autopilot cluster if it does not exist."
  terraform -chdir=deploy/terraform/gcp init -input=false
  terraform -chdir=deploy/terraform/gcp apply -input=false -auto-approve \
    -var "project_id=${PROJECT_ID}" \
    -var "region=${REGION}" \
    -var "cluster_name=${CLUSTER}" \
    -var "repository_id=${REPO}"
  log "Fetching cluster credentials (this switches the current kubectl context)"
  gcloud --quiet --project="$PROJECT_ID" container clusters get-credentials "$CLUSTER" --region="$REGION"
  log "Building ${IMAGE_REPO}:${TAG}"
  # A registry created in this apply does not accept pushes until the IAM binding is visible.
  sleep 20
  gcloud --quiet --project="$PROJECT_ID" builds submit --config deploy/cloudbuild.yaml \
    --substitutions="_REGION=${REGION},_REPO=${REPO},_TAG=${TAG}"
  apply_workloads "$stage" ingress
else
  command -v az >/dev/null || { log "az is required for azure."; exit 1; }
  if [[ "$DRY_RUN" -eq 1 ]]; then
    ACR_LOGIN_SERVER="${ACR_LOGIN_SERVER:-example.azurecr.io}"
    log "Cloud:    azure"
    log "Location: ${AZURE_LOCATION}"
    log "Image:    ${ACR_LOGIN_SERVER}/ai-notes:${TAG}"
    log "Provider: ${AI_PROVIDER}"
    render_azure "${ACR_LOGIN_SERVER}/ai-notes"
    log "Validating deploy/terraform/azure"
    terraform -chdir=deploy/terraform/azure init -backend=false -input=false
    terraform -chdir=deploy/terraform/azure validate
    kubectl kustomize "$stage/azure"
    exit 0
  fi
  SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
  suffix="$(short_hash "$SUBSCRIPTION_ID")"
  ACR_NAME="${ACR_NAME:-ainotes${suffix}}"
  DNS_PREFIX="${DNS_PREFIX:-ainotes-${suffix}}"
  log "Cloud:        azure"
  log "Subscription: ${SUBSCRIPTION_ID}"
  log "Location:     ${AZURE_LOCATION}"
  log "Cluster:      ${CLUSTER}"
  log "Registry:     ${ACR_NAME}"
  log "Provider:     ${AI_PROVIDER}"
  log "Applying Terraform. This creates a billable AKS node and a public load balancer if they do not exist."
  log "The account needs permission to assign roles (Owner or User Access Administrator) so the cluster can pull from the registry."
  terraform -chdir=deploy/terraform/azure init -input=false
  terraform -chdir=deploy/terraform/azure apply -input=false -auto-approve \
    -var "subscription_id=${SUBSCRIPTION_ID}" \
    -var "location=${AZURE_LOCATION}" \
    -var "cluster_name=${CLUSTER}" \
    -var "acr_name=${ACR_NAME}" \
    -var "dns_prefix=${DNS_PREFIX}"
  ACR_LOGIN_SERVER="$(terraform -chdir=deploy/terraform/azure output -raw acr_login_server)"
  RG_NAME="$(terraform -chdir=deploy/terraform/azure output -raw resource_group_name)"
  log "Image: ${ACR_LOGIN_SERVER}/ai-notes:${TAG}"
  render_azure "${ACR_LOGIN_SERVER}/ai-notes"
  log "Fetching cluster credentials (this switches the current kubectl context)"
  az aks get-credentials --resource-group "$RG_NAME" --name "$CLUSTER" --overwrite-existing
  log "Building ${ACR_LOGIN_SERVER}/ai-notes:${TAG}"
  az acr build --registry "$ACR_NAME" --image "ai-notes:${TAG}" .
  apply_workloads "$stage/azure" service
fi
