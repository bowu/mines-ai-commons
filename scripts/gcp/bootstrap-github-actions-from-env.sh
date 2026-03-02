#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env}"
REPO="${2:-}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Env file not found: ${ENV_FILE}" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required" >&2
  exit 1
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

if [[ -z "${REPO}" ]]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
fi

if [[ -z "${REPO}" ]]; then
  echo "Could not resolve GitHub repository. Pass explicit arg2: owner/repo" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

set_var_if_set() {
  local name="$1"
  local value="${2:-}"
  if [[ -n "${value}" ]]; then
    gh variable set "${name}" --repo "${REPO}" --body "${value}"
    echo "Set variable ${name}"
  fi
}

set_secret_if_set() {
  local name="$1"
  local value="${2:-}"
  if [[ -n "${value}" ]]; then
    printf '%s' "${value}" | gh secret set "${name}" --repo "${REPO}" --body -
    echo "Set secret ${name}"
  fi
}

extract_service_account_email_from_json() {
  local json="$1"
  node --input-type=module -e '
const raw = process.argv[1] || "";
if (!raw) process.exit(0);
try {
  const parsed = JSON.parse(raw);
  process.stdout.write(String(parsed.client_email || ""));
} catch {
  process.exit(0);
}
' "${json}"
}

set_var_if_set "GCP_PROJECT_ID" "${GCP_PROJECT_ID:-}"
set_var_if_set "GCP_ZONE" "${GCP_ZONE:-}"
set_var_if_set "BASE_IMAGE_PROJECT" "${GCE_IMAGE_PROJECT:-}"
set_var_if_set "BASE_IMAGE_FAMILY" "${GCE_IMAGE_FAMILY:-}"
set_var_if_set "SANDBOX_BASE_IMAGE_PROJECT" "${SANDBOX_BASE_IMAGE_PROJECT:-${GCP_PROJECT_ID:-}}"
set_var_if_set "SANDBOX_BASE_IMAGE_FAMILY" "${SANDBOX_BASE_IMAGE_FAMILY:-mines-sandbox-base}"
set_var_if_set "SANDBOX_IMAGE_FAMILY" "${SANDBOX_IMAGE_FAMILY:-mines-sandbox-runtime}"

set_secret_if_set "GCP_SERVICE_ACCOUNT_KEY" "${GCP_SERVICE_ACCOUNT_KEY:-}"

if [[ -n "${GCP_SERVICE_ACCOUNT_KEY:-}" ]]; then
  sa_email="$(extract_service_account_email_from_json "${GCP_SERVICE_ACCOUNT_KEY:-}")"
  set_secret_if_set "GCP_SERVICE_ACCOUNT" "${sa_email}"
fi

set_secret_if_set "GCP_WORKLOAD_IDENTITY_PROVIDER" "${GCP_WORKLOAD_IDENTITY_PROVIDER:-}"

echo
echo "GitHub Actions GCP bootstrap complete for ${REPO}"
echo "Auth mode preference: service account key secret (GCP_SERVICE_ACCOUNT_KEY)"
