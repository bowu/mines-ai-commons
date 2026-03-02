#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=".env"
ENVIRONMENT="production"
SECRET_NAME="PROD_APP_ENV"
REPO=""
DRY_RUN=0

usage() {
  cat <<USAGE
Usage: $0 [--env-file PATH] [--environment NAME] [--secret-name NAME] [--repo OWNER/REPO] [--dry-run]

Reads selected keys from a local .env file and updates a GitHub environment secret
with the rendered runtime env file content.

Example:
  $0 --env-file .env --environment production --secret-name PROD_APP_ENV
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --environment)
      ENVIRONMENT="${2:-}"
      shift 2
      ;;
    --secret-name)
      SECRET_NAME="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift 1
      ;;
    --)
      shift 1
      continue
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

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required" >&2
  exit 1
fi

if [ -z "${REPO}" ]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
fi

if [ -z "${REPO}" ]; then
  echo "Could not determine repo. Pass --repo OWNER/REPO." >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

read_env_line() {
  local key="$1"
  grep -E "^${key}=" "${ENV_FILE}" | tail -n 1 || true
}

require_line() {
  local key="$1"
  local line
  line="$(read_env_line "${key}")"
  if [ -z "${line}" ]; then
    echo "Missing required key in ${ENV_FILE}: ${key}" >&2
    exit 1
  fi
}

line_to_value() {
  local line="$1"
  local value="${line#*=}"
  value="${value%$'\r'}"
  if [[ "${value}" =~ ^\".*\"$ ]]; then
    value="${value#\"}"
    value="${value%\"}"
  elif [[ "${value}" =~ ^\'.*\'$ ]]; then
    value="${value#\'}"
    value="${value%\'}"
  fi
  printf "%s" "${value}"
}

append_key_if_present() {
  local key="$1"
  local line
  line="$(read_env_line "${key}")"
  if [ -n "${line}" ]; then
    printf "%s\n" "${line}" >> "${RENDERED_FILE}"
  fi
}

append_database_url() {
  local line
  line="$(read_env_line "PROD_DATABASE_URL")"
  if [ -n "${line}" ]; then
    printf "DATABASE_URL=%s\n" "$(line_to_value "${line}")" >> "${RENDERED_FILE}"
    return 0
  fi
  append_key_if_present "DATABASE_URL"
}

append_public_url() {
  local line
  line="$(read_env_line "PROD_PUBLIC_URL")"
  if [ -n "${line}" ]; then
    printf "PUBLIC_URL=%s\n" "$(line_to_value "${line}")" >> "${RENDERED_FILE}"
    return 0
  fi
  append_key_if_present "PUBLIC_URL"
}

append_api_callback_url() {
  local line
  line="$(read_env_line "PROD_API_CALLBACK_URL")"
  if [ -n "${line}" ]; then
    printf "API_CALLBACK_URL=%s\n" "$(line_to_value "${line}")" >> "${RENDERED_FILE}"
    return 0
  fi

  line="$(read_env_line "PROD_PUBLIC_URL")"
  if [ -n "${line}" ]; then
    printf "API_CALLBACK_URL=%s\n" "$(line_to_value "${line}")" >> "${RENDERED_FILE}"
    return 0
  fi

  line="$(read_env_line "PUBLIC_URL")"
  if [ -n "${line}" ]; then
    printf "API_CALLBACK_URL=%s\n" "$(line_to_value "${line}")" >> "${RENDERED_FILE}"
    return 0
  fi
}

require_line "DATABASE_URL"
require_line "SESSION_SECRET"
if [ -z "$(read_env_line "PUBLIC_URL")" ] && [ -z "$(read_env_line "PROD_PUBLIC_URL")" ]; then
  echo "Missing PUBLIC_URL in ${ENV_FILE}: set PUBLIC_URL or PROD_PUBLIC_URL" >&2
  exit 1
fi
if [ -z "$(read_env_line "PROD_API_CALLBACK_URL")" ] && [ -z "$(read_env_line "PROD_PUBLIC_URL")" ] && [ -z "$(read_env_line "PUBLIC_URL")" ]; then
  echo "Missing API callback source in ${ENV_FILE}: set PROD_API_CALLBACK_URL, PROD_PUBLIC_URL, or PUBLIC_URL" >&2
  exit 1
fi
require_line "VM_TOKEN_SECRET"
require_line "VM_BOOTSTRAP_SECRET"
require_line "GCP_PROJECT_ID"
require_line "GCP_ZONE"
require_line "VM_SERVICE_ACCOUNT_EMAIL"
require_line "SANDBOX_MODE"
require_line "GCE_IMAGE_PROJECT"
require_line "AUTH_PROVIDER"
require_line "CLOUD_SQL_INSTANCE_CONNECTION_NAME"

if [ -z "$(read_env_line "GCE_IMAGE_FAMILY")" ] && [ -z "$(read_env_line "SANDBOX_EXPECTED_RUNTIME_VERSION")" ]; then
  echo "Missing image selector in ${ENV_FILE}: set GCE_IMAGE_FAMILY or SANDBOX_EXPECTED_RUNTIME_VERSION" >&2
  exit 1
fi

auth_provider_line="$(read_env_line "AUTH_PROVIDER")"
auth_provider="$(line_to_value "${auth_provider_line}" | tr '[:upper:]' '[:lower:]')"
case "${auth_provider}" in
  magic)
    require_line "SENDGRID_API_KEY"
    require_line "AUTH_MAGIC_FROM_EMAIL"
    ;;
  oidc)
    require_line "OIDC_ISSUER_URL"
    require_line "OIDC_CLIENT_ID"
    require_line "OIDC_CLIENT_SECRET"
    require_line "OIDC_CALLBACK_URL"
    ;;
  none)
    ;;
  *)
    echo "Invalid AUTH_PROVIDER value in ${ENV_FILE}: ${auth_provider}" >&2
    exit 1
    ;;
esac

umask 077
RENDERED_FILE="$(mktemp)"
cleanup() {
  rm -f "${RENDERED_FILE}"
}
trap cleanup EXIT

KEYS=(
  APP_DATABASE_URL
  VM_INTERNAL_DATABASE_URL
  AUTH_BOOTSTRAP_DATABASE_URL
  CLOUD_SQL_INSTANCE_CONNECTION_NAME
  SESSION_SECRET
  CORS_ORIGINS
  AUTH_PROVIDER
  AUTH_EMAIL_WHITELIST
  DEFAULT_USER_EMAIL
  DEFAULT_USER_NAME
  DEFAULT_ORG_SLUG
  SENDGRID_API_KEY
  AUTH_MAGIC_FROM_EMAIL
  AUTH_MAGIC_LINK_SECRET
  AUTH_MAGIC_LINK_TTL_MS
  AUTH_MAGIC_REQUEST_RATE_LIMIT_WINDOW_MS
  AUTH_MAGIC_REQUEST_RATE_LIMIT_MAX
  AUTH_MAGIC_VERIFY_RATE_LIMIT_WINDOW_MS
  AUTH_MAGIC_VERIFY_RATE_LIMIT_MAX
  OIDC_ISSUER_URL
  OIDC_CLIENT_ID
  OIDC_CLIENT_SECRET
  OIDC_CALLBACK_URL
  AGENT_CREATE_RATE_LIMIT_WINDOW_MS
  AGENT_CREATE_RATE_LIMIT_MAX
  AGENT_CHAT_RATE_LIMIT_WINDOW_MS
  AGENT_CHAT_RATE_LIMIT_MAX
  SANDBOX_MODE
  SANDBOX_LOCAL_URL
  VM_TOKEN_SECRET
  VM_BOOTSTRAP_SECRET
  GCP_PROJECT_ID
  GCP_ZONE
  GCP_SERVICE_ACCOUNT_KEY
  GCE_IMAGE_PROJECT
  GCE_IMAGE_FAMILY
  SANDBOX_EXPECTED_RUNTIME_VERSION
  GCE_MACHINE_TYPE
  GCE_NETWORK
  GCE_SUBNETWORK
  GCE_BOOT_DISK_SIZE_GB
  GCE_DATA_DISK_SIZE_GB
  GCE_USE_EXTERNAL_IP
  GCE_ORPHAN_MAX_AGE_MS
  VM_SERVICE_ACCOUNT_EMAIL
  SANDBOX_HEALTH_PROBE_TIMEOUT_MS
  SANDBOX_READY_RETRY_AFTER_MS
  SANDBOX_IDLE_POLL_INTERVAL_MS
  SANDBOX_IDLE_CPU_MS
  SANDBOX_ACTIVITY_TOUCH_MIN_INTERVAL_MS
  SANDBOX_STREAM_LEASE_REFRESH_MS
  SANDBOX_STREAM_LEASE_TTL_MS
  SANDBOX_RECONCILE_DB_QUERY_TIMEOUT_MS
  SANDBOX_GCE_OPERATION_TIMEOUT_MS
  SANDBOX_STARTUP_GRACE_MS
  PI_AGENT_MAX_RUNTIME_MS
  SANDBOX_WAKE_TRACE_LOGS
  SANDBOX_WAKE_TRACE_AGENT_IDS
  SANDBOX_WAKE_TRACE_FILE_PATH
  SANDBOX_WAKE_TRACE_CONSOLE
  LITELLM_PROXY_URL
  LITELLM_PROXY_API_KEY
  GEMINI_API_KEY
  OPENAI_API_KEY
  LITELLM_MODEL_GEMINI
  LITELLM_MODEL_SONNET
  LITELLM_MODEL_OPUS
  LITELLM_MODEL_GPT
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  AWS_REGION
  BRAVE_API_KEY
)

append_database_url
append_public_url
append_api_callback_url

for key in "${KEYS[@]}"; do
  append_key_if_present "${key}"
done

if [ ! -s "${RENDERED_FILE}" ]; then
  echo "Rendered env output is empty; refusing to update ${SECRET_NAME}" >&2
  exit 1
fi

if [ "${DRY_RUN}" -eq 1 ]; then
  line_count="$(wc -l < "${RENDERED_FILE}" | tr -d '[:space:]')"
  key_count="$(cut -d= -f1 < "${RENDERED_FILE}" | sort -u | wc -l | tr -d '[:space:]')"
  echo "Dry run: rendered ${line_count} env lines (${key_count} unique keys) for ${SECRET_NAME} in ${REPO} environment ${ENVIRONMENT}"
  echo "Rendered keys:"
  cut -d= -f1 < "${RENDERED_FILE}" | sed 's/^/- /'
  exit 0
fi

gh secret set "${SECRET_NAME}" \
  --env "${ENVIRONMENT}" \
  --repo "${REPO}" \
  < "${RENDERED_FILE}"

echo "Updated ${SECRET_NAME} in ${REPO} environment ${ENVIRONMENT} from ${ENV_FILE}"
