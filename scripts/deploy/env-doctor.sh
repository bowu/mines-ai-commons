#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ENV_FILE=".env"
ENVIRONMENT="production"
SECRET_NAME="PROD_APP_ENV"
REPO=""

usage() {
  cat <<USAGE
Usage: $0 [--env-file PATH] [--environment NAME] [--secret-name NAME] [--repo OWNER/REPO]

Checks local deploy prerequisites:
- required CLIs are installed
- gh authentication is valid
- local .env can render a valid production secret payload (dry-run)
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

for cmd in git gh bash; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
done

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

sync_args=(
  --env-file "${ENV_FILE}"
  --environment "${ENVIRONMENT}"
  --secret-name "${SECRET_NAME}"
  --dry-run
)

if [ -n "${REPO}" ]; then
  sync_args+=(--repo "${REPO}")
fi

bash "${REPO_ROOT}/scripts/secrets/sync-production-env-from-dotenv.sh" "${sync_args[@]}"
echo "env:doctor passed"
