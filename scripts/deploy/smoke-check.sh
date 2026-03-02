#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/opt/mines-ai/shared/.env"
JOURNAL_WINDOW="15 minutes ago"
DOMAIN=""

usage() {
  cat <<USAGE
Usage: $0 [--env-file PATH] [--domain DOMAIN] [--journal-window '15 minutes ago']

Runs post-deploy health checks for the single-VM runtime.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --journal-window)
      JOURNAL_WINDOW="${2:-}"
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

"${SCRIPT_DIR}/validate-env.sh" --env-file "${ENV_FILE}"

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [ -z "${DOMAIN}" ]; then
  DOMAIN="${API_CALLBACK_URL#https://}"
  DOMAIN="${DOMAIN%%/*}"
fi

assert_active() {
  local service="$1"
  local attempts=20
  local delay_seconds=1
  local i=1
  while [ "${i}" -le "${attempts}" ]; do
    if systemctl is-active --quiet "${service}"; then
      return 0
    fi
    sleep "${delay_seconds}"
    i=$((i + 1))
  done
  echo "Service is not active: ${service}" >&2
  systemctl status --no-pager "${service}" || true
  exit 1
}

assert_active cloud-sql-proxy
assert_active litellm-proxy
assert_active mines-ai-api
assert_active caddy

curl_check_local() {
  local url="$1"
  curl --silent --show-error --fail \
    --retry 60 \
    --retry-delay 1 \
    --retry-connrefused \
    --max-time 5 \
    "${url}" >/dev/null
}

curl_check_external() {
  local url="$1"
  curl --silent --show-error --fail \
    --retry 6 \
    --retry-delay 2 \
    --retry-connrefused \
    --max-time 20 \
    "${url}" >/dev/null
}

curl_check_local "http://127.0.0.1:3001/api/health"
curl --silent --show-error --fail \
  --retry 30 \
  --retry-delay 1 \
  --retry-connrefused \
  --max-time 5 \
  -H "Authorization: Bearer ${LITELLM_PROXY_API_KEY}" \
  "http://127.0.0.1:4000/v1/models" >/tmp/mines-ai-litellm-models.json
for model in gemini-3.1-pro sonnet-4.6 opus-4.6 gpt-5.2; do
  if ! jq -e --arg model "${model}" '.data[] | select(.id == $model)' /tmp/mines-ai-litellm-models.json >/dev/null; then
    echo "LiteLLM proxy missing required model alias: ${model}" >&2
    exit 1
  fi
done
curl_check_external "https://${DOMAIN}/"
curl_check_external "https://${DOMAIN}/api/health"

if journalctl -u mines-ai-api -u cloud-sql-proxy -u litellm-proxy --since "${JOURNAL_WINDOW}" --no-pager | \
  grep -E "Missing required environment variable|Environment validation failed|GCE mode requires|is not valid JSON|failed to connect to instance|Invalid instance connection name|refresh token|permission denied" >/dev/null; then
  echo "Detected startup configuration errors in service logs" >&2
  exit 1
fi

echo "Smoke checks passed"
