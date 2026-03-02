#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DOMAIN="mines-ai.com"
APP_ROOT="/opt/mines-ai"
RUN_USER="mines-ai"
RUN_GROUP="mines-ai"
DEPLOY_USER=""

usage() {
  cat <<USAGE
Usage: $0 [--domain DOMAIN] [--app-root PATH] [--deploy-user USER]

Bootstraps a single control-plane VM for Mines AI production runtime.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --domain)
      DOMAIN="${2:-}"
      shift 2
      ;;
    --app-root)
      APP_ROOT="${2:-}"
      shift 2
      ;;
    --deploy-user)
      DEPLOY_USER="${2:-}"
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

if [ -z "${DOMAIN}" ]; then
  echo "--domain must not be empty" >&2
  exit 1
fi

if [ -n "${DEPLOY_USER}" ] && ! [[ "${DEPLOY_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  echo "--deploy-user contains invalid characters: ${DEPLOY_USER}" >&2
  exit 1
fi

if [ -n "${DEPLOY_USER}" ] && ! id -u "${DEPLOY_USER}" >/dev/null 2>&1; then
  echo "--deploy-user '${DEPLOY_USER}' does not exist on this VM" >&2
  exit 1
fi

echo "[bootstrap] Installing OS dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  apt-transport-https \
  ca-certificates \
  curl \
  debian-archive-keyring \
  debian-keyring \
  gnupg \
  jq \
  lsb-release \
  python3 \
  python3-venv \
  unzip \
  xz-utils

if ! command -v node >/dev/null 2>&1 || [ "$(node -p "process.versions.node.split('.')[0]")" != "22" ]; then
  echo "[bootstrap] Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

corepack enable

if ! command -v caddy >/dev/null 2>&1; then
  echo "[bootstrap] Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi

if ! command -v cloud-sql-proxy >/dev/null 2>&1; then
  echo "[bootstrap] Installing Cloud SQL Auth Proxy"
  arch="$(uname -m)"
  case "${arch}" in
    x86_64) proxy_arch="amd64" ;;
    aarch64|arm64) proxy_arch="arm64" ;;
    *)
      echo "Unsupported CPU architecture for Cloud SQL proxy: ${arch}" >&2
      exit 1
      ;;
  esac
  curl -fsSL -o /usr/local/bin/cloud-sql-proxy \
    "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.3/cloud-sql-proxy.linux.${proxy_arch}"
  chmod +x /usr/local/bin/cloud-sql-proxy
fi

if ! getent group "${RUN_GROUP}" >/dev/null 2>&1; then
  echo "[bootstrap] Creating group ${RUN_GROUP}"
  groupadd --system "${RUN_GROUP}"
fi

if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
  echo "[bootstrap] Creating user ${RUN_USER}"
  useradd --system --gid "${RUN_GROUP}" --home-dir "${APP_ROOT}" --create-home --shell /usr/sbin/nologin "${RUN_USER}"
fi

echo "[bootstrap] Creating runtime directories"
install -d -m 0755 -o "${RUN_USER}" -g "${RUN_GROUP}" "${APP_ROOT}/releases"
install -d -m 0750 -o "${RUN_USER}" -g "${RUN_GROUP}" "${APP_ROOT}/shared"
install -d -m 0755 -o "${RUN_USER}" -g "${RUN_GROUP}" "${APP_ROOT}/tmp"
install -d -m 0755 -o "${RUN_USER}" -g "${RUN_GROUP}" /var/log/mines-ai
install -d -m 0755 -o root -g root "${APP_ROOT}/scripts/deploy"
install -d -m 0755 -o root -g root "${APP_ROOT}/deploy/systemd"
install -d -m 0755 -o root -g root "${APP_ROOT}/deploy/caddy"
install -d -m 0755 -o root -g root "${APP_ROOT}/deploy/litellm"
# Caddy runs as its own user and must be able to traverse into current/client.
chmod 0755 "${APP_ROOT}"

if [ ! -f "${APP_ROOT}/shared/.env" ]; then
  touch "${APP_ROOT}/shared/.env"
fi
chown root:"${RUN_GROUP}" "${APP_ROOT}/shared/.env"
chmod 0640 "${APP_ROOT}/shared/.env"

if [ -f "${REPO_ROOT}/deploy/systemd/mines-ai-api.service" ]; then
  install -m 0644 "${REPO_ROOT}/deploy/systemd/mines-ai-api.service" /etc/systemd/system/mines-ai-api.service
  install -m 0644 "${REPO_ROOT}/deploy/systemd/mines-ai-api.service" "${APP_ROOT}/deploy/systemd/mines-ai-api.service"
fi

if [ -f "${REPO_ROOT}/deploy/systemd/cloud-sql-proxy.service" ]; then
  install -m 0644 "${REPO_ROOT}/deploy/systemd/cloud-sql-proxy.service" /etc/systemd/system/cloud-sql-proxy.service
  install -m 0644 "${REPO_ROOT}/deploy/systemd/cloud-sql-proxy.service" "${APP_ROOT}/deploy/systemd/cloud-sql-proxy.service"
fi

if [ -f "${REPO_ROOT}/deploy/systemd/litellm-proxy.service" ]; then
  install -m 0644 "${REPO_ROOT}/deploy/systemd/litellm-proxy.service" /etc/systemd/system/litellm-proxy.service
  install -m 0644 "${REPO_ROOT}/deploy/systemd/litellm-proxy.service" "${APP_ROOT}/deploy/systemd/litellm-proxy.service"
fi

if [ -f "${REPO_ROOT}/deploy/caddy/Caddyfile" ]; then
  sed "s/__DOMAIN__/${DOMAIN}/g" "${REPO_ROOT}/deploy/caddy/Caddyfile" >/etc/caddy/Caddyfile
  install -m 0644 /etc/caddy/Caddyfile "${APP_ROOT}/deploy/caddy/Caddyfile"
fi

if [ -f "${REPO_ROOT}/deploy/litellm/litellm-config.yaml" ]; then
  install -m 0644 "${REPO_ROOT}/deploy/litellm/litellm-config.yaml" "${APP_ROOT}/deploy/litellm/litellm-config.yaml"
fi

if [ ! -x "${APP_ROOT}/litellm-venv/bin/litellm" ]; then
  echo "[bootstrap] Installing LiteLLM runtime"
  sudo -u "${RUN_USER}" python3 -m venv "${APP_ROOT}/litellm-venv"
fi

if ! sudo -u "${RUN_USER}" "${APP_ROOT}/litellm-venv/bin/python" -c "import litellm, boto3, prisma" >/dev/null 2>&1; then
  echo "[bootstrap] Repairing LiteLLM runtime dependencies"
  sudo -u "${RUN_USER}" "${APP_ROOT}/litellm-venv/bin/pip" install --upgrade pip
  sudo -u "${RUN_USER}" "${APP_ROOT}/litellm-venv/bin/pip" install "litellm[proxy]>=1.74.0,<2" boto3 prisma
fi

if [ ! -f "${APP_ROOT}/shared/litellm-config.yaml" ] && [ -f "${APP_ROOT}/deploy/litellm/litellm-config.yaml" ]; then
  install -m 0640 -o root -g "${RUN_GROUP}" "${APP_ROOT}/deploy/litellm/litellm-config.yaml" "${APP_ROOT}/shared/litellm-config.yaml"
fi

for script in install-release.sh rollback-single-vm.sh smoke-check.sh validate-env.sh check-quiescence.sh; do
  if [ -f "${REPO_ROOT}/scripts/deploy/${script}" ]; then
    install -m 0755 "${REPO_ROOT}/scripts/deploy/${script}" "${APP_ROOT}/scripts/deploy/${script}"
  fi
done

if [ -n "${DEPLOY_USER}" ]; then
  echo "[bootstrap] Configuring scoped sudo for deploy user ${DEPLOY_USER}"
  SUDOERS_FILE="/etc/sudoers.d/mines-ai-deploy-${DEPLOY_USER}"
  cat >"${SUDOERS_FILE}" <<EOF
${DEPLOY_USER} ALL=(root) NOPASSWD: ${APP_ROOT}/scripts/deploy/install-release.sh, ${APP_ROOT}/scripts/deploy/smoke-check.sh, ${APP_ROOT}/scripts/deploy/rollback-single-vm.sh
EOF
  chmod 0440 "${SUDOERS_FILE}"
  visudo -cf "${SUDOERS_FILE}" >/dev/null
fi

systemctl daemon-reload
systemctl enable caddy cloud-sql-proxy litellm-proxy

echo "[bootstrap] Done"
echo "Next steps:"
if [ -n "${DEPLOY_USER}" ]; then
  echo "0) CI deploy user '${DEPLOY_USER}' can run scoped deploy sudo commands"
fi
echo "1) Populate ${APP_ROOT}/shared/.env (see docs/operations/runtime-env.md)"
echo "2) Run scripts/deploy/install-release.sh with server/client tarballs"
echo "3) Run scripts/deploy/smoke-check.sh"
