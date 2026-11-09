#!/usr/bin/env bash
# MIT. LLooM orchestration only.
#
# Builds the served checkpoint for SparkQwen's single-Spark 27B lane: NVIDIA's
# Qwen3.8-27B-NVFP4 with TandemLLM's NVFP4 Gated DeltaNet and attention
# projections re-keyed in, at <model root>/nvidia--Qwen3.8-27B-NVFP4+tandem-gdn-attn.
#
# The re-keying tool is SparkQwen's own install/tandem_overlay.py (AGPL-3.0-only,
# standard library only). It is not copied into LLooM: this script fetches it
# and its pin file install/checkpoint-27b.json from Enntity/sparkqwen at the
# manifest's source.revision, refuses either unless its sha256 matches
# overlayTool in the manifest, and runs it inside the pinned image with no
# network. The tool checks every overlay weight file against its pinned sha256
# before writing. A finished overlay records the overlay revision and is reused.
#
# Usage: overlay-27b.sh --manifest <pins.json> --model-root <dir>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST=""
MODEL_ROOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --model-root) MODEL_ROOT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "overlay-27b.sh: unexpected argument: $1" >&2; exit 2 ;;
  esac
done
[[ -f "${MANIFEST}" ]] || { echo "overlay-27b.sh: pin manifest not found: ${MANIFEST}" >&2; exit 2; }
[[ -d "${MODEL_ROOT}" ]] || { echo "overlay-27b.sh: model root not found: ${MODEL_ROOT}" >&2; exit 2; }

fail() { echo "atlas-sparkqwen overlay: $*" >&2; exit 1; }
note() { echo "atlas-sparkqwen overlay: $*"; }

node "${SCRIPT_DIR}/verify-pins.mjs" "${MANIFEST}" >/dev/null || fail "pin manifest ${MANIFEST} is not installable"
pin() { node -e 'const m=require(process.argv[1]);let v=m;for(const k of process.argv[2].split(".")){v=v?.[k];}process.stdout.write(String(v??""))' "${MANIFEST}" "$1"; }

SOURCE_REPO="$(pin source.repo)"
SOURCE_REVISION="$(pin source.revision)"
IMAGE_REFERENCE="$(pin image.reference)"
checkpoint="${MODEL_ROOT}/nvidia--Qwen3.8-27B-NVFP4"
weights="${MODEL_ROOT}/0xBakeer--TandemLLM-Qwen3.8-27B-NVFP4"
overlay="${checkpoint}+tandem-gdn-attn"
[[ -d "${checkpoint}" ]] || fail "checkpoint ${checkpoint} is missing; the download step runs first"
[[ -d "${weights}" ]] || fail "overlay weights ${weights} are missing; the download step runs first"

tool="$(mktemp -d)"
trap 'rm -rf "${tool}"' EXIT
for name in tandem_overlay.py checkpoint-27b.json; do
  curl -fsSL --retry 3 -o "${tool}/${name}" \
    "https://raw.githubusercontent.com/${SOURCE_REPO}/${SOURCE_REVISION}/install/${name}" \
    || fail "could not fetch install/${name} from ${SOURCE_REPO}@${SOURCE_REVISION}"
  expected="$(node -e 'process.stdout.write(String(require(process.argv[1]).overlayTool?.[process.argv[2]] ?? ""))' "${MANIFEST}" "${name}")"
  actual="$(sha256sum "${tool}/${name}" | cut -d' ' -f1)"
  [[ "${actual}" == "${expected}" ]] || fail "install/${name} has sha256 ${actual}; the manifest pins ${expected}"
done

revision="$(node -e 'process.stdout.write(require(process.argv[1]).overlay.revision)' "${tool}/checkpoint-27b.json")"
if [[ "$(cat "${overlay}/.sparkqwen-overlay" 2>/dev/null)" == "${revision}" ]]; then
  note "overlay ${overlay} is current (${revision}); reusing it"
  exit 0
fi

note "building ${overlay} from ${weights} @ ${revision}"
rm -rf "${overlay}"
docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint python3 \
  --mount "type=bind,src=${tool},dst=/overlay-tool,readonly" \
  --mount "type=bind,src=${MODEL_ROOT},dst=${MODEL_ROOT}" \
  "${IMAGE_REFERENCE}" /overlay-tool/tandem_overlay.py /overlay-tool/checkpoint-27b.json \
  "${checkpoint}" "${weights}" "${overlay}" \
  || fail "tandem_overlay.py failed; ${overlay} is incomplete"
[[ "$(cat "${overlay}/.sparkqwen-overlay" 2>/dev/null)" == "${revision}" ]] || fail "overlay ${overlay} did not record revision ${revision}"
note "overlay ready"
