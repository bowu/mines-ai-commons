#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is required" >&2
  exit 1
fi

GCP_PROJECT_ID="${GCP_PROJECT_ID:-}"
KEEP_DAYS="${KEEP_DAYS:-14}"
IMAGE_TYPE="${IMAGE_TYPE:-runtime}"

if [[ -z "${GCP_PROJECT_ID}" ]]; then
  echo "GCP_PROJECT_ID is required" >&2
  exit 1
fi

if ! [[ "${KEEP_DAYS}" =~ ^[0-9]+$ ]]; then
  echo "KEEP_DAYS must be an integer" >&2
  exit 1
fi

if [[ "${IMAGE_TYPE}" != "runtime" && "${IMAGE_TYPE}" != "base" ]]; then
  echo "IMAGE_TYPE must be 'runtime' or 'base'" >&2
  exit 1
fi

cutoff_iso="$(node -e "const days=Number(process.env.KEEP_DAYS||'14'); console.log(new Date(Date.now()-days*24*60*60*1000).toISOString())")"

echo "Deleting ${IMAGE_TYPE} candidate/demoted sandbox images older than ${KEEP_DAYS} days (before ${cutoff_iso})..."

candidate_names=()
while IFS= read -r image; do
  [[ -z "${image}" ]] && continue
  candidate_names+=("${image}")
done < <(
  gcloud compute images list \
    --project "${GCP_PROJECT_ID}" \
    --filter "labels.managed_by=mines_ai AND (labels.state=candidate OR labels.state=demoted) AND creationTimestamp<'${cutoff_iso}'" \
    --format "value(name)"
)

if [[ "${#candidate_names[@]}" -eq 0 ]]; then
  echo "No stale sandbox images to delete."
  exit 0
fi

deleted=0
for image in "${candidate_names[@]}"; do
  image_type_label="$({
    gcloud compute images describe "${image}" \
      --project "${GCP_PROJECT_ID}" \
      --format "value(labels.image_type)" || true;
  })"

  runtime_version_label="$({
    gcloud compute images describe "${image}" \
      --project "${GCP_PROJECT_ID}" \
      --format "value(labels.runtime_version)" || true;
  })"

  base_version_label="$({
    gcloud compute images describe "${image}" \
      --project "${GCP_PROJECT_ID}" \
      --format "value(labels.base_version)" || true;
  })"

  effective_type="${image_type_label}"
  if [[ -z "${effective_type}" ]]; then
    if [[ -n "${runtime_version_label}" ]]; then
      effective_type="runtime"
    elif [[ -n "${base_version_label}" ]]; then
      effective_type="base"
    fi
  fi

  if [[ "${effective_type}" != "${IMAGE_TYPE}" ]]; then
    continue
  fi

  echo "Deleting ${image}"
  gcloud compute images delete "${image}" \
    --project "${GCP_PROJECT_ID}" \
    --quiet
  deleted=$((deleted + 1))
done

if [[ "${deleted}" -eq 0 ]]; then
  echo "No stale ${IMAGE_TYPE} sandbox images to delete."
  exit 0
fi

echo "Deleted ${deleted} stale ${IMAGE_TYPE} sandbox image(s)."
