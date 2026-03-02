#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=".env"
URL=""

usage() {
  cat <<USAGE
Usage: $0 [--env-file PATH] [--url https://mines-ai.com]

Runs lightweight production smoke checks from local machine.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --url)
      URL="${2:-}"
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

if [ -z "${URL}" ]; then
  if [ ! -f "${ENV_FILE}" ]; then
    echo "Missing env file: ${ENV_FILE}" >&2
    exit 1
  fi
  line="$(grep -E '^PROD_PUBLIC_URL=' "${ENV_FILE}" | tail -n 1 || true)"
  if [ -z "${line}" ]; then
    line="$(grep -E '^PUBLIC_URL=' "${ENV_FILE}" | tail -n 1 || true)"
  fi
  if [ -z "${line}" ]; then
    echo "Missing URL. Provide --url or set PROD_PUBLIC_URL/PUBLIC_URL in ${ENV_FILE}" >&2
    exit 1
  fi
  URL="${line#*=}"
fi

if [[ "${URL}" =~ ^\".*\"$ ]]; then
  URL="${URL#\"}"
  URL="${URL%\"}"
elif [[ "${URL}" =~ ^\'.*\'$ ]]; then
  URL="${URL#\'}"
  URL="${URL%\'}"
fi

URL="${URL%/}"
if [[ "${URL}" != https://* ]]; then
  echo "Smoke checks require https URL, got: ${URL}" >&2
  exit 1
fi

curl --silent --show-error --fail "${URL}/" >/dev/null
curl --silent --show-error --fail "${URL}/api/health" >/dev/null
curl --silent --show-error --fail "${URL}/api/auth/login" >/dev/null

echo "Production smoke checks passed for ${URL}"
