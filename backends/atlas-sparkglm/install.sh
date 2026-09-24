#!/usr/bin/env bash
# MIT. LLooM orchestration only.
#
# Builds (or verifies) the local Atlas SparkGLM image from an immutable source
# revision. This script contains no Atlas engine source: the engine lives in
# Enntity/sparkglm and is compiled by research/atlas/install/build.sh, which the
# parent owner implements separately. LLooM only orchestrates the checkout,
# delegates the build, and verifies the resulting local image identity against
# this host's own build receipt.
#
# The parent build script takes exactly one positional argument: INSTALL_ROOT.
# It writes image-<SOURCE_REVISION>.json under INSTALL_ROOT with
# {image, image_id, source_revision, manifest_sha256} and tags the local image
# lloom/atlas-sparkglm:<SOURCE_REVISION>. Image IDs are host-local, so identity
# is verified here against the local receipt and the local image inspect, never
# against a globally pinned digest.
#
# --check-only VERIFIES the installed image: receipt identity, the local image
# inspect ID, the source revision baked into the image OCI label, and that the
# image is arm64. It only falls back to reporting unbuilt pins when nothing has
# been installed yet.
#
# Usage: install.sh --backend-root <path> [--manifest <pins.json>] [--install-root <path>] [--check-only]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/pins.json"
VERIFY_PINS="${SCRIPT_DIR}/verify-pins.mjs"
BACKEND_ROOT=""
INSTALL_ROOT=""
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend-root) BACKEND_ROOT="${2:-}"; shift 2 ;;
    --backend-root=*) BACKEND_ROOT="${1#*=}"; shift ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --manifest=*) MANIFEST="${1#*=}"; shift ;;
    --install-root) INSTALL_ROOT="${2:-}"; shift 2 ;;
    --install-root=*) INSTALL_ROOT="${1#*=}"; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "install.sh: unexpected argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "${BACKEND_ROOT}" ]] || { echo "install.sh: --backend-root is required" >&2; exit 2; }
[[ -n "${INSTALL_ROOT}" ]] || INSTALL_ROOT="${BACKEND_ROOT}"
[[ -f "${MANIFEST}" ]] || { echo "install.sh: pin manifest not found: ${MANIFEST}" >&2; exit 2; }

pin() { node -e 'const m=require(process.argv[1]);const p=process.argv[2].split(".");let v=m;for(const k of p){v=v?.[k];}process.stdout.write(typeof v==="string"?v:String(v??""))' "${MANIFEST}" "$1"; }

STATUS="$(pin status)"
SOURCE_REVISION="$(pin source.revision)"
SOURCE_REPO="$(pin source.repo)"
CLONE_URL="$(pin source.cloneUrl)"
BUILD_SCRIPT="$(pin source.buildScript)"
SOURCE_MANIFEST="$(pin installer.sourceManifest)"
IMAGE_TAG_PREFIX="$(pin image.tagPrefix)"
IMAGE_ARCHITECTURE="$(pin image.architecture)"
ENTRYPOINT_PATH="$(pin image.entrypoint)"
PROFILE_PATH="$(pin image.profilePath)"
EXPECTED_MATRICES="$(pin converter.expectedMatrices)"
MODEL_REPO="$(pin model.repo)"
MODEL_REVISION="$(pin model.revision)"
CONVERTER_PATH="$(pin converter.inImagePath)"
CONVERTER_LIBRARY="$(pin converter.library)"

fail() { echo "atlas-sparkglm install: $*" >&2; exit 1; }
note() { echo "atlas-sparkglm install: $*"; }

IMAGE_TAG="${IMAGE_TAG_PREFIX}${SOURCE_REVISION}"
RECEIPT="${INSTALL_ROOT}/image-${SOURCE_REVISION}.json"
SOURCE_ROOT="${INSTALL_ROOT}/sources/atlas-sparkglm-${SOURCE_REVISION}"

verify_installed_image() {
  [[ -f "${RECEIPT}" ]] && [[ -n "$(docker image inspect --format '{{.Id}}' "${IMAGE_TAG}" 2>/dev/null || true)" ]] || {
    echo "atlas-sparkglm install: no installed image to verify for ${IMAGE_TAG}" >&2
    return 3
  }
  local local_id local_arch local_revision manifest_sha256 source_manifest_path
  local_id="$(docker image inspect --format '{{.Id}}' "${IMAGE_TAG}")"
  local_arch="$(docker image inspect --format '{{.Architecture}}' "${IMAGE_TAG}")"
  local_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${IMAGE_TAG}")"
  source_manifest_path="${SOURCE_ROOT}/${SOURCE_MANIFEST}"
  if [[ -f "${source_manifest_path}" ]]; then
    manifest_sha256="$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "${source_manifest_path}")"
  else
    manifest_sha256=""
  fi
  local problems_text
  problems_text="$(node -e '
    const fs = require("fs");
    const [receiptPath, tag, revision, imageId, architecture, imageRev, manifestSha256] = process.argv.slice(1);
    const problems = [];
    let receipt = null;
    try { receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")); }
    catch (error) { problems.push(`receipt ${receiptPath} is unreadable: ${error.message}`); }
    if (receipt) {
      if (receipt.image !== tag) problems.push(`receipt image ${receipt.image} != local tag ${tag}`);
      if (receipt.source_revision !== revision) problems.push(`receipt source_revision ${receipt.source_revision} != pinned ${revision}`);
      if (!/^sha256:[a-fA-F0-9]{64}$/.test(String(receipt.image_id ?? ""))) problems.push(`receipt image_id ${receipt.image_id} is not a complete sha256: identity`);
      if (!/^[a-fA-F0-9]{64}$/.test(String(receipt.manifest_sha256 ?? ""))) problems.push(`receipt manifest_sha256 ${receipt.manifest_sha256} is not a sha256 digest`);
      if (!manifestSha256) problems.push(`source manifest ${process.argv[8]} is missing`);
      else if (receipt.manifest_sha256 !== manifestSha256) problems.push(`receipt manifest_sha256 ${receipt.manifest_sha256} != source manifest ${manifestSha256}`);
      if (receipt.image_id !== imageId) problems.push(`receipt image_id ${receipt.image_id} != local image inspect ${imageId}`);
    }
    if (architecture !== "arm64") problems.push(`local image architecture ${architecture} must be arm64`);
    if (imageRev !== revision) problems.push(`image OCI label org.opencontainers.image.revision ${imageRev} != pinned ${revision}`);
    process.stdout.write(problems.join("\n"));
  ' "${RECEIPT}" "${IMAGE_TAG}" "${SOURCE_REVISION}" "${local_id}" "${local_arch}" "${local_revision}" "${manifest_sha256}" "${source_manifest_path}")" \
    || return 1
  local line
  while IFS= read -r line; do [[ -n "${line}" ]] && echo "atlas-sparkglm install: ${line}" >&2; done <<<"${problems_text}"
  [[ -z "${problems_text}" ]] || return 1
  note "installed image ${IMAGE_TAG} verified: id=${local_id} arch=${local_arch} revision=${local_revision} receipt=${RECEIPT}"
  return 0
}

run_in_image() { docker run --rm --entrypoint bash "${IMAGE_TAG}" -lc "$1"; }

verify_image_contract() {
  # Keep this check on the re-entry path as well as after a fresh build. A
  # valid receipt alone is insufficient if the image lost a serving or
  # conversion artifact.
  run_in_image "test -f '${ENTRYPOINT_PATH}' && test -f '${PROFILE_PATH}'" \
    || fail "image ${IMAGE_TAG} is missing the Atlas entrypoint/profile contract (${ENTRYPOINT_PATH}, ${PROFILE_PATH})"
  run_in_image "test -f '${CONVERTER_PATH}'" \
    || fail "image ${IMAGE_TAG} is missing the converter ${CONVERTER_PATH}; the parent engine build must ship it at that exact path"
  run_in_image "test -f '${CONVERTER_LIBRARY}'" \
    || fail "image ${IMAGE_TAG} is missing the converter library ${CONVERTER_LIBRARY}"
  if ! run_in_image "python3 '${CONVERTER_PATH}' --help" >/dev/null 2>&1; then
    fail "converter ${CONVERTER_PATH} in ${IMAGE_TAG} does not accept the documented --help surface"
  fi
  if ! run_in_image "python3 '${CONVERTER_PATH}' --help 2>&1 | grep -q -- '--verify-overlay'"; then
    fail "converter ${CONVERTER_PATH} in ${IMAGE_TAG} does not implement --verify-overlay; full verification is required for this lane"
  fi
  note "image ${IMAGE_TAG} ships ${CONVERTER_PATH} with --verify-overlay and ${CONVERTER_LIBRARY}"
}

verify_existing_source_checkout() {
  local origin_url head_revision dirty
  origin_url="$(git -C "${SOURCE_ROOT}" remote get-url origin 2>/dev/null || true)"
  [[ "${origin_url}" == "${CLONE_URL}" ]] \
    || fail "source checkout ${SOURCE_ROOT} has origin ${origin_url:-<none>}; expected ${CLONE_URL}. Refusing to reuse it and never rewriting remotes."
  head_revision="$(git -C "${SOURCE_ROOT}" rev-parse HEAD 2>/dev/null || true)"
  [[ "${head_revision}" == "${SOURCE_REVISION}" ]] \
    || fail "source checkout ${SOURCE_ROOT} is at ${head_revision:-<unknown>}; expected the pinned revision ${SOURCE_REVISION}. Move it aside or use a fresh --install-root; this installer will not reset or clean an existing checkout."
  dirty="$(git -C "${SOURCE_ROOT}" status --porcelain --untracked-files=all)"
  [[ -z "${dirty}" ]] \
    || fail "source checkout ${SOURCE_ROOT} has local changes; this installer will not clean or discard them. Move it aside or use a fresh --install-root."
}

if [[ "${CHECK_ONLY}" == "1" ]]; then
  command -v docker >/dev/null 2>&1 || fail "docker is required to verify the installed Atlas SparkGLM image"
  set +e
  verify_installed_image
  verify_status=$?
  set -e
  [[ "${verify_status}" -eq 3 ]] && {
    echo "atlas-sparkglm install: --check-only found no installed image for ${IMAGE_TAG}" >&2
    exit 1
  }
  [[ "${verify_status}" -eq 0 ]] || fail "installed Atlas SparkGLM image failed verification"
  node "${VERIFY_PINS}" "${MANIFEST}" \
    || fail "pin manifest ${MANIFEST} is not a final immutable install manifest; verify the source, image and model identities before an install can verify"
  exit 0
fi

# ---- pin gate: fail closed on portable pins --------------------------------
node "${VERIFY_PINS}" "${MANIFEST}" \
  || fail "pin manifest ${MANIFEST} is not a final immutable install manifest; verify the source, image and model identities before an install can verify"

PINS_DIGEST="$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "${MANIFEST}")"
note "pins ${MANIFEST} status=${STATUS} digest=sha256:${PINS_DIGEST}"
note "source ${SOURCE_REPO}@${SOURCE_REVISION}"
note "model ${MODEL_REPO}@${MODEL_REVISION}"
note "backend-root ${BACKEND_ROOT} install-root ${INSTALL_ROOT}"

command -v docker >/dev/null 2>&1 || fail "docker is required to build and verify the Atlas SparkGLM image"
command -v git >/dev/null 2>&1 || fail "git is required to check out the pinned Atlas source"

if [[ -e "${SOURCE_ROOT}" ]]; then
  [[ -d "${SOURCE_ROOT}/.git" ]] \
    || fail "${SOURCE_ROOT} exists but is not a git checkout; refusing to overwrite it"
  verify_existing_source_checkout
fi

# Re-entry is a verification operation when the exact local receipt/image
# already exists. This keeps an always-run recipe step idempotent without
# rebuilding a large image on every setup invocation. Any mismatch falls
# through to the normal immutable source checkout and build path.
if [[ -f "${RECEIPT}" ]] && docker image inspect --format '{{.Id}}' "${IMAGE_TAG}" >/dev/null 2>&1; then
  if verify_installed_image >/dev/null 2>&1; then
    verify_image_contract
    note "existing image ${IMAGE_TAG} and receipt verified; skipping rebuild"
    exit 0
  fi
fi

# ---- source checkout -------------------------------------------------------
#
# Existing checkouts are reused only when they are already on the exact pinned
# revision with the expected origin. Anything else fails clearly: this script
# never runs destructive checkout commands (no reset --hard, no clean, no
# checkouts that could discard local work).
mkdir -p "$(dirname "${SOURCE_ROOT}")"

if [[ -d "${SOURCE_ROOT}/.git" ]]; then
  verify_existing_source_checkout
  head_revision="$(git -C "${SOURCE_ROOT}" rev-parse HEAD)"
  note "reusing source checkout ${SOURCE_ROOT} at ${head_revision}"
else
  if [[ -e "${SOURCE_ROOT}" ]]; then
    fail "${SOURCE_ROOT} exists but is not a git checkout; refusing to overwrite it"
  fi
  note "cloning ${CLONE_URL} (no checkout) at ${SOURCE_ROOT}"
  GIT_LFS_SKIP_SMUDGE=1 git clone --filter=blob:none --no-checkout "${CLONE_URL}" "${SOURCE_ROOT}"
  [[ "$(git -C "${SOURCE_ROOT}" remote get-url origin)" == "${CLONE_URL}" ]] \
    || fail "fresh clone ${SOURCE_ROOT} has an unexpected origin"
  GIT_LFS_SKIP_SMUDGE=1 git -C "${SOURCE_ROOT}" fetch --no-tags origin "${SOURCE_REVISION}"
  GIT_LFS_SKIP_SMUDGE=1 git -C "${SOURCE_ROOT}" checkout --detach "${SOURCE_REVISION}"
fi

HEAD_REVISION="$(git -C "${SOURCE_ROOT}" rev-parse HEAD)"
[[ "${HEAD_REVISION}" == "${SOURCE_REVISION}" ]] \
  || fail "source HEAD ${HEAD_REVISION} does not match pinned SOURCE_REVISION ${SOURCE_REVISION}"

# ---- delegate the engine build to the pinned source ------------------------
BUILD_PATH="${SOURCE_ROOT}/${BUILD_SCRIPT}"
[[ -f "${BUILD_PATH}" ]] \
  || fail "pinned source is missing ${BUILD_SCRIPT}; the parent owner must land the Atlas build script in ${SOURCE_REPO}@${SOURCE_REVISION}"

note "running bash ${BUILD_PATH} ${INSTALL_ROOT} (parent build; image tag ${IMAGE_TAG})"
SOLVER_BIN=""
if command -v nvidia-smi >/dev/null 2>&1; then
  SOLVER_BIN="$(command -v nvidia-smi)"
fi
ATLAS_SOURCE_REVISION="${SOURCE_REVISION}" \
ATLAS_IMAGE_TAG="${IMAGE_TAG}" \
ATLAS_BACKEND_ROOT="${BACKEND_ROOT}" \
ATLAS_INSTALL_ROOT="${INSTALL_ROOT}" \
  PATH="${PATH}:/usr/local/nvidia/bin" TS_PRODUCT_SOLVER_BIN="${SOLVER_BIN}" \
  bash "${BUILD_PATH}" "${INSTALL_ROOT}"

# ---- verify the installed image identity against this host's receipt -------
verify_installed_image \
  || fail "installed image ${IMAGE_TAG} did not match this host's build receipt; refusing to report the lane as prepared"

# ---- image contract: entrypoint, profile and converter ship inside the image
verify_image_contract
[[ -n "${EXPECTED_MATRICES}" ]] \
  || note "warning: pins.json does not declare converter.expectedMatrices; conversion will not assert the matrix count"

note "image prepared. LLooM starts runtimes from this prepared image only; no build runs on the serving path."
note "next required gate is the per-node overlay conversion (backends/atlas-sparkglm/convert-overlay.sh)."
