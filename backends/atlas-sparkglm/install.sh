#!/usr/bin/env bash
# MIT. LLooM orchestration only.
#
# Prepares (or verifies) the Atlas SparkGLM image pinned in pins.json. This
# script contains no Atlas engine source: the engine is built by
# install/build.sh in Enntity/sparkglm. The image tag is derived from the git
# tree of that repository's install/ directory, and the image carries the full
# tree in its io.enntity.sparkglm.install-tree label, so an image pulled from
# GHCR and one built locally from the pinned source have the same identity.
#
# Identity: the pinned tag exists locally, is arm64, and its install-tree label
# equals the pinned tree. Image IDs are never compared.
#
# Flow: an already verified image is reused; otherwise the pinned tag is
# pulled; otherwise the pinned source is checked out and built. Every path
# ends with the identity check plus the in-image serving/conversion contract.
#
# --check-only only VERIFIES the local image identity and in-image contract.
# A missing image or incomplete contract fails verification.
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
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "install.sh: unexpected argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "${BACKEND_ROOT}" ]] || { echo "install.sh: --backend-root is required" >&2; exit 2; }
[[ -n "${INSTALL_ROOT}" ]] || INSTALL_ROOT="${BACKEND_ROOT}"
[[ -f "${MANIFEST}" ]] || { echo "install.sh: pin manifest not found: ${MANIFEST}" >&2; exit 2; }

pin() { node -e 'const m=require(process.argv[1]);const p=process.argv[2].split(".");let v=m;for(const k of p){v=v?.[k];}process.stdout.write(typeof v==="string"?v:String(v??""))' "${MANIFEST}" "$1"; }

STATUS="$(pin status)"
SOURCE_REVISION="$(pin source.revision)"
INSTALL_TREE="$(pin source.installTree)"
SOURCE_REPO="$(pin source.repo)"
CLONE_URL="$(pin source.cloneUrl)"
BUILD_SCRIPT="$(pin source.buildScript)"
IMAGE_TAG="$(pin image.tag)"
IMAGE_LABEL="$(pin image.label)"
IMAGE_ARCHITECTURE="$(pin image.architecture)"
ENTRYPOINT_PATH="$(pin image.entrypoint)"
PROFILE_PATH="$(pin image.profilePath)"
MODEL_REPO="$(pin model.repo)"
MODEL_REVISION="$(pin model.revision)"
CONVERTER_PATH="$(pin converter.inImagePath)"
CONVERTER_LIBRARY="$(pin converter.library)"

fail() { echo "atlas-sparkglm install: $*" >&2; exit 1; }
note() { echo "atlas-sparkglm install: $*"; }

SOURCE_ROOT="${INSTALL_ROOT}/sources/atlas-sparkglm-${SOURCE_REVISION}"

verify_image_identity() {
  local identity
  identity="$(docker image inspect --format "{{.Architecture}} {{index .Config.Labels \"${IMAGE_LABEL}\"}}" "${IMAGE_TAG}" 2>/dev/null)" || {
    echo "atlas-sparkglm install: image ${IMAGE_TAG} is not present locally" >&2
    return 1
  }
  [[ "${identity}" == "${IMAGE_ARCHITECTURE} ${INSTALL_TREE}" ]] || {
    echo "atlas-sparkglm install: image ${IMAGE_TAG} has architecture and ${IMAGE_LABEL} '${identity}'; expected '${IMAGE_ARCHITECTURE} ${INSTALL_TREE}'" >&2
    return 1
  }
  note "image ${IMAGE_TAG} verified: arch=${IMAGE_ARCHITECTURE} ${IMAGE_LABEL}=${INSTALL_TREE}"
}

run_in_image() { docker run --rm --entrypoint bash "${IMAGE_TAG}" -lc "$1"; }

verify_image_contract() {
  # Run on every path, including re-entry: a matching label alone does not
  # prove the image still ships its serving and conversion artifacts.
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

# ---- pin gate: fail closed on portable pins --------------------------------
node "${VERIFY_PINS}" "${MANIFEST}" \
  || fail "pin manifest ${MANIFEST} is not a final immutable install manifest; verify the source, image and model identities before an install can verify"

command -v docker >/dev/null 2>&1 || fail "docker is required to prepare and verify the Atlas SparkGLM image"

if [[ "${CHECK_ONLY}" == "1" ]]; then
  verify_image_identity || fail "installed Atlas SparkGLM image failed verification"
  verify_image_contract
  exit 0
fi

PINS_DIGEST="$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "${MANIFEST}")"
note "pins ${MANIFEST} status=${STATUS} digest=sha256:${PINS_DIGEST}"
note "source ${SOURCE_REPO}@${SOURCE_REVISION} install tree ${INSTALL_TREE}"
note "model ${MODEL_REPO}@${MODEL_REVISION}"
note "backend-root ${BACKEND_ROOT} install-root ${INSTALL_ROOT}"

prepared() {
  verify_image_contract
  note "image prepared. LLooM starts runtimes from this prepared image only; no build runs on the serving path."
  note "next required gate is the per-node overlay conversion (backends/atlas-sparkglm/convert-overlay.sh)."
  exit 0
}

# Re-entry is a verification operation when the pinned image is already here.
# This keeps an always-run recipe step idempotent without pulling or
# rebuilding a large image on every setup invocation.
if verify_image_identity 2>/dev/null; then
  note "existing image ${IMAGE_TAG} verified; skipping pull and build"
  prepared
fi

note "pulling ${IMAGE_TAG}"
if docker pull "${IMAGE_TAG}" && verify_image_identity; then
  prepared
fi
note "no verified image from ${IMAGE_TAG%:*}; building from the pinned source"

command -v git >/dev/null 2>&1 || fail "git is required to check out the pinned Atlas source"

# ---- source checkout -------------------------------------------------------
#
# Existing checkouts are reused only when they are already on the exact pinned
# revision with the expected origin. Anything else fails clearly: this script
# never runs destructive checkout commands (no reset --hard, no clean, no
# checkouts that could discard local work).
mkdir -p "$(dirname "${SOURCE_ROOT}")"

if [[ -d "${SOURCE_ROOT}/.git" ]]; then
  verify_existing_source_checkout
  note "reusing source checkout ${SOURCE_ROOT} at ${SOURCE_REVISION}"
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
HEAD_INSTALL_TREE="$(git -C "${SOURCE_ROOT}" rev-parse HEAD:install)"
[[ "${HEAD_INSTALL_TREE}" == "${INSTALL_TREE}" ]] \
  || fail "source install tree ${HEAD_INSTALL_TREE} does not match pinned install tree ${INSTALL_TREE}"

# ---- delegate the engine build to the pinned source ------------------------
BUILD_PATH="${SOURCE_ROOT}/${BUILD_SCRIPT}"
[[ -f "${BUILD_PATH}" ]] \
  || fail "pinned source is missing ${BUILD_SCRIPT}; expected it in ${SOURCE_REPO}@${SOURCE_REVISION}"

note "running bash ${BUILD_PATH} (build logs on stderr; expected tag ${IMAGE_TAG})"
BUILT_TAG="$(SPARKGLM_IMAGE_REPO="${IMAGE_TAG%:*}" bash "${BUILD_PATH}")" \
  || fail "${BUILD_SCRIPT} failed"
[[ "${BUILT_TAG}" == "${IMAGE_TAG}" ]] \
  || fail "${BUILD_SCRIPT} printed tag ${BUILT_TAG}; expected the pinned ${IMAGE_TAG}"

verify_image_identity \
  || fail "built image ${IMAGE_TAG} did not match the pinned install tree; refusing to report the lane as prepared"
prepared
