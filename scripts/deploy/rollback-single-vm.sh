#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="/opt/mines-ai"
ENV_FILE="${APP_ROOT}/shared/.env"
RELEASE_ID=""
DOMAIN=""

usage() {
  cat <<USAGE
Usage: $0 --release-id <id> --domain <domain> [--env-file PATH]

Rolls back to a previously installed release.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-id)
      RELEASE_ID="${2:-}"
      shift 2
      ;;
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
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

if [ "${EUID}" -ne 0 ]; then
  echo "This script must run as root" >&2
  exit 1
fi

if [ -z "${RELEASE_ID}" ] || [ -z "${DOMAIN}" ]; then
  usage >&2
  exit 1
fi

TARGET="${APP_ROOT}/releases/${RELEASE_ID}"
if [ ! -d "${TARGET}" ]; then
  echo "Release not found: ${TARGET}" >&2
  exit 1
fi

ln -sfn "${TARGET}" "${APP_ROOT}/current"

restart_if_present() {
  local service="$1"
  if systemctl cat "${service}" >/dev/null 2>&1; then
    systemctl restart "${service}"
  fi
}

ROLLED_BACK_AT="$(date -u '+%Y-%m-%d %H:%M:%S')"
systemctl restart cloud-sql-proxy
restart_if_present litellm-proxy
systemctl restart mines-ai-api
systemctl restart caddy

"${SCRIPT_DIR}/smoke-check.sh" --env-file "${ENV_FILE}" --domain "${DOMAIN}" --journal-window "${ROLLED_BACK_AT}"

echo "Rolled back to ${RELEASE_ID}"
