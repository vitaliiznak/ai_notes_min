# Shared by gke.sh and tf.sh, which source it. Does not rotate an existing ai-notes secret
# (that password is the database password).
set -euo pipefail

log() { printf '%s\n' "$*" >&2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REGION="${REGION:-europe-west1}"
REPO="${REPO:-ai-notes}"
CLUSTER="${CLUSTER:-ai-notes}"
NAMESPACE="${NAMESPACE:-ai-notes}"
# A repository with no commits yet has no HEAD. A timestamp still gives the build a unique tag.
TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# Sets DRY_RUN from an optional --dry-run flag. Anything else prints USAGE.
parse_dry_run() {
  DRY_RUN=0
  case "${1:-}" in
    "") ;;
    --dry-run) DRY_RUN=1 ;;
    *) log "$USAGE"; exit 2 ;;
  esac
}

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

# AI_PROVIDER and OPENAI_API_KEY from the environment, else from .env. A dry run needs no key.
load_ai_settings() {
  AI_PROVIDER="${AI_PROVIDER:-$(dotenv_get AI_PROVIDER)}"
  AI_PROVIDER="${AI_PROVIDER:-openai}"
  if [[ "$AI_PROVIDER" != "openai" && "$AI_PROVIDER" != "fake" ]]; then
    log "AI_PROVIDER must be openai or fake."
    exit 1
  fi
  if [[ "$DRY_RUN" -eq 1 || "$AI_PROVIDER" == "fake" ]]; then return 0; fi
  OPENAI_API_KEY="${OPENAI_API_KEY:-$(dotenv_get OPENAI_API_KEY)}"
  if [[ -z "$OPENAI_API_KEY" ]]; then
    log "OPENAI_API_KEY is required when AI_PROVIDER=openai. Export it, put it in .env, or run with AI_PROVIDER=fake."
    exit 1
  fi
}

# Copies a bundle (deploy/k8s, or the deploy/k8s/azure overlay) into $stage next to the shared
# manifests, and points it at this namespace, image and AI provider.
stage_bundle() {
  local bundle="$1" image_repo="$2"
  cp deploy/k8s/namespace.yaml deploy/k8s/postgres.yaml deploy/k8s/app.yaml "$bundle"/*.yaml "$stage/"
  sed -i.bak \
    -e "s|^namespace: .*|namespace: ${NAMESPACE}|" \
    -e "s|^    newName: .*|    newName: ${image_repo}|" \
    -e "s|^    newTag: .*|    newTag: \"${TAG}\"|" \
    "$stage/kustomization.yaml"
  if [[ "$AI_PROVIDER" == "fake" ]]; then
    sed -i.bak 's/AI_PROVIDER: openai/AI_PROVIDER: fake/' "$stage/app.yaml"
  fi
  rm "$stage"/*.bak
}

# Creates the secret on the first run, applies the staged bundle and waits for it.
# $1 is what carries the public address: ingress or svc.
apply_bundle() {
  kubectl apply -f deploy/k8s/namespace.yaml
  if kubectl -n "$NAMESPACE" get secret ai-notes >/dev/null 2>&1; then
    log "Secret ${NAMESPACE}/ai-notes already exists; leaving the database password as it is."
  else
    local password
    password="$(openssl rand -hex 24)"
    local args=(--from-literal="POSTGRES_PASSWORD=${password}")
    if [[ "$AI_PROVIDER" == "openai" ]]; then
      args+=(--from-literal="OPENAI_API_KEY=${OPENAI_API_KEY}")
    fi
    kubectl -n "$NAMESPACE" create secret generic ai-notes "${args[@]}"
  fi
  kubectl apply -k "$stage"
  kubectl -n "$NAMESPACE" rollout status deploy/ai-notes --timeout=600s
  log ""
  kubectl -n "$NAMESPACE" get "$1" ai-notes
  log "The address appears after a few minutes. Open http://<address>."
}
