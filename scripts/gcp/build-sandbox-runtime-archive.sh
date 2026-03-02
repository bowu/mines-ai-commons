#!/usr/bin/env bash
set -euo pipefail

RUNTIME_VERSION="${1:-}"
OUTPUT_PATH="${2:-sandbox-runtime.tar.gz}"

if [[ -z "${RUNTIME_VERSION}" ]]; then
  echo "Usage: $0 <runtime-version> [output-path]" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

pnpm --filter sandbox build

cp -R sandbox/dist "${tmp_dir}/dist"
cp sandbox/package.json "${tmp_dir}/package.json"
printf '%s\n' "${RUNTIME_VERSION}" >"${tmp_dir}/runtime-version"

tar -C "${tmp_dir}" -czf "${OUTPUT_PATH}" dist package.json runtime-version
echo "Created ${OUTPUT_PATH}"
