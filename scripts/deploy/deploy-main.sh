#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ENV_FILE=".env"
ENVIRONMENT="production"
SECRET_NAME="PROD_APP_ENV"
REPO=""
WORKFLOW="deploy-single-vm.yml"
SKIP_ENV_SYNC=0
DRY_RUN=0
WATCH_RUN=1
RELEASE_ID=""
ALLOW_DIRTY=0

usage() {
  cat <<USAGE
Usage: $0 [options]

Deploys origin/main by:
1) validating local env,
2) syncing PROD_APP_ENV from local .env,
3) triggering GitHub workflow_dispatch deploy.

Options:
  --env-file PATH         Local env file (default: .env)
  --environment NAME      GitHub environment name (default: production)
  --secret-name NAME      GitHub env secret name (default: PROD_APP_ENV)
  --repo OWNER/REPO       Explicit repo, otherwise inferred via gh
  --release-id SHA        Override release ID (default: origin/main SHA)
  --skip-env-sync         Skip secret sync step
  --no-watch              Do not watch workflow after dispatch
  --dry-run               Validate and print actions without mutating
  --allow-dirty           Allow dirty working tree (dry-run only)
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
    --release-id)
      RELEASE_ID="${2:-}"
      shift 2
      ;;
    --skip-env-sync)
      SKIP_ENV_SYNC=1
      shift 1
      ;;
    --no-watch)
      WATCH_RUN=0
      shift 1
      ;;
    --dry-run)
      DRY_RUN=1
      shift 1
      ;;
    --allow-dirty)
      ALLOW_DIRTY=1
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

for cmd in git gh bash; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
done

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  if [ "${ALLOW_DIRTY}" -ne 1 ]; then
    echo "Working tree must be clean before deploy." >&2
    echo "For local validation only, use: --dry-run --allow-dirty" >&2
    exit 1
  fi
fi

if [ "${ALLOW_DIRTY}" -eq 1 ] && [ "${DRY_RUN}" -ne 1 ]; then
  echo "--allow-dirty is only allowed with --dry-run" >&2
  exit 1
fi

git fetch origin main --quiet
local_head="$(git rev-parse HEAD)"
remote_main_head="$(git rev-parse origin/main)"

if [ "${local_head}" != "${remote_main_head}" ]; then
  cat >&2 <<EOF
HEAD mismatch:
  local HEAD      ${local_head}
  origin/main     ${remote_main_head}

Deploy requires local HEAD to exactly match origin/main.
EOF
  exit 1
fi

if [ -z "${RELEASE_ID}" ]; then
  RELEASE_ID="${remote_main_head}"
fi

if [ "${SKIP_ENV_SYNC}" -eq 0 ]; then
  sync_args=(
    --env-file "${ENV_FILE}"
    --environment "${ENVIRONMENT}"
    --secret-name "${SECRET_NAME}"
  )
  if [ -n "${REPO}" ]; then
    sync_args+=(--repo "${REPO}")
  fi
  if [ "${DRY_RUN}" -eq 1 ]; then
    sync_args+=(--dry-run)
  fi
  bash "${REPO_ROOT}/scripts/secrets/sync-production-env-from-dotenv.sh" "${sync_args[@]}"
else
  echo "Skipping env sync (--skip-env-sync)"
fi

if [ "${DRY_RUN}" -eq 1 ]; then
  echo "Dry run: would dispatch ${WORKFLOW} on ref main with release_id=${RELEASE_ID}"
  exit 0
fi

resolve_dispatched_run_id() {
  local attempts=5
  local delay_seconds=2
  local attempt=1
  local id=""
  while [ "${attempt}" -le "${attempts}" ]; do
    id="$(gh run list --workflow "${WORKFLOW}" --event workflow_dispatch --branch main --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
    if [ -n "${id}" ] && [ "${id}" != "null" ]; then
      printf "%s" "${id}"
      return 0
    fi
    sleep "${delay_seconds}"
    attempt=$((attempt + 1))
  done
  return 1
}

gh workflow run "${WORKFLOW}" --ref main -f "release_id=${RELEASE_ID}"
echo "Triggered workflow ${WORKFLOW} for release ${RELEASE_ID}"

if [ "${WATCH_RUN}" -eq 0 ]; then
  exit 0
fi

run_id="$(resolve_dispatched_run_id || true)"
if [ -z "${run_id}" ]; then
  echo "Could not resolve run ID automatically. Check: gh run list --workflow ${WORKFLOW}" >&2
  exit 1
fi

run_url="$(gh run view "${run_id}" --json url -q .url 2>/dev/null || true)"
if [ -n "${run_url}" ] && [ "${run_url}" != "null" ]; then
  echo "Watching run: ${run_url}"
fi

gh run watch "${run_id}" --exit-status
