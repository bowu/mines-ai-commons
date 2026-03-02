#!/usr/bin/env bash
set -euo pipefail

EXPECTED_BASE_VERSION="${1:-}"
BASE_VERSION_FILE="/opt/mines-ai/base-version"

if [[ ! -f "${BASE_VERSION_FILE}" ]]; then
  echo "Missing base version file: ${BASE_VERSION_FILE}" >&2
  exit 1
fi

ACTUAL_BASE_VERSION="$(tr -d '\r\n' < "${BASE_VERSION_FILE}")"
if [[ -n "${EXPECTED_BASE_VERSION}" && "${ACTUAL_BASE_VERSION}" != "${EXPECTED_BASE_VERSION}" ]]; then
  echo "Base version mismatch: expected=${EXPECTED_BASE_VERSION} actual=${ACTUAL_BASE_VERSION}" >&2
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
  node \
  npm \
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

if ! node -v | grep -q '^v22\.'; then
  echo "Expected Node.js v22.x in base image, got: $(node -v)" >&2
  exit 1
fi

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
    sys.stderr.write(f"Missing required Python modules: {', '.join(missing)}\\n")
    sys.exit(1)
PY

echo "Validated sandbox base image (${ACTUAL_BASE_VERSION})"
