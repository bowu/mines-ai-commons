#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is required" >&2
  exit 1
fi

GCP_PROJECT_ID="${GCP_PROJECT_ID:-}"
GCP_ZONE="${GCP_ZONE:-}"
RUNTIME_VERSION="${1:-${RUNTIME_VERSION:-}}"
ARCHIVE_PATH="${2:-${ARCHIVE_PATH:-sandbox-runtime.tar.gz}}"
SANDBOX_BASE_IMAGE_PROJECT="${SANDBOX_BASE_IMAGE_PROJECT:-${GCP_PROJECT_ID}}"
BASE_IMAGE_NAME="${BASE_IMAGE_NAME:-}"
IMAGE_FAMILY="${IMAGE_FAMILY:-mines-sandbox-runtime}"
IMAGE_PREFIX="${IMAGE_PREFIX:-mines-sandbox}"
BUILDER_MACHINE_TYPE="${BUILDER_MACHINE_TYPE:-e2-standard-2}"
SMOKE_MACHINE_TYPE="${SMOKE_MACHINE_TYPE:-e2-small}"
SMOKE_TEST="${SMOKE_TEST:-true}"

if [[ -z "${GCP_PROJECT_ID}" || -z "${GCP_ZONE}" ]]; then
  echo "GCP_PROJECT_ID and GCP_ZONE are required" >&2
  exit 1
fi

if [[ -z "${SANDBOX_BASE_IMAGE_PROJECT}" ]]; then
  echo "SANDBOX_BASE_IMAGE_PROJECT is required" >&2
  exit 1
fi

if [[ -z "${RUNTIME_VERSION}" ]]; then
  echo "Runtime version is required. Pass as arg1 or RUNTIME_VERSION env." >&2
  exit 1
fi

if [[ ! -f "${ARCHIVE_PATH}" ]]; then
  echo "Runtime archive not found: ${ARCHIVE_PATH}" >&2
  exit 1
fi

sanitize_runtime_label() {
  echo "${1}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//'
}

runtime_label="$(sanitize_runtime_label "${RUNTIME_VERSION}")"
if [[ -z "${runtime_label}" ]]; then
  echo "Runtime version '${RUNTIME_VERSION}' cannot be converted to a valid label" >&2
  exit 1
fi

if [[ -z "${BASE_IMAGE_NAME}" ]]; then
  BASE_IMAGE_NAME="$({
    gcloud compute images list \
      --project "${SANDBOX_BASE_IMAGE_PROJECT}" \
      --filter "labels.managed_by=mines_ai AND labels.image_type=base AND labels.state=promoted" \
      --sort-by="~creationTimestamp" \
      --limit 1 \
      --format "value(name)";
  })"
fi

if [[ -z "${BASE_IMAGE_NAME}" ]]; then
  echo "No promoted base image found in project ${SANDBOX_BASE_IMAGE_PROJECT}. Build and promote a base image first." >&2
  exit 1
fi

base_image_version="$({
  gcloud compute images describe "${BASE_IMAGE_NAME}" \
    --project "${SANDBOX_BASE_IMAGE_PROJECT}" \
    --format "value(labels.base_version)" || true;
})"

echo "Using promoted base image ${BASE_IMAGE_NAME} (base_version=${base_image_version:-unknown})"

timestamp="$(date -u +%Y%m%d%H%M%S)"
builder_name="${IMAGE_PREFIX}-builder-${timestamp}"
image_name="${IMAGE_PREFIX}-${runtime_label}-${timestamp}"
smoke_name="${IMAGE_PREFIX}-smoke-${timestamp}"

builder_created=false
smoke_created=false

cleanup() {
  if [[ "${smoke_created}" == "true" ]]; then
    gcloud compute instances delete "${smoke_name}" \
      --project "${GCP_PROJECT_ID}" \
      --zone "${GCP_ZONE}" \
      --quiet >/dev/null 2>&1 || true
  fi

  if [[ "${builder_created}" == "true" ]]; then
    gcloud compute instances delete "${builder_name}" \
      --project "${GCP_PROJECT_ID}" \
      --zone "${GCP_ZONE}" \
      --quiet >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_for_ssh() {
  local instance="$1"
  local attempts="${2:-30}"
  local delay_seconds="${3:-10}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if gcloud compute ssh "${instance}" \
      --project "${GCP_PROJECT_ID}" \
      --zone "${GCP_ZONE}" \
      --command "echo ready" \
      --quiet >/dev/null 2>&1; then
      return 0
    fi
    sleep "${delay_seconds}"
  done
  return 1
}

echo "Creating builder VM ${builder_name} from base image ${BASE_IMAGE_NAME}..."
gcloud compute instances create "${builder_name}" \
  --project "${GCP_PROJECT_ID}" \
  --zone "${GCP_ZONE}" \
  --machine-type "${BUILDER_MACHINE_TYPE}" \
  --image-project "${SANDBOX_BASE_IMAGE_PROJECT}" \
  --image "${BASE_IMAGE_NAME}" \
  --boot-disk-size "30GB" \
  --quiet
builder_created=true

echo "Waiting for builder SSH..."
if ! wait_for_ssh "${builder_name}" 40 10; then
  echo "Builder VM did not become reachable over SSH in time" >&2
  exit 1
fi

echo "Uploading runtime archive..."
gcloud compute scp "${ARCHIVE_PATH}" "${builder_name}:/tmp/sandbox-runtime.tar.gz" \
  --project "${GCP_PROJECT_ID}" \
  --zone "${GCP_ZONE}" \
  --quiet

echo "Installing sandbox runtime into builder disk..."
gcloud compute ssh "${builder_name}" \
  --project "${GCP_PROJECT_ID}" \
  --zone "${GCP_ZONE}" \
  --quiet \
  --command '
set -euo pipefail
RUNTIME_DIR=/opt/mines-ai/sandbox

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "^v22\\."; then
  echo "Base image missing required Node.js v22 runtime" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Base image missing npm" >&2
  exit 1
fi

sudo rm -rf "${RUNTIME_DIR}"
sudo mkdir -p "${RUNTIME_DIR}"
sudo tar -xzf /tmp/sandbox-runtime.tar.gz -C "${RUNTIME_DIR}"
cd "${RUNTIME_DIR}"
sudo npm install --omit=dev --no-audit --no-fund
'

echo "Stopping builder VM..."
gcloud compute instances stop "${builder_name}" \
  --project "${GCP_PROJECT_ID}" \
  --zone "${GCP_ZONE}" \
  --quiet

echo "Creating candidate image ${image_name}..."
gcloud compute images create "${image_name}" \
  --project "${GCP_PROJECT_ID}" \
  --source-disk "${builder_name}" \
  --source-disk-zone "${GCP_ZONE}" \
  --family "${IMAGE_FAMILY}" \
  --labels "managed_by=mines_ai,image_type=runtime,state=candidate,runtime_version=${runtime_label}" \
  --quiet

if [[ "${SMOKE_TEST}" == "true" ]]; then
  echo "Running smoke test boot on ${image_name}..."
  gcloud compute instances create "${smoke_name}" \
    --project "${GCP_PROJECT_ID}" \
    --zone "${GCP_ZONE}" \
    --machine-type "${SMOKE_MACHINE_TYPE}" \
    --image-project "${GCP_PROJECT_ID}" \
    --image "${image_name}" \
    --quiet
  smoke_created=true

  if ! wait_for_ssh "${smoke_name}" 30 10; then
    echo "Smoke VM did not become reachable over SSH in time" >&2
    exit 1
  fi

  gcloud compute scp scripts/gcp/validate-sandbox-image.sh "${smoke_name}:/tmp/validate-sandbox-image.sh" \
    --project "${GCP_PROJECT_ID}" \
    --zone "${GCP_ZONE}" \
    --quiet

  gcloud compute ssh "${smoke_name}" \
    --project "${GCP_PROJECT_ID}" \
    --zone "${GCP_ZONE}" \
    --quiet \
    --command "chmod +x /tmp/validate-sandbox-image.sh && /tmp/validate-sandbox-image.sh '${RUNTIME_VERSION}'"
fi

echo "Built sandbox image: ${image_name}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "image_name=${image_name}" >>"${GITHUB_OUTPUT}"
  echo "runtime_version=${RUNTIME_VERSION}" >>"${GITHUB_OUTPUT}"
fi
