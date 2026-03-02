#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is required" >&2
  exit 1
fi

GCP_PROJECT_ID="${GCP_PROJECT_ID:-}"
IMAGE_TYPE="${IMAGE_TYPE:-}"
VERSION="${VERSION:-}"
TARGET_IMAGE_NAME="${TARGET_IMAGE_NAME:-}"

usage() {
  cat <<USAGE
Usage:
  $0 --image-type <runtime|base> --version <version> [--image-name <name>]

Backward-compatible runtime shorthand:
  $0 <runtime_version> [image_name]
USAGE
}

if [[ "$#" -gt 0 && "${1:-}" != --* ]]; then
  VERSION="${1:-${VERSION}}"
  TARGET_IMAGE_NAME="${2:-${TARGET_IMAGE_NAME}}"
  IMAGE_TYPE="${IMAGE_TYPE:-runtime}"
  set --
fi

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --image-type)
      IMAGE_TYPE="${2:-}"
      shift 2
      ;;
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --image-name)
      TARGET_IMAGE_NAME="${2:-}"
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

if [[ -z "${GCP_PROJECT_ID}" ]]; then
  echo "GCP_PROJECT_ID is required" >&2
  exit 1
fi

if [[ -z "${IMAGE_TYPE}" ]]; then
  echo "Image type is required" >&2
  usage >&2
  exit 1
fi

if [[ "${IMAGE_TYPE}" != "runtime" && "${IMAGE_TYPE}" != "base" ]]; then
  echo "Unsupported image type '${IMAGE_TYPE}'. Expected runtime or base." >&2
  exit 1
fi

if [[ -z "${VERSION}" ]]; then
  echo "Version is required" >&2
  usage >&2
  exit 1
fi

sanitize_version_label() {
  echo "${1}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//'
}

version_label="$(sanitize_version_label "${VERSION}")"
if [[ -z "${version_label}" ]]; then
  echo "Version '${VERSION}' cannot be converted to a valid label" >&2
  exit 1
fi

version_label_key=""
if [[ "${IMAGE_TYPE}" == "runtime" ]]; then
  version_label_key="runtime_version"
else
  version_label_key="base_version"
fi

if [[ -z "${TARGET_IMAGE_NAME}" ]]; then
  candidate_filter="labels.managed_by=mines_ai AND labels.state=candidate AND labels.${version_label_key}=${version_label}"
  if [[ "${IMAGE_TYPE}" == "base" ]]; then
    candidate_filter="${candidate_filter} AND labels.image_type=base"
  fi

  while IFS= read -r candidate; do
    [[ -z "${candidate}" ]] && continue

    candidate_type="$({
      gcloud compute images describe "${candidate}" \
        --project "${GCP_PROJECT_ID}" \
        --format "value(labels.image_type)" || true;
    })"

    if [[ "${IMAGE_TYPE}" == "runtime" ]]; then
      if [[ -z "${candidate_type}" || "${candidate_type}" == "runtime" ]]; then
        TARGET_IMAGE_NAME="${candidate}"
        break
      fi
    else
      if [[ "${candidate_type}" == "base" ]]; then
        TARGET_IMAGE_NAME="${candidate}"
        break
      fi
    fi
  done < <(
    gcloud compute images list \
      --project "${GCP_PROJECT_ID}" \
      --filter "${candidate_filter}" \
      --sort-by="~creationTimestamp" \
      --format "value(name)"
  )
fi

if [[ -z "${TARGET_IMAGE_NAME}" ]]; then
  echo "No candidate image found for ${IMAGE_TYPE} version ${VERSION}" >&2
  exit 1
fi

current_target_type="$({
  gcloud compute images describe "${TARGET_IMAGE_NAME}" \
    --project "${GCP_PROJECT_ID}" \
    --format "value(labels.image_type)" || true;
})"

current_target_version="$({
  gcloud compute images describe "${TARGET_IMAGE_NAME}" \
    --project "${GCP_PROJECT_ID}" \
    --format "value(labels.${version_label_key})" || true;
})"

if [[ "${IMAGE_TYPE}" == "runtime" ]]; then
  if [[ -n "${current_target_type}" && "${current_target_type}" != "runtime" ]]; then
    echo "Target image ${TARGET_IMAGE_NAME} has image_type=${current_target_type}, expected runtime" >&2
    exit 1
  fi
else
  if [[ "${current_target_type}" != "base" ]]; then
    echo "Target image ${TARGET_IMAGE_NAME} has image_type=${current_target_type:-<unset>}, expected base" >&2
    exit 1
  fi
fi

if [[ "${current_target_version}" != "${version_label}" ]]; then
  echo "Target image ${TARGET_IMAGE_NAME} ${version_label_key}=${current_target_version}, expected ${version_label}" >&2
  exit 1
fi

echo "Promoting image ${TARGET_IMAGE_NAME} (type=${IMAGE_TYPE}, version=${VERSION})..."

while IFS= read -r promoted_image; do
  [[ -z "${promoted_image}" ]] && continue
  if [[ "${promoted_image}" == "${TARGET_IMAGE_NAME}" ]]; then
    continue
  fi

  promoted_type="$({
    gcloud compute images describe "${promoted_image}" \
      --project "${GCP_PROJECT_ID}" \
      --format "value(labels.image_type)" || true;
  })"

  promoted_runtime_version="$({
    gcloud compute images describe "${promoted_image}" \
      --project "${GCP_PROJECT_ID}" \
      --format "value(labels.runtime_version)" || true;
  })"

  promoted_base_version="$({
    gcloud compute images describe "${promoted_image}" \
      --project "${GCP_PROJECT_ID}" \
      --format "value(labels.base_version)" || true;
  })"

  effective_type="${promoted_type}"
  if [[ -z "${effective_type}" ]]; then
    if [[ -n "${promoted_runtime_version}" ]]; then
      effective_type="runtime"
    elif [[ -n "${promoted_base_version}" ]]; then
      effective_type="base"
    fi
  fi

  if [[ "${effective_type}" != "${IMAGE_TYPE}" ]]; then
    continue
  fi

  echo "Demoting previously promoted ${IMAGE_TYPE} image ${promoted_image}"
  gcloud compute images add-labels "${promoted_image}" \
    --project "${GCP_PROJECT_ID}" \
    --labels "state=demoted,image_type=${IMAGE_TYPE}" \
    --quiet
done < <(
  gcloud compute images list \
    --project "${GCP_PROJECT_ID}" \
    --filter "labels.managed_by=mines_ai AND labels.state=promoted" \
    --format "value(name)"
)

gcloud compute images add-labels "${TARGET_IMAGE_NAME}" \
  --project "${GCP_PROJECT_ID}" \
  --labels "state=promoted,image_type=${IMAGE_TYPE},${version_label_key}=${version_label}" \
  --quiet

echo "Promoted image: ${TARGET_IMAGE_NAME}"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "image_name=${TARGET_IMAGE_NAME}" >>"${GITHUB_OUTPUT}"
  echo "image_type=${IMAGE_TYPE}" >>"${GITHUB_OUTPUT}"
  echo "version=${VERSION}" >>"${GITHUB_OUTPUT}"
  if [[ "${IMAGE_TYPE}" == "runtime" ]]; then
    echo "runtime_version=${VERSION}" >>"${GITHUB_OUTPUT}"
  else
    echo "base_version=${VERSION}" >>"${GITHUB_OUTPUT}"
  fi
fi
