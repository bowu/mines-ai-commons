#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

APP_ROOT="/opt/mines-ai"
RUN_USER="mines-ai"
RUN_GROUP="mines-ai"
ENV_FILE="${APP_ROOT}/shared/.env"
DRAIN_FLAG_FILE="${APP_ROOT}/shared/.deploy-draining"
RELEASE_ID=""
SERVER_TARBALL=""
CLIENT_TARBALL=""
DOMAIN=""
KEEP_RELEASE_COUNT="${KEEP_RELEASE_COUNT:-5}"

usage() {
  cat <<USAGE
Usage: $0 --release-id <id> --server-tar <server.tar.gz> --client-tar <client.tar.gz> --domain <domain> [--env-file PATH]

Installs a new release and restarts runtime services.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release-id)
      RELEASE_ID="${2:-}"
      shift 2
      ;;
    --server-tar)
      SERVER_TARBALL="${2:-}"
      shift 2
      ;;
    --client-tar)
      CLIENT_TARBALL="${2:-}"
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

if [ -z "${RELEASE_ID}" ] || [ -z "${SERVER_TARBALL}" ] || [ -z "${CLIENT_TARBALL}" ] || [ -z "${DOMAIN}" ]; then
  usage >&2
  exit 1
fi

if [ ! -f "${SERVER_TARBALL}" ]; then
  echo "Missing server tarball: ${SERVER_TARBALL}" >&2
  exit 1
fi

if [ ! -f "${CLIENT_TARBALL}" ]; then
  echo "Missing client tarball: ${CLIENT_TARBALL}" >&2
  exit 1
fi

BACKUP_DIR="$(mktemp -d)"
cleanup() {
  rm -f "${DRAIN_FLAG_FILE}"
  rm -rf "${BACKUP_DIR}"
}
trap cleanup EXIT

backup_or_mark_absent() {
  local src="$1"
  local key="$2"
  if [ -f "${src}" ]; then
    cp "${src}" "${BACKUP_DIR}/${key}.bak"
    echo "present" >"${BACKUP_DIR}/${key}.state"
  else
    echo "absent" >"${BACKUP_DIR}/${key}.state"
  fi
}

restore_from_backup() {
  local dst="$1"
  local key="$2"
  if [ ! -f "${BACKUP_DIR}/${key}.state" ]; then
    return 0
  fi
  if [ "$(cat "${BACKUP_DIR}/${key}.state")" = "present" ] && [ -f "${BACKUP_DIR}/${key}.bak" ]; then
    install -m 0644 "${BACKUP_DIR}/${key}.bak" "${dst}"
  else
    rm -f "${dst}"
  fi
}

backup_state_is_present() {
  local key="$1"
  [ -f "${BACKUP_DIR}/${key}.state" ] && [ "$(cat "${BACKUP_DIR}/${key}.state")" = "present" ]
}

restart_if_present() {
  local service="$1"
  local state_key="$2"
  if backup_state_is_present "${state_key}" || systemctl cat "${service}" >/dev/null 2>&1; then
    systemctl restart "${service}"
  fi
}

dump_runtime_diagnostics() {
  local since="$1"
  for unit in cloud-sql-proxy litellm-proxy mines-ai-api caddy; do
    echo "---- ${unit} status ----" >&2
    systemctl status --no-pager "${unit}" >&2 || true
    echo "---- ${unit} logs ----" >&2
    journalctl -u "${unit}" --since "${since}" --no-pager >&2 || true
  done
}

prune_old_releases() {
  if ! [[ "${KEEP_RELEASE_COUNT}" =~ ^[0-9]+$ ]] || [ "${KEEP_RELEASE_COUNT}" -lt 1 ]; then
    echo "KEEP_RELEASE_COUNT must be a positive integer (got: ${KEEP_RELEASE_COUNT})" >&2
    exit 1
  fi

  local current_target=""
  if [ -L "${APP_ROOT}/current" ]; then
    current_target="$(readlink -f "${APP_ROOT}/current" || true)"
  fi

  local -a release_dirs=()
  mapfile -t release_dirs < <(
    find "${APP_ROOT}/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null |
      sort -nr |
      awk '{print $2}'
  )

  local kept=0
  local dir=""
  for dir in "${release_dirs[@]}"; do
    if [ "${dir}" = "${RELEASE_DIR}" ] || { [ -n "${current_target}" ] && [ "${dir}" = "${current_target}" ]; }; then
      continue
    fi
    kept=$((kept + 1))
    if [ "${kept}" -le "${KEEP_RELEASE_COUNT}" ]; then
      continue
    fi
    echo "Pruning old release directory: ${dir}"
    rm -rf "${dir}"
  done
}

"${SCRIPT_DIR}/validate-env.sh" --env-file "${ENV_FILE}"

required_runtime_files=(
  "${REPO_ROOT}/deploy/systemd/mines-ai-api.service"
  "${REPO_ROOT}/deploy/systemd/cloud-sql-proxy.service"
  "${REPO_ROOT}/deploy/systemd/litellm-proxy.service"
  "${REPO_ROOT}/deploy/caddy/Caddyfile"
  "${REPO_ROOT}/deploy/litellm/litellm-config.yaml"
  "${REPO_ROOT}/scripts/deploy/check-quiescence.sh"
)
for runtime_file in "${required_runtime_files[@]}"; do
  if [ ! -f "${runtime_file}" ]; then
    echo "Missing required runtime config file: ${runtime_file}" >&2
    echo "Run bootstrap from a repository checkout so /opt/mines-ai/deploy/* exists." >&2
    exit 1
  fi
done

RELEASE_DIR="${APP_ROOT}/releases/${RELEASE_ID}"
SERVER_DIR="${RELEASE_DIR}/server"
CLIENT_DIR="${RELEASE_DIR}/client"

mkdir -p "${APP_ROOT}/releases"
if [ -d "${RELEASE_DIR}" ]; then
  echo "Removing existing release directory: ${RELEASE_DIR}"
  rm -rf "${RELEASE_DIR}"
fi
prune_old_releases

mkdir -p "${SERVER_DIR}" "${CLIENT_DIR}"

tar -xzf "${SERVER_TARBALL}" -C "${SERVER_DIR}"
tar -xzf "${CLIENT_TARBALL}" -C "${CLIENT_DIR}"

chown -R "${RUN_USER}:${RUN_GROUP}" "${RELEASE_DIR}"
chmod -R a+rX "${CLIENT_DIR}"
chmod a+rx "${APP_ROOT}" "${APP_ROOT}/releases" "${RELEASE_DIR}"

if [ ! -f "${SERVER_DIR}/drizzle.config.ts" ]; then
  echo "Missing drizzle.config.ts in server release package; cannot run DB migrations" >&2
  exit 1
fi

if [ ! -x "${APP_ROOT}/litellm-venv/bin/litellm" ]; then
  echo "Installing LiteLLM runtime"
  apt-get update -y
  apt-get install -y --no-install-recommends python3 python3-venv
  sudo -u "${RUN_USER}" python3 -m venv "${APP_ROOT}/litellm-venv"
fi

if ! sudo -u "${RUN_USER}" "${APP_ROOT}/litellm-venv/bin/python" -c "import litellm, boto3, prisma" >/dev/null 2>&1; then
  echo "Repairing LiteLLM runtime dependencies"
  sudo -u "${RUN_USER}" "${APP_ROOT}/litellm-venv/bin/pip" install --upgrade pip
  sudo -u "${RUN_USER}" "${APP_ROOT}/litellm-venv/bin/pip" install "litellm[proxy]>=1.74.0,<2" boto3 prisma
fi

install -m 0640 -o root -g "${RUN_GROUP}" "${REPO_ROOT}/deploy/litellm/litellm-config.yaml" "${APP_ROOT}/shared/litellm-config.yaml"

echo "Running database migrations for release ${RELEASE_ID}"
set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a
if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL must be set in ${ENV_FILE} to run migrations" >&2
  exit 1
fi
if ! sudo -u "${RUN_USER}" env DATABASE_URL="${DATABASE_URL}" bash -lc "set -euo pipefail; cd '${SERVER_DIR}' && pnpm db:migrate"; then
  echo "Database migrations failed for release ${RELEASE_ID}" >&2
  exit 1
fi

PREVIOUS_TARGET=""
if [ -L "${APP_ROOT}/current" ]; then
  PREVIOUS_TARGET="$(readlink -f "${APP_ROOT}/current" || true)"
fi

backup_or_mark_absent /etc/systemd/system/mines-ai-api.service mines_ai_api_service
backup_or_mark_absent /etc/systemd/system/cloud-sql-proxy.service cloud_sql_proxy_service
backup_or_mark_absent /etc/systemd/system/litellm-proxy.service litellm_proxy_service
backup_or_mark_absent /etc/caddy/Caddyfile caddyfile

ln -sfn "${RELEASE_DIR}" "${APP_ROOT}/current"
chown -h "${RUN_USER}:${RUN_GROUP}" "${APP_ROOT}/current"

install -m 0644 "${REPO_ROOT}/deploy/systemd/mines-ai-api.service" /etc/systemd/system/mines-ai-api.service
install -m 0644 "${REPO_ROOT}/deploy/systemd/cloud-sql-proxy.service" /etc/systemd/system/cloud-sql-proxy.service
install -m 0644 "${REPO_ROOT}/deploy/systemd/litellm-proxy.service" /etc/systemd/system/litellm-proxy.service
sed "s/__DOMAIN__/${DOMAIN}/g" "${REPO_ROOT}/deploy/caddy/Caddyfile" >/etc/caddy/Caddyfile
QUIS_SRC="${REPO_ROOT}/scripts/deploy/check-quiescence.sh"
QUIS_DST="${APP_ROOT}/scripts/deploy/check-quiescence.sh"
if [ -f "${QUIS_SRC}" ]; then
  src_real="$(readlink -f "${QUIS_SRC}")"
  dst_real="$(readlink -f "${QUIS_DST}" 2>/dev/null || true)"
  if [ "${src_real}" != "${dst_real}" ]; then
    install -m 0755 "${QUIS_SRC}" "${QUIS_DST}"
  fi
fi

echo "Entering deploy drain mode"
touch "${DRAIN_FLAG_FILE}"
chown root:"${RUN_GROUP}" "${DRAIN_FLAG_FILE}"
chmod 0640 "${DRAIN_FLAG_FILE}"

DEPLOY_DRAIN_TIMEOUT_SECONDS="${DEPLOY_DRAIN_TIMEOUT_SECONDS:-300}"
DEPLOY_DRAIN_POLL_SECONDS="${DEPLOY_DRAIN_POLL_SECONDS:-3}"
echo "Waiting for deploy quiescence (timeout=${DEPLOY_DRAIN_TIMEOUT_SECONDS}s poll=${DEPLOY_DRAIN_POLL_SECONDS}s)"
"${APP_ROOT}/scripts/deploy/check-quiescence.sh" \
  --server-dir "${SERVER_DIR}" \
  --database-url "${DATABASE_URL}" \
  --timeout-seconds "${DEPLOY_DRAIN_TIMEOUT_SECONDS}" \
  --poll-seconds "${DEPLOY_DRAIN_POLL_SECONDS}"

systemctl daemon-reload
systemctl enable caddy cloud-sql-proxy litellm-proxy mines-ai-api
DEPLOY_STARTED_AT="$(date -u '+%Y-%m-%d %H:%M:%S')"
if ! {
  systemctl reset-failed cloud-sql-proxy litellm-proxy mines-ai-api caddy || true &&
  systemctl restart cloud-sql-proxy &&
  systemctl restart litellm-proxy &&
  systemctl restart mines-ai-api &&
  systemctl restart caddy &&
  "${SCRIPT_DIR}/smoke-check.sh" --env-file "${ENV_FILE}" --domain "${DOMAIN}" --journal-window "${DEPLOY_STARTED_AT}";
}; then
  echo "Deploy health checks failed after deploying ${RELEASE_ID}" >&2
  dump_runtime_diagnostics "${DEPLOY_STARTED_AT}"
  if [ -n "${PREVIOUS_TARGET}" ] && [ -d "${PREVIOUS_TARGET}" ]; then
    echo "Rolling back to previous release: ${PREVIOUS_TARGET}" >&2
    ln -sfn "${PREVIOUS_TARGET}" "${APP_ROOT}/current"
    chown -h "${RUN_USER}:${RUN_GROUP}" "${APP_ROOT}/current"
  fi
  restore_from_backup /etc/systemd/system/mines-ai-api.service mines_ai_api_service
  restore_from_backup /etc/systemd/system/cloud-sql-proxy.service cloud_sql_proxy_service
  restore_from_backup /etc/systemd/system/litellm-proxy.service litellm_proxy_service
  restore_from_backup /etc/caddy/Caddyfile caddyfile
  systemctl daemon-reload
  ROLLED_BACK_AT="$(date -u '+%Y-%m-%d %H:%M:%S')"
  systemctl restart cloud-sql-proxy
  restart_if_present litellm-proxy litellm_proxy_service
  systemctl restart mines-ai-api
  systemctl restart caddy
  if ! "${SCRIPT_DIR}/smoke-check.sh" --env-file "${ENV_FILE}" --domain "${DOMAIN}" --journal-window "${ROLLED_BACK_AT}"; then
    echo "Rollback health checks failed for restored release" >&2
  fi
  exit 1
fi

echo "Release ${RELEASE_ID} installed successfully"
