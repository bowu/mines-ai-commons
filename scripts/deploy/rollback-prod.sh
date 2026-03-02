#!/usr/bin/env bash
set -euo pipefail

WORKFLOW="rollback-single-vm.yml"
RELEASE_ID=""
WATCH_RUN=1

usage() {
  cat <<USAGE
Usage: $0 --release-id <id> [--no-watch]

Dispatches the production rollback workflow.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-id)
      RELEASE_ID="${2:-}"
      shift 2
      ;;
    --no-watch)
      WATCH_RUN=0
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

if [ -z "${RELEASE_ID}" ]; then
  usage >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated. Run: gh auth login" >&2
  exit 1
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
echo "Triggered rollback for release_id=${RELEASE_ID}"

if [ "${WATCH_RUN}" -eq 0 ]; then
  exit 0
fi

run_id="$(resolve_dispatched_run_id || true)"
if [ -z "${run_id}" ]; then
  echo "Could not resolve rollback run ID. Check: gh run list --workflow ${WORKFLOW}" >&2
  exit 1
fi

run_url="$(gh run view "${run_id}" --json url -q .url 2>/dev/null || true)"
if [ -n "${run_url}" ] && [ "${run_url}" != "null" ]; then
  echo "Watching run: ${run_url}"
fi

gh run watch "${run_id}" --exit-status
