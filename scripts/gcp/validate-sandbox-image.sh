#!/usr/bin/env bash
set -euo pipefail

EXPECTED_RUNTIME_VERSION="${1:-}"
if [[ -z "${EXPECTED_RUNTIME_VERSION}" ]]; then
  echo "Expected runtime version argument is required" >&2
  exit 1
fi

RUNTIME_DIR=/opt/mines-ai/sandbox
RUNTIME_VERSION_FILE="${RUNTIME_DIR}/runtime-version"
SERVER_ENTRYPOINT="${RUNTIME_DIR}/dist/sandbox-server.js"

if [[ ! -f "${SERVER_ENTRYPOINT}" ]]; then
  echo "Missing sandbox server entrypoint: ${SERVER_ENTRYPOINT}" >&2
  exit 1
fi

if [[ ! -f "${RUNTIME_VERSION_FILE}" ]]; then
  echo "Missing runtime version file: ${RUNTIME_VERSION_FILE}" >&2
  exit 1
fi

ACTUAL_RUNTIME_VERSION="$(tr -d '\r\n' < "${RUNTIME_VERSION_FILE}")"
if [[ "${ACTUAL_RUNTIME_VERSION}" != "${EXPECTED_RUNTIME_VERSION}" ]]; then
  echo "Runtime version mismatch: expected=${EXPECTED_RUNTIME_VERSION} actual=${ACTUAL_RUNTIME_VERSION}" >&2
  exit 1
fi

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
}

for cmd in \
  python3 \
  pip3 \
  gcc \
  g++ \
  make \
  cmake \
  pkg-config \
  rg \
  fd \
  sqlite3 \
  pandoc \
  latexmk \
  pdflatex \
  biber \
  dot \
  ffmpeg \
  convert \
  nvidia-smi \
  nvcc; do
  require_command "${cmd}"
done

python3 - <<'PY'
import importlib
import sys

required_modules = [
    "numpy",
    "pandas",
    "scipy",
    "matplotlib",
    "seaborn",
    "sklearn",
    "statsmodels",
    "sympy",
    "torch",
    "xgboost",
    "lightgbm",
]

missing = []
for module in required_modules:
    try:
        importlib.import_module(module)
    except Exception:
        missing.append(module)

if missing:
    sys.stderr.write(f"Missing required Python modules: {', '.join(missing)}\n")
    sys.exit(1)
PY

echo "Validated sandbox runtime image (${ACTUAL_RUNTIME_VERSION})"
