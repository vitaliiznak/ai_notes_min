#!/usr/bin/env bash
# Create the cluster and registry with Terraform, build the image, and apply the matching bundle.
# gcp: GKE Autopilot + Artifact Registry, then deploy/k8s (GCE Ingress).
# azure: AKS + Container Registry, then deploy/k8s/azure (Azure load balancer).
# Does not put the API key in Terraform state.
source "$(dirname "$0")/common.sh"

USAGE="Usage: ./deploy/tf.sh gcp|azure [--dry-run]"
CLOUD="${1:-}"
case "$CLOUD" in
  gcp | azure) ;;
  *) log "$USAGE"; exit 2 ;;
esac
parse_dry_run "${2:-}"

command -v terraform >/dev/null || { log "terraform is required."; exit 1; }
command -v kubectl >/dev/null || { log "kubectl is required."; exit 1; }

AZURE_LOCATION="${AZURE_LOCATION:-westeurope}"
load_ai_settings

short_hash() {
  if command -v shasum >/dev/null; then
    printf '%s' "$1" | shasum -a 256 | awk '{print substr($1, 1, 8)}'
  else
    printf '%s' "$1" | sha256sum | awk '{print substr($1, 1, 8)}'
  fi
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
  stage_bundle deploy/k8s "$IMAGE_REPO"
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
  apply_bundle ingress
else
  command -v az >/dev/null || { log "az is required for azure."; exit 1; }
  if [[ "$DRY_RUN" -eq 1 ]]; then
    ACR_LOGIN_SERVER="${ACR_LOGIN_SERVER:-example.azurecr.io}"
    log "Cloud:    azure"
    log "Location: ${AZURE_LOCATION}"
    log "Image:    ${ACR_LOGIN_SERVER}/ai-notes:${TAG}"
    log "Provider: ${AI_PROVIDER}"
    stage_bundle deploy/k8s/azure "${ACR_LOGIN_SERVER}/ai-notes"
    log "Validating deploy/terraform/azure"
    terraform -chdir=deploy/terraform/azure init -backend=false -input=false
    terraform -chdir=deploy/terraform/azure validate
    kubectl kustomize "$stage"
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
  stage_bundle deploy/k8s/azure "${ACR_LOGIN_SERVER}/ai-notes"
  log "Fetching cluster credentials (this switches the current kubectl context)"
  az aks get-credentials --resource-group "$RG_NAME" --name "$CLUSTER" --overwrite-existing
  log "Building ${ACR_LOGIN_SERVER}/ai-notes:${TAG}"
  az acr build --registry "$ACR_NAME" --image "ai-notes:${TAG}" .
  apply_bundle svc
fi
