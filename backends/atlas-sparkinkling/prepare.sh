#!/usr/bin/env bash
# MIT. LLooM orchestration only.
#
# Prepares the model directories SparkInkling serves, beside the downloads in
# the model root:
#
#   <model root>/thinkingmachines--Inkling-2-Mini         checked against its pins
#   <model root>/thinkingmachines--Inkling-2-Mini+dspark  the DSpark drafter
#   and with --weights spark:
#   <model root>/Enntity--Inkling-2-Mini-Spark-NVFP4      checked against its pins
#   <model root>/thinkingmachines--Inkling-2-Mini+spark-nvfp4  the Spark model
#
# The tools are SparkInkling's own install/check_files.py, dspark_drafter.py and
# spark_overlay.py with their pin file install/checkpoint.json (AGPL-3.0-only,
# standard library only). They are not copied into LLooM: this script fetches
# them from Enntity/sparkinkling at the manifest's source.revision, refuses any
# whose sha256 differs from prepareTool in the manifest, and runs them inside
# the pinned image with no network, as the calling user. Both directory tools
# leave a directory built from the same revisions as it is.
#
# Usage: prepare.sh --manifest <pins.json> --model-root <dir> --weights strict|spark
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST=""
MODEL_ROOT=""
WEIGHTS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --model-root) MODEL_ROOT="${2:-}"; shift 2 ;;
    --weights) WEIGHTS="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "prepare.sh: unexpected argument: $1" >&2; exit 2 ;;
  esac
done
[[ -f "${MANIFEST}" ]] || { echo "prepare.sh: pin manifest not found: ${MANIFEST}" >&2; exit 2; }
[[ -d "${MODEL_ROOT}" ]] || { echo "prepare.sh: model root not found: ${MODEL_ROOT}" >&2; exit 2; }
[[ "${WEIGHTS}" == strict || "${WEIGHTS}" == spark ]] || { echo "prepare.sh: --weights must be strict or spark" >&2; exit 2; }

fail() { echo "atlas-sparkinkling prepare: $*" >&2; exit 1; }
note() { echo "atlas-sparkinkling prepare: $*"; }

node "${SCRIPT_DIR}/verify-pins.mjs" "${MANIFEST}" >/dev/null || fail "pin manifest ${MANIFEST} is not installable"
pin() { node -e 'const m=require(process.argv[1]);let v=m;for(const k of process.argv[2].split(".")){v=v?.[k];}process.stdout.write(String(v??""))' "${MANIFEST}" "$1"; }

SOURCE_REPO="$(pin source.repo)"
SOURCE_REVISION="$(pin source.revision)"
IMAGE_REFERENCE="$(pin image.reference)"
MODEL_REPO="$(pin model.repo)"
OVERLAY_REPO="$(pin overlay.repo)"
MODEL_ROOT="$(cd "${MODEL_ROOT}" && pwd)"
# the path goes into a --mount field list
[[ "${MODEL_ROOT}" != *[,\"]* ]] || fail "model root ${MODEL_ROOT} must not contain commas or quotes"
checkpoint="${MODEL_ROOT}/${MODEL_REPO/\//--}"
overlay="${MODEL_ROOT}/${OVERLAY_REPO/\//--}"
[[ -d "${checkpoint}" ]] || fail "checkpoint ${checkpoint} is missing; the download step runs first"
if [[ "${WEIGHTS}" == spark ]]; then
  [[ -d "${overlay}" ]] || fail "overlay ${overlay} is missing; the download step runs first"
fi

tool="$(mktemp -d)"
trap 'rm -rf "${tool}"' EXIT
for name in checkpoint.json check_files.py dspark_drafter.py spark_overlay.py; do
  curl -fsSL --retry 3 -o "${tool}/${name}" \
    "https://raw.githubusercontent.com/${SOURCE_REPO}/${SOURCE_REVISION}/install/${name}" \
    || fail "could not fetch install/${name} from ${SOURCE_REPO}@${SOURCE_REVISION}"
  expected="$(node -e 'process.stdout.write(String(require(process.argv[1]).prepareTool?.[process.argv[2]] ?? ""))' "${MANIFEST}" "${name}")"
  actual="$(sha256sum "${tool}/${name}" | cut -d' ' -f1)"
  [[ "${actual}" == "${expected}" ]] || fail "install/${name} has sha256 ${actual}; the manifest pins ${expected}"
done

run_tool() {
  local name="$1"; shift
  docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint python3 \
    --mount "type=bind,src=${tool},dst=/sparkinkling-tool,readonly" \
    --mount "type=bind,src=${MODEL_ROOT},dst=${MODEL_ROOT}" \
    "${IMAGE_REFERENCE}" "/sparkinkling-tool/${name}" /sparkinkling-tool/checkpoint.json "$@" \
    || fail "${name} failed"
}

note "checking ${checkpoint} against its pins"
run_tool check_files.py "${checkpoint}"
run_tool dspark_drafter.py "${checkpoint}" "${checkpoint}+dspark"
if [[ "${WEIGHTS}" == spark ]]; then
  note "checking ${overlay} against its pins"
  run_tool check_files.py "${overlay}" overlay
  run_tool spark_overlay.py "${checkpoint}" "${overlay}" "${checkpoint}+spark-nvfp4"
fi
note "model directories ready (${WEIGHTS})"
