#!/usr/bin/env bash
# MIT. LLooM orchestration only.
#
# Checks the checkpoint SparkLing serves against its pins, in the model root
# where the download step put it:
#
#   --model ling-3.2-air --weights spark   primitive-ai--Ling-3.2-air-NVFP4A16
#   --model ling-3.2-air --weights strict  inclusionAI--Ling-3.2-air
#   --model sante-air-vl --weights spark   Enntity--LingSante-3.1-air-VL-NVFP4
#   --model sante-air-vl --weights strict  inclusionAI--LingSante-3.1-air-VL
#
# The tool is SparkLing's own install/check_files.py with the model's pin file
# (install/checkpoint*.json; AGPL-3.0-only, standard library only). They are
# not copied into LLooM: this script fetches them from Enntity/SparkLing at the
# manifest's source.revision, refuses any whose sha256 differs from prepareTool
# in the manifest, and runs check_files.py inside the pinned image with no
# network, as the calling user. Nothing is assembled: the engine serves the
# checkpoint directory as downloaded (Ling's MTP drafter is its own predictor).
#
# Usage: prepare.sh --manifest <pins.json> --model-root <dir>
#          --model ling-3.2-air|sante-air-vl --weights strict|spark
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST=""
MODEL_ROOT=""
MODEL=""
WEIGHTS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --model-root) MODEL_ROOT="${2:-}"; shift 2 ;;
    --model) MODEL="${2:-}"; shift 2 ;;
    --weights) WEIGHTS="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "prepare.sh: unexpected argument: $1" >&2; exit 2 ;;
  esac
done
[[ -f "${MANIFEST}" ]] || { echo "prepare.sh: pin manifest not found: ${MANIFEST}" >&2; exit 2; }
[[ -d "${MODEL_ROOT}" ]] || { echo "prepare.sh: model root not found: ${MODEL_ROOT}" >&2; exit 2; }
[[ "${MODEL}" == ling-3.2-air || "${MODEL}" == sante-air-vl ]] || { echo "prepare.sh: --model must be ling-3.2-air or sante-air-vl" >&2; exit 2; }
[[ "${WEIGHTS}" == strict || "${WEIGHTS}" == spark ]] || { echo "prepare.sh: --weights must be strict or spark" >&2; exit 2; }

fail() { echo "atlas-sparkling prepare: $*" >&2; exit 1; }
note() { echo "atlas-sparkling prepare: $*"; }

node "${SCRIPT_DIR}/verify-pins.mjs" "${MANIFEST}" >/dev/null || fail "pin manifest ${MANIFEST} is not installable"
pin() { node -e 'const m=require(process.argv[1]);let v=m;for(const k of process.argv[2].split(".")){v=v?.[k];}process.stdout.write(String(v??""))' "${MANIFEST}" "$1"; }

SOURCE_REPO="$(pin source.repo)"
SOURCE_REVISION="$(pin source.revision)"
IMAGE_REFERENCE="$(pin image.reference)"
# the model id has dots, so it is not a pin() path
checkpoint_pin() { node -e 'process.stdout.write(String(require(process.argv[1]).checkpoints?.[process.argv[2]]?.[process.argv[3]]?.[process.argv[4]] ?? ""))' "${MANIFEST}" "${MODEL}" "${WEIGHTS}" "$1"; }
CHECKPOINT_REPO="$(checkpoint_pin repo)"
PIN_FILE="$(checkpoint_pin manifest)"
[[ -n "${CHECKPOINT_REPO}" && -n "${PIN_FILE}" ]] || fail "the manifest pins no ${MODEL} ${WEIGHTS} checkpoint"
MODEL_ROOT="$(cd "${MODEL_ROOT}" && pwd)"
# the path goes into a --mount field list
[[ "${MODEL_ROOT}" != *[,\"]* ]] || fail "model root ${MODEL_ROOT} must not contain commas or quotes"
checkpoint="${MODEL_ROOT}/${CHECKPOINT_REPO/\//--}"
[[ -d "${checkpoint}" ]] || fail "checkpoint ${checkpoint} is missing; the download step runs first"

tool="$(mktemp -d)"
trap 'rm -rf "${tool}"' EXIT
for name in check_files.py "${PIN_FILE}"; do
  curl -fsSL --retry 3 -o "${tool}/${name}" \
    "https://raw.githubusercontent.com/${SOURCE_REPO}/${SOURCE_REVISION}/install/${name}" \
    || fail "could not fetch install/${name} from ${SOURCE_REPO}@${SOURCE_REVISION}"
  expected="$(node -e 'process.stdout.write(String(require(process.argv[1]).prepareTool?.[process.argv[2]] ?? ""))' "${MANIFEST}" "${name}")"
  actual="$(sha256sum "${tool}/${name}" | cut -d' ' -f1)"
  [[ "${actual}" == "${expected}" ]] || fail "install/${name} has sha256 ${actual}; the manifest pins ${expected}"
done

note "checking ${checkpoint} against install/${PIN_FILE} (${WEIGHTS})"
docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint python3 \
  --mount "type=bind,src=${tool},dst=/sparkling-tool,readonly" \
  --mount "type=bind,src=${checkpoint},dst=${checkpoint},readonly" \
  "${IMAGE_REFERENCE}" /sparkling-tool/check_files.py "${WEIGHTS}" "${checkpoint}" \
  --manifest "/sparkling-tool/${PIN_FILE}" \
  || fail "check_files.py failed: ${checkpoint} does not match install/${PIN_FILE}"
note "${checkpoint} matches its pins (${MODEL}, ${WEIGHTS})"
