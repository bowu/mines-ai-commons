#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/opt/mines-ai/shared/.env"

usage() {
  cat <<USAGE
Usage: $0 [--env-file PATH]

Validates required production environment variables for single-VM deployment.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

missing=0

require_var() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "${value}" ]; then
    echo "Missing required env var: ${name}" >&2
    missing=1
  fi
}

url_host() {
  local raw="${1:-}"
  raw="${raw#https://}"
  raw="${raw#http://}"
  raw="${raw%%/*}"
  printf "%s" "${raw}"
}

required_vars=(
  DATABASE_URL
  SESSION_SECRET
  PUBLIC_URL
  API_CALLBACK_URL
  VM_TOKEN_SECRET
  VM_BOOTSTRAP_SECRET
  GCP_PROJECT_ID
  GCP_ZONE
  VM_SERVICE_ACCOUNT_EMAIL
  SANDBOX_MODE
  LITELLM_PROXY_URL
  LITELLM_PROXY_API_KEY
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  AWS_REGION
  GCE_IMAGE_PROJECT
  AUTH_PROVIDER
  CLOUD_SQL_INSTANCE_CONNECTION_NAME
)

for name in "${required_vars[@]}"; do
  require_var "${name}"
done

if [ -z "${GCE_IMAGE_FAMILY:-}" ] && [ -z "${SANDBOX_EXPECTED_RUNTIME_VERSION:-}" ]; then
  echo "Missing image selector: set GCE_IMAGE_FAMILY or SANDBOX_EXPECTED_RUNTIME_VERSION" >&2
  missing=1
fi

if [ "${SANDBOX_MODE:-}" != "gce" ]; then
  echo "Invalid SANDBOX_MODE: expected 'gce', got '${SANDBOX_MODE:-<unset>}'" >&2
  missing=1
fi

case "${API_CALLBACK_URL:-}" in
  https://*) ;;
  *)
    echo "API_CALLBACK_URL must use https in production, got '${API_CALLBACK_URL:-<unset>}'" >&2
    missing=1
    ;;
esac

case "${PUBLIC_URL:-}" in
  https://*) ;;
  *)
    echo "PUBLIC_URL must use https in production, got '${PUBLIC_URL:-<unset>}'" >&2
    missing=1
    ;;
esac

public_host="$(url_host "${PUBLIC_URL:-}")"
callback_host="$(url_host "${API_CALLBACK_URL:-}")"
if [ -n "${public_host}" ] && [ -n "${callback_host}" ] && [ "${public_host}" != "${callback_host}" ]; then
  if [ "${ALLOW_API_CALLBACK_HOST_MISMATCH:-false}" != "true" ]; then
    echo "API_CALLBACK_URL host ('${callback_host}') must match PUBLIC_URL host ('${public_host}') for single-VM deploys." >&2
    echo "Set PROD_API_CALLBACK_URL=${PUBLIC_URL} when syncing production env, or explicitly set ALLOW_API_CALLBACK_HOST_MISMATCH=true if intentionally different." >&2
    missing=1
  fi
fi

if [ "${AUTH_PROVIDER:-}" != "none" ] && [ "${AUTH_PROVIDER:-}" != "oidc" ] && [ "${AUTH_PROVIDER:-}" != "magic" ]; then
  echo "AUTH_PROVIDER must be 'none', 'oidc', or 'magic', got '${AUTH_PROVIDER:-<unset>}'" >&2
  missing=1
fi

if [ "${AUTH_PROVIDER:-}" = "oidc" ]; then
  require_var OIDC_ISSUER_URL
  require_var OIDC_CLIENT_ID
  require_var OIDC_CLIENT_SECRET
  require_var OIDC_CALLBACK_URL
fi

if [ "${AUTH_PROVIDER:-}" = "magic" ]; then
  require_var SENDGRID_API_KEY
  require_var AUTH_MAGIC_FROM_EMAIL
  # Optional override; when absent the app falls back to SESSION_SECRET.
  # AUTH_MAGIC_LINK_SECRET
fi

if [ -z "${GCP_SERVICE_ACCOUNT_KEY:-}" ]; then
  if ! curl -fsS -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email" >/dev/null 2>&1; then
    echo "Missing GCP identity: set GCP_SERVICE_ACCOUNT_KEY or run on a VM with an attached service account" >&2
    missing=1
  fi
fi

if [ "${missing}" -ne 0 ]; then
  echo "Environment validation failed" >&2
  exit 1
fi

echo "Environment validation passed"
