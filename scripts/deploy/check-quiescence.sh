#!/usr/bin/env bash
set -euo pipefail

SERVER_DIR=""
DATABASE_URL="${DATABASE_URL:-}"
TIMEOUT_SECONDS=90
POLL_SECONDS=3

usage() {
  cat <<USAGE
Usage: $0 --server-dir <dir> [--database-url <url>] [--timeout-seconds <n>] [--poll-seconds <n>]

Waits until deploy blockers clear:
- active stream leases
- running goal runs
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --server-dir)
      SERVER_DIR="${2:-}"
      shift 2
      ;;
    --database-url)
      DATABASE_URL="${2:-}"
      shift 2
      ;;
    --timeout-seconds)
      TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    --poll-seconds)
      POLL_SECONDS="${2:-}"
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

if [ -z "${SERVER_DIR}" ]; then
  echo "--server-dir is required" >&2
  exit 1
fi
if [ -z "${DATABASE_URL}" ]; then
  echo "DATABASE_URL is required (--database-url or env)" >&2
  exit 1
fi
if [ ! -d "${SERVER_DIR}" ]; then
  echo "Server directory not found: ${SERVER_DIR}" >&2
  exit 1
fi
if ! [[ "${TIMEOUT_SECONDS}" =~ ^[0-9]+$ ]] || [ "${TIMEOUT_SECONDS}" -lt 0 ]; then
  echo "Invalid --timeout-seconds: ${TIMEOUT_SECONDS}" >&2
  exit 1
fi
if ! [[ "${POLL_SECONDS}" =~ ^[0-9]+$ ]] || [ "${POLL_SECONDS}" -le 0 ]; then
  echo "Invalid --poll-seconds: ${POLL_SECONDS}" >&2
  exit 1
fi

fetch_counts() {
  DATABASE_URL="${DATABASE_URL}" node --input-type=module <<'NODE'
import pg from "pg";

const { Client } = pg;
const connectionString = process.env.DATABASE_URL || "";
const client = new Client({ connectionString });
await client.connect();
const result = await client.query(`
  SELECT
    (SELECT COUNT(*)::int
       FROM agents
      WHERE deleted_at IS NULL
        AND active_stream_lease_until IS NOT NULL
        AND active_stream_lease_until > NOW()) AS active_stream_agents,
    (SELECT COUNT(*)::int
       FROM agent_session_goal_runs
      WHERE ended_at IS NULL
        AND status = 'running') AS active_goal_runs
`);
await client.end();
const row = result.rows[0] || {};
const activeStreamAgents = Number(row.active_stream_agents || 0);
const activeGoalRuns = Number(row.active_goal_runs || 0);
process.stdout.write(`${activeStreamAgents}\t${activeGoalRuns}`);
NODE
}

start_epoch="$(date +%s)"

while true; do
  counts="$(cd "${SERVER_DIR}" && fetch_counts)"
  IFS=$'\t' read -r active_stream_agents active_goal_runs <<<"${counts}"

  blockers=()
  if [ "${active_stream_agents}" -gt 0 ]; then
    blockers+=("active_stream_agents=${active_stream_agents}")
  fi
  if [ "${active_goal_runs}" -gt 0 ]; then
    blockers+=("active_goal_runs=${active_goal_runs}")
  fi

  if [ "${#blockers[@]}" -eq 0 ]; then
    echo "Deploy quiescence reached."
    exit 0
  fi

  now_epoch="$(date +%s)"
  elapsed="$((now_epoch - start_epoch))"
  if [ "${elapsed}" -ge "${TIMEOUT_SECONDS}" ]; then
    echo "Timed out waiting for deploy quiescence after ${elapsed}s: ${blockers[*]}" >&2
    exit 1
  fi

  echo "Waiting for quiescence (${elapsed}s elapsed): ${blockers[*]}"
  sleep "${POLL_SECONDS}"
done

