#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is required" >&2
  exit 1
fi

GCP_PROJECT_ID="${GCP_PROJECT_ID:-}"
GCP_ZONE="${GCP_ZONE:-}"
BASE_VERSION="${1:-${BASE_VERSION:-}}"
UBUNTU_BASE_IMAGE_PROJECT="${UBUNTU_BASE_IMAGE_PROJECT:-ubuntu-os-cloud}"
UBUNTU_BASE_IMAGE_FAMILY="${UBUNTU_BASE_IMAGE_FAMILY:-ubuntu-2204-lts}"
BASE_IMAGE_FAMILY="${BASE_IMAGE_FAMILY:-mines-sandbox-base}"
IMAGE_PREFIX="${IMAGE_PREFIX:-mines-sandbox-base}"
BUILDER_MACHINE_TYPE="${BUILDER_MACHINE_TYPE:-e2-standard-2}"
SMOKE_MACHINE_TYPE="${SMOKE_MACHINE_TYPE:-e2-small}"
SMOKE_TEST="${SMOKE_TEST:-true}"

if [[ -z "${GCP_PROJECT_ID}" || -z "${GCP_ZONE}" ]]; then
  echo "GCP_PROJECT_ID and GCP_ZONE are required" >&2
  exit 1
fi

if [[ -z "${BASE_VERSION}" ]]; then
  echo "Base version is required. Pass as arg1 or BASE_VERSION env." >&2
  exit 1
fi

if [[ ! "${BASE_VERSION}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Base version '${BASE_VERSION}' contains unsupported characters" >&2
  exit 1
fi

sanitize_base_label() {
  echo "${1}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//'
}

base_label="$(sanitize_base_label "${BASE_VERSION}")"
if [[ -z "${base_label}" ]]; then
  echo "Base version '${BASE_VERSION}' cannot be converted to a valid label" >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%d%H%M%S)"
builder_name="${IMAGE_PREFIX}-builder-${timestamp}"
image_name="${IMAGE_PREFIX}-${base_label}-${timestamp}"
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

echo "Creating base builder VM ${builder_name}..."
gcloud compute instances create "${builder_name}" \
  --project "${GCP_PROJECT_ID}" \
  --zone "${GCP_ZONE}" \
  --machine-type "${BUILDER_MACHINE_TYPE}" \
  --image-project "${UBUNTU_BASE_IMAGE_PROJECT}" \
  --image-family "${UBUNTU_BASE_IMAGE_FAMILY}" \
  --boot-disk-size "30GB" \
  --quiet
builder_created=true

echo "Waiting for base builder SSH..."
if ! wait_for_ssh "${builder_name}" 40 10; then
  echo "Base builder VM did not become reachable over SSH in time" >&2
  exit 1
fi

echo "Installing base tooling into builder disk..."
gcloud compute ssh "${builder_name}" \
  --project "${GCP_PROJECT_ID}" \
  --zone "${GCP_ZONE}" \
  --quiet \
  --command "
set -euo pipefail
NODE_VERSION=v22.19.0
BASE_VERSION='${BASE_VERSION}'

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v22\\.'; then
  curl -fsSL \"https://nodejs.org/dist/\${NODE_VERSION}/node-\${NODE_VERSION}-linux-x64.tar.xz\" -o /tmp/node-runtime.tar.xz
  sudo mkdir -p /opt/node-runtime
  sudo tar -xJf /tmp/node-runtime.tar.xz --strip-components=1 -C /opt/node-runtime
  sudo ln -sf /opt/node-runtime/bin/node /usr/local/bin/node
  sudo ln -sf /opt/node-runtime/bin/npm /usr/local/bin/npm
fi

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  python3-pip \
  python3-venv \
  build-essential \
  cmake \
  pkg-config \
  ripgrep \
  fd-find \
  sqlite3 \
  pandoc \
  texlive-latex-base \
  texlive-latex-extra \
  latexmk \
  biber \
  graphviz \
  ffmpeg \
  imagemagick \
  python3-numpy \
  python3-pandas \
  python3-scipy \
  python3-matplotlib \
  python3-seaborn \
  python3-sklearn \
  python3-statsmodels \
  python3-sympy \
  nvidia-cuda-toolkit

NVIDIA_UTILS_PKG=''
for candidate in nvidia-utils-550 nvidia-utils-545 nvidia-utils-535 nvidia-utils-530 nvidia-utils-525; do
  if apt-cache show \"\${candidate}\" >/dev/null 2>&1; then
    NVIDIA_UTILS_PKG=\"\${candidate}\"
    break
  fi
done
if [[ -z \"\${NVIDIA_UTILS_PKG}\" ]]; then
  echo 'No supported nvidia-utils package found in apt repositories' >&2
  exit 1
fi
sudo apt-get install -y --no-install-recommends \"\${NVIDIA_UTILS_PKG}\"

if [ -x /usr/bin/fdfind ] && [ ! -x /usr/local/bin/fd ]; then
  sudo ln -sf /usr/bin/fdfind /usr/local/bin/fd
fi

PIP_BREAK_FLAG=''
if python3 -m pip help install 2>/dev/null | grep -q -- '--break-system-packages'; then
  PIP_BREAK_FLAG='--break-system-packages'
fi
sudo python3 -m pip install --no-cache-dir \${PIP_BREAK_FLAG} \
  torch \
  xgboost \
  lightgbm

sudo mkdir -p /opt/mines-ai /workspace /workspace/.npm-global /workspace/.py-user /workspace/.cache/pip /workspace/.mines
printf '%s\\n' \"\${BASE_VERSION}\" | sudo tee /opt/mines-ai/base-version >/dev/null

sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/*
"

echo "Stopping base builder VM..."
gcloud compute instances stop "${builder_name}" \
  --project "${GCP_PROJECT_ID}" \
  --zone "${GCP_ZONE}" \
  --quiet

echo "Creating candidate base image ${image_name}..."
gcloud compute images create "${image_name}" \
  --project "${GCP_PROJECT_ID}" \
  --source-disk "${builder_name}" \
  --source-disk-zone "${GCP_ZONE}" \
  --family "${BASE_IMAGE_FAMILY}" \
  --labels "managed_by=mines_ai,image_type=base,state=candidate,base_version=${base_label}" \
  --quiet

if [[ "${SMOKE_TEST}" == "true" ]]; then
  echo "Running base smoke test boot on ${image_name}..."
  gcloud compute instances create "${smoke_name}" \
    --project "${GCP_PROJECT_ID}" \
    --zone "${GCP_ZONE}" \
    --machine-type "${SMOKE_MACHINE_TYPE}" \
    --image-project "${GCP_PROJECT_ID}" \
    --image "${image_name}" \
    --quiet
  smoke_created=true

  if ! wait_for_ssh "${smoke_name}" 30 10; then
    echo "Base smoke VM did not become reachable over SSH in time" >&2
    exit 1
  fi

  gcloud compute scp scripts/gcp/validate-sandbox-base-image.sh "${smoke_name}:/tmp/validate-sandbox-base-image.sh" \
    --project "${GCP_PROJECT_ID}" \
    --zone "${GCP_ZONE}" \
    --quiet

  gcloud compute ssh "${smoke_name}" \
    --project "${GCP_PROJECT_ID}" \
    --zone "${GCP_ZONE}" \
    --quiet \
    --command "chmod +x /tmp/validate-sandbox-base-image.sh && /tmp/validate-sandbox-base-image.sh '${BASE_VERSION}'"
fi

echo "Built sandbox base image: ${image_name}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "image_name=${image_name}" >>"${GITHUB_OUTPUT}"
  echo "base_version=${BASE_VERSION}" >>"${GITHUB_OUTPUT}"
fi
