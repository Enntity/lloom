#!/usr/bin/env bash
# MIT. LLooM orchestration only.
#
# Explicit, once-per-node NVFP4 overlay conversion gate for the Atlas SparkGLM
# lane. The converter ships inside the prepared image
# (/opt/atlas/converter/convert.py plus /opt/atlas/converter/libatlas_mtp_quantize.so);
# LLooM does not ship a product convert-overlay.sh of its own.
#
# Directory existence never means "converted": this script requires the
# conversion marker (conversion.complete.json with converted_matrices, shards,
# source, output and finished) plus a real --verify-overlay run against the
# windowed/quantized output before it reports success.
#
# The source model path comes from the recipe acquisition contract: the model
# download step acquires nvidia/GLM-5.3-Flash-NVFP4 at its pinned revision into
# ${modelRoot}/nvidia--GLM-5.3-Flash-NVFP4, which is the same path the runtime
# binds to /models/glm53-flash-nvfp4.
#
# Source and output are mounted at the SAME absolute host paths inside the
# conversion container so relative symlinks in the overlay keep resolving
# inside the serving container, which mounts them identically.
#
# Conversion needs the GPU (--gpus=all), so a serving runtime must be stopped
# through the normal recipe install lifecycle first. This script never stops
# anything by itself.
#
# Usage: convert-overlay.sh --backend-root <path> [--install-root <path>] [--model-root <path>]
#                          [--overlay-root <path>] [--manifest <pins.json>]
#                          [--verify-only] [--force]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/pins.json"
VERIFY_PINS="${SCRIPT_DIR}/verify-pins.mjs"
BACKEND_ROOT=""
INSTALL_ROOT=""
MODEL_ROOT=""
OVERLAY_ROOT=""
VERIFY_ONLY=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend-root) BACKEND_ROOT="${2:-}"; shift 2 ;;
    --backend-root=*) BACKEND_ROOT="${1#*=}"; shift ;;
    --install-root) INSTALL_ROOT="${2:-}"; shift 2 ;;
    --install-root=*) INSTALL_ROOT="${1#*=}"; shift ;;
    --model-root) MODEL_ROOT="${2:-}"; shift 2 ;;
    --model-root=*) MODEL_ROOT="${1#*=}"; shift ;;
    --overlay-root) OVERLAY_ROOT="${2:-}"; shift 2 ;;
    --overlay-root=*) OVERLAY_ROOT="${1#*=}"; shift ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --manifest=*) MANIFEST="${1#*=}"; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "convert-overlay.sh: unexpected argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "${BACKEND_ROOT}" ]] || { echo "convert-overlay.sh: --backend-root is required" >&2; exit 2; }
[[ -n "${INSTALL_ROOT}" ]] || INSTALL_ROOT="${BACKEND_ROOT}"
[[ -n "${OVERLAY_ROOT}" ]] || OVERLAY_ROOT="${INSTALL_ROOT}/atlas-overlay"
[[ -f "${MANIFEST}" ]] || { echo "convert-overlay.sh: pin manifest not found: ${MANIFEST}" >&2; exit 2; }

[[ "${BACKEND_ROOT}" = /* ]] || { echo "convert-overlay.sh: --backend-root must be an absolute path" >&2; exit 2; }
[[ "${INSTALL_ROOT}" = /* ]] || { echo "convert-overlay.sh: --install-root must be an absolute path" >&2; exit 2; }
[[ "${MODEL_ROOT:-${LLOOM_MODEL_ROOT:-${HOME}/.lloom/models}}" = /* ]] \
  || { echo "convert-overlay.sh: --model-root (or LLOOM_MODEL_ROOT) must be an absolute path" >&2; exit 2; }
[[ "${OVERLAY_ROOT}" = /* ]] || { echo "convert-overlay.sh: --overlay-root must be an absolute path" >&2; exit 2; }

pin() { node -e 'const m=require(process.argv[1]);const p=process.argv[2].split(".");let v=m;for(const k of p){v=v?.[k];}process.stdout.write(typeof v==="string"?v:String(v??""))' "${MANIFEST}" "$1"; }

SOURCE_REPO="$(pin source.repo)"
SOURCE_REVISION="$(pin source.revision)"
SOURCE_BUILD_SCRIPT="$(pin source.buildScript)"
SOURCE_MANIFEST="$(pin installer.sourceManifest)"
IMAGE_TAG_PREFIX="$(pin image.tagPrefix)"
MODEL_REPO="$(pin model.repo)"
MODEL_REVISION="$(pin model.revision)"
MARKER_NAME="$(pin overlay.marker)"
[[ -n "${MARKER_NAME}" ]] || MARKER_NAME="conversion.complete.json"
CONVERTER_PATH="$(pin converter.inImagePath)"
CONVERTER_LIBRARY="$(pin converter.library)"
EXPECTED_MATRICES="$(pin converter.expectedMatrices)"

fail() { echo "atlas-sparkglm overlay: $*" >&2; exit 1; }
note() { echo "atlas-sparkglm overlay: $*"; }

IMAGE_TAG="${IMAGE_TAG_PREFIX}${SOURCE_REVISION}"
RECEIPT="${INSTALL_ROOT}/image-${SOURCE_REVISION}.json"
MODEL_DIR_NAME="${MODEL_REPO//\//--}"
[[ -n "${MODEL_ROOT}" ]] || MODEL_ROOT="${LLOOM_MODEL_ROOT:-${HOME}/.lloom/models}"
SOURCE_MODEL_PATH="${MODEL_ROOT}/${MODEL_DIR_NAME}"
MARKER="${OVERLAY_ROOT}/${MARKER_NAME}"
# Source, install root and overlay must remain separate even with --force.
node -e '
  const path = require("path");
  const fs = require("fs");
  const canonical = (value) => {
    let cursor = path.resolve(value), tail = [];
    while (!fs.existsSync(cursor)) { tail.unshift(path.basename(cursor)); cursor = path.dirname(cursor); }
    return path.join(fs.realpathSync(cursor), ...tail);
  };
  const [source, overlay, install] = process.argv.slice(1).map(canonical);
  const contains = (a, b) => a === b || b.startsWith(a + path.sep);
  if (overlay === path.parse(overlay).root || contains(overlay, source) || contains(source, overlay) || contains(overlay, install)) {
    throw new Error("overlay must be separate from source and cannot contain the install root");
  }
' "${SOURCE_MODEL_PATH}" "${OVERLAY_ROOT}" "${INSTALL_ROOT}"


node "${VERIFY_PINS}" "${MANIFEST}" \
  || fail "pin manifest ${MANIFEST} is not a final immutable install manifest; verify the source, image and model identities before overlay conversion runs"

command -v docker >/dev/null 2>&1 || fail "docker is required to run the in-image converter"

# ---- the prepared image must be the one this host built --------------------
[[ -f "${RECEIPT}" ]] \
  || fail "no build receipt at ${RECEIPT}; run backends/atlas-sparkglm/install.sh --backend-root ${BACKEND_ROOT} first"
LOCAL_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "${IMAGE_TAG}" 2>/dev/null || true)"
[[ -n "${LOCAL_IMAGE_ID}" ]] || fail "local image ${IMAGE_TAG} is not present; run install.sh first"
RECEIPT_IMAGE_ID="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).image_id ?? "")' "${RECEIPT}")"
[[ "${RECEIPT_IMAGE_ID}" == "${LOCAL_IMAGE_ID}" ]] \
  || fail "local image ${IMAGE_TAG} is ${LOCAL_IMAGE_ID} but this host's receipt records ${RECEIPT_IMAGE_ID}; rerun install.sh"
RECEIPT_MANIFEST_SHA256="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).manifest_sha256 ?? "")' "${RECEIPT}")"
SOURCE_ROOT="${INSTALL_ROOT}/sources/atlas-sparkglm-${SOURCE_REVISION}"
SOURCE_MANIFEST_PATH="${SOURCE_ROOT}/${SOURCE_MANIFEST}"
[[ -f "${SOURCE_MANIFEST_PATH}" ]] \
  || fail "source manifest ${SOURCE_MANIFEST_PATH} is missing; rerun install.sh from the pinned source checkout"
CURRENT_MANIFEST_SHA256="$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "${SOURCE_MANIFEST_PATH}")"
[[ "${RECEIPT_MANIFEST_SHA256}" == "${CURRENT_MANIFEST_SHA256}" ]] \
  || fail "build receipt manifest ${RECEIPT_MANIFEST_SHA256} does not match source manifest ${CURRENT_MANIFEST_SHA256}; rerun install.sh"
docker run --rm --entrypoint bash "${IMAGE_TAG}" -lc "test -f '${CONVERTER_PATH}' && test -f '${CONVERTER_LIBRARY}'" \
  || fail "image ${IMAGE_TAG} does not ship the converter contract (${CONVERTER_PATH}, ${CONVERTER_LIBRARY})"

# ---- marker + real verification -------------------------------------------
verify_marker() {
  [[ -f "${MARKER}" ]] || return 1
  node -e '
    const fs = require("fs");
    const marker = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const [expectedSource, expectedOutput, expectedMatrices] = process.argv.slice(2);
    const problems = [];
    if (!Number.isFinite(Number(marker.finished)) || Number(marker.finished) <= 0) problems.push(`finished=${marker.finished}`);
    if (marker.source !== expectedSource) problems.push(`source=${marker.source}`);
    if (marker.output !== expectedOutput) problems.push(`output=${marker.output}`);
    if (Number(marker.converted_matrices) !== Number(expectedMatrices)) problems.push(`converted_matrices=${marker.converted_matrices} (expected ${expectedMatrices})`);
    if (!marker.shards || typeof marker.shards !== "object" || Array.isArray(marker.shards) || Object.keys(marker.shards).length === 0) problems.push("shards is missing or empty");
    if (Object.hasOwn(marker, "status")) problems.push("status is not part of the conversion marker contract");
    if (problems.length) { process.stderr.write(problems.join("; ") + "\n"); process.exit(1); }
  ' "${MARKER}" "${SOURCE_MODEL_PATH}" "${OVERLAY_ROOT}" "${EXPECTED_MATRICES}" 2>/dev/null
}

verify_overlay() {
  local source_model_path="${1:-${SOURCE_MODEL_PATH}}"
  docker run --rm --runtime=runc \
    -e NVIDIA_VISIBLE_DEVICES=void \
    -v "$(dirname "${source_model_path}"):$(dirname "${source_model_path}"):ro" \
    -v "${source_model_path}:${source_model_path}:ro" \
    -v "$(dirname "${OVERLAY_ROOT}"):$(dirname "${OVERLAY_ROOT}")" \
    -v "${OVERLAY_ROOT}:${OVERLAY_ROOT}" \
    --entrypoint python3 "${IMAGE_TAG}" \
    "${CONVERTER_PATH}" --source "${source_model_path}" --output "${OVERLAY_ROOT}" --verify-overlay
}

if [[ "${VERIFY_ONLY}" == "1" ]]; then
  if ! verify_marker; then
    fail "no complete conversion marker at ${MARKER} (converted_matrices/shards/source/output/finished); the overlay is not prepared on this node"
  fi
  verify_overlay || fail "converter --verify-overlay failed for ${OVERLAY_ROOT}; the overlay is not usable"
  note "existing conversion re-verified by ${CONVERTER_PATH} at ${MARKER}"
  exit 0
fi

if [[ "${FORCE}" != "1" ]] && verify_marker && verify_overlay; then
  note "${OVERLAY_ROOT} already carries a converter-verified conversion; skipping (use --force to reconvert)"
  exit 0
fi

# A directory that exists without a complete marker is NOT treated as converted.
if [[ -e "${OVERLAY_ROOT}" && ! -f "${MARKER}" ]]; then
  note "${OVERLAY_ROOT} exists without ${MARKER_NAME}; not inferring completion from directory existence"
fi

[[ -d "${SOURCE_MODEL_PATH}" ]] \
  || fail "source model ${MODEL_REPO}@${MODEL_REVISION} is not at ${SOURCE_MODEL_PATH}. Install the recipe model acquisition step first (--model-root overrides ${MODEL_ROOT})."
[[ -f "${SOURCE_MODEL_PATH}/config.json" ]] \
  || fail "source model ${SOURCE_MODEL_PATH} does not look like a Hugging Face checkpoint (config.json missing)"

# Exact-revision check against the acquisition contract. Missing metadata is
# reported instead of silently passing.
if [[ -f "${SOURCE_MODEL_PATH}/.lloom-acquisition.json" ]]; then
  node -e '
    const fs = require("fs");
    const [file, expected] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const revision = manifest.revision ?? manifest.resolvedRevision ?? manifest.commit ?? null;
    if (revision !== expected) { process.stderr.write(`acquisition revision ${revision} != pinned ${expected}\n`); process.exit(1); }
  ' "${SOURCE_MODEL_PATH}/.lloom-acquisition.json" "${MODEL_REVISION}" \
    || fail "source model ${SOURCE_MODEL_PATH} is not pinned to revision ${MODEL_REVISION}"
else
  fail "no acquisition manifest at ${SOURCE_MODEL_PATH}; the recipe acquisition step must record revision ${MODEL_REVISION} before conversion"
fi

# ---- GPU headroom: at least 8 GiB free before conversion -------------------
GPU_FREE_MIB="$(node "${SCRIPT_DIR}/conversion-headroom.mjs")" \
  || fail "GPU headroom could not be established; conversion needs at least 8192 MiB free"
[[ "${GPU_FREE_MIB}" -ge 8192 ]] \
  || fail "only ${GPU_FREE_MIB} MiB is available; conversion needs at least 8192 MiB. Stop the serving runtime through the normal recipe lifecycle first."

ACTIVE_SERVER="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'atlas-sparkglm|glm53-flash-atlas' || true)"
[[ -z "${ACTIVE_SERVER}" ]] \
  || fail "Atlas SparkGLM serving container(s) still running: ${ACTIVE_SERVER}. Stop them through the normal recipe install lifecycle first; this installer never stops a serving runtime for you."

# ---- convert (requires a nonexistent output on first conversion) -----------
OUTPUT_PARENT="$(dirname "${OVERLAY_ROOT}")"
mkdir -p "${OUTPUT_PARENT}"
if [[ "${FORCE}" == "1" && -e "${OVERLAY_ROOT}" ]]; then
  # Keep the prior overlay recoverable, including completed conversions.
  BACKUP="${OVERLAY_ROOT}.before-reconvert-$(date -u +%Y%m%dT%H%M%SZ)"
  [[ ! -e "${BACKUP}" ]] || fail "backup path already exists: ${BACKUP}"
  note "--force requested; preserving ${OVERLAY_ROOT} at ${BACKUP}"
  mv -- "${OVERLAY_ROOT}" "${BACKUP}"
fi
[[ ! -e "${OVERLAY_ROOT}" ]] \
  || fail "conversion output ${OVERLAY_ROOT} already exists; the converter requires a nonexistent output. Remove it explicitly or run with --force."

note "converting ${MODEL_REPO}@${MODEL_REVISION} from ${SOURCE_MODEL_PATH} into ${OVERLAY_ROOT} (once per node, GPU)"
docker run --rm --gpus=all \
  -e NVIDIA_VISIBLE_DEVICES=all \
  -v "${SOURCE_MODEL_PATH}:${SOURCE_MODEL_PATH}:ro" \
  -v "${OUTPUT_PARENT}:${OUTPUT_PARENT}" \
  --entrypoint python3 "${IMAGE_TAG}" \
  "${CONVERTER_PATH}" --source "${SOURCE_MODEL_PATH}" --output "${OVERLAY_ROOT}" \
  --library "${CONVERTER_LIBRARY}"

verify_marker || fail "converter finished but ${MARKER} is absent or incomplete; refusing to report the overlay as prepared"
verify_overlay || fail "converter --verify-overlay failed for ${OVERLAY_ROOT} after conversion"
note "conversion verified by ${CONVERTER_PATH} at ${MARKER}"
