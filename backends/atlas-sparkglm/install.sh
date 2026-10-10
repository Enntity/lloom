#!/usr/bin/env bash
# MIT. LLooM orchestration only.
#
# Prepares (or verifies) the Atlas SparkGLM image pinned in pins.json. This
# script contains no Atlas engine source: the engine is built by
# install/build.sh in Enntity/sparkglm.
#
# The normal path addresses the immutable registry digest in the manifest
# (image.reference, ghcr.io/...@sha256:...). The tag is source-build metadata
# and the local tag produced by an explicit --source-build; it is never pulled,
# and a tag alone is never treated as the artifact identity. The image's
# io.enntity.sparkglm.install-tree label is a contents check: it is arm64 and
# the label must equal the pinned install tree. Image IDs are never compared.
#
# Flow: an already verified local image is reused; otherwise the immutable
# reference is pulled. A failed pinned digest pull is a hard failure: the
# installer never silently falls back to a mutable tag or to a source build.
# The pinned source is checked out and built only with the explicit
# --source-build option, and that build produces a LOCAL tag (see --help). Every
# path ends with the contents/contract check plus the in-image serving and
# conversion contract.
#
# --check-only only VERIFIES the local image identity and in-image contract.
# A missing image or incomplete contract fails verification.
#
# --source-build deliberately verifies a local source build from the pinned
# revision; it does not satisfy the normal immutable recipe, which addresses
# image.reference.
#
# Usage: install.sh --backend-root <path> [--manifest <pins.json>] [--install-root <path>] [--check-only] [--source-build]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/pins.json"
VERIFY_PINS="${SCRIPT_DIR}/verify-pins.mjs"
BACKEND_ROOT=""
INSTALL_ROOT=""
CHECK_ONLY=0
SOURCE_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend-root) BACKEND_ROOT="${2:-}"; shift 2 ;;
    --backend-root=*) BACKEND_ROOT="${1#*=}"; shift ;;
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --manifest=*) MANIFEST="${1#*=}"; shift ;;
    --install-root) INSTALL_ROOT="${2:-}"; shift 2 ;;
    --install-root=*) INSTALL_ROOT="${1#*=}"; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    --source-build) SOURCE_BUILD=1; shift ;;
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
INSTALL_TREE="$(pin source.installTree)"
SOURCE_REPO="$(pin source.repo)"
CLONE_URL="$(pin source.cloneUrl)"
BUILD_SCRIPT="$(pin source.buildScript)"
IMAGE_REFERENCE="$(pin image.reference)"
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
  local target="${1:-${IMAGE_TAG}}"
  local identity
  identity="$(docker image inspect --format "{{.Architecture}} {{index .Config.Labels \"${IMAGE_LABEL}\"}}" "${target}" 2>/dev/null)" || {
    echo "atlas-sparkglm install: image ${target} is not present locally" >&2
    return 1
  }
  [[ "${identity}" == "${IMAGE_ARCHITECTURE} ${INSTALL_TREE}" ]] || {
    echo "atlas-sparkglm install: image ${target} has architecture and ${IMAGE_LABEL} '${identity}'; expected '${IMAGE_ARCHITECTURE} ${INSTALL_TREE}'" >&2
    return 1
  }
  note "image ${target} verified: arch=${IMAGE_ARCHITECTURE} ${IMAGE_LABEL}=${INSTALL_TREE}"
}

run_in_image() { docker run --rm --entrypoint bash "${1}" -lc "${2}"; }

verify_image_contract() {
  local target="${1:-${IMAGE_TAG}}"
  # Run on every path, including re-entry: a matching label alone does not
  # prove the image still ships its serving and conversion artifacts.
  run_in_image "${target}" "test -f '${ENTRYPOINT_PATH}' && test -f '${PROFILE_PATH}'" \
    || fail "image ${target} is missing the Atlas entrypoint/profile contract (${ENTRYPOINT_PATH}, ${PROFILE_PATH})"
  run_in_image "${target}" "test -f '${CONVERTER_PATH}'" \
    || fail "image ${target} is missing the converter ${CONVERTER_PATH}; the parent engine build must ship it at that exact path"
  run_in_image "${target}" "test -f '${CONVERTER_LIBRARY}'" \
    || fail "image ${target} is missing the converter library ${CONVERTER_LIBRARY}"
  if ! run_in_image "${target}" "python3 '${CONVERTER_PATH}' --help" >/dev/null 2>&1; then
    fail "converter ${CONVERTER_PATH} in ${target} does not accept the documented --help surface"
  fi
  if ! run_in_image "${target}" "python3 '${CONVERTER_PATH}' --help 2>&1 | grep -q -- '--verify-overlay'"; then
    fail "converter ${CONVERTER_PATH} in ${target} does not implement --verify-overlay; full verification is required for this lane"
  fi
  note "image ${target} ships ${CONVERTER_PATH} with --verify-overlay and ${CONVERTER_LIBRARY}"
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

if [[ "${CHECK_ONLY}" == "1" && "${SOURCE_BUILD}" == "1" ]]; then
  note "--check-only with --source-build verifies the local source-build tag ${IMAGE_TAG} from the pinned revision (this does not satisfy the normal immutable recipe, which addresses ${IMAGE_REFERENCE})"
  verify_image_identity "${IMAGE_TAG}" || fail "local source-build image ${IMAGE_TAG} failed verification; build it with --source-build"
  verify_image_contract "${IMAGE_TAG}"
  exit 0
fi

if [[ "${CHECK_ONLY}" == "1" ]]; then
  verify_image_identity "${IMAGE_REFERENCE}" \
    || fail "installed Atlas SparkGLM image ${IMAGE_REFERENCE} failed verification; --check-only never pulls or builds"
  verify_image_contract "${IMAGE_REFERENCE}"
  exit 0
fi

PINS_DIGEST="$(node -e 'const fs=require("fs"),c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "${MANIFEST}")"
note "pins ${MANIFEST} status=${STATUS} digest=sha256:${PINS_DIGEST}"
note "image reference ${IMAGE_REFERENCE}"
note "source-build metadata tag ${IMAGE_TAG} (source ${SOURCE_REPO}@${SOURCE_REVISION} install tree ${INSTALL_TREE})"
note "model ${MODEL_REPO}@${MODEL_REVISION}"
note "backend-root ${BACKEND_ROOT} install-root ${INSTALL_ROOT}"

prepared() {
  local target="$1"
  verify_image_contract "${target}"
  note "image prepared. LLooM starts runtimes from this prepared image only; no build runs on the serving path."
  note "next required gate is the per-node overlay conversion (backends/atlas-sparkglm/convert-overlay.sh)."
  exit 0
}

# ---- explicit local source build -------------------------------------------
#
# Only an explicit --source-build reaches here. The build produces a LOCAL tag
# (${IMAGE_TAG}) for an explicitly overridden local recipe; it does NOT satisfy
# the normal immutable recipe, which addresses ${IMAGE_REFERENCE}.
source_build() {
  command -v git >/dev/null 2>&1 || fail "git is required to check out the pinned Atlas source"

  # ---- source checkout -----------------------------------------------------
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

  # ---- delegate the engine build to the pinned source ----------------------
  BUILD_PATH="${SOURCE_ROOT}/${BUILD_SCRIPT}"
  [[ -f "${BUILD_PATH}" ]] \
    || fail "pinned source is missing ${BUILD_SCRIPT}; expected it in ${SOURCE_REPO}@${SOURCE_REVISION}"

  note "running bash ${BUILD_PATH} (build logs on stderr; expected local tag ${IMAGE_TAG})"
  BUILT_TAG="$(SPARKGLM_IMAGE_REPO="${IMAGE_TAG%:*}" bash "${BUILD_PATH}")" \
    || fail "${BUILD_SCRIPT} failed"
  [[ "${BUILT_TAG}" == "${IMAGE_TAG}" ]] \
    || fail "${BUILD_SCRIPT} printed tag ${BUILT_TAG}; expected the pinned ${IMAGE_TAG}"

  verify_image_identity "${IMAGE_TAG}" \
    || fail "built image ${IMAGE_TAG} did not match the pinned install tree; refusing to report the lane as prepared"
  note "source build produced LOCAL tag ${IMAGE_TAG}; this satisfies --source-build only and does not satisfy the normal immutable recipe (${IMAGE_REFERENCE})"
  prepared "${IMAGE_TAG}"
}

if [[ "${SOURCE_BUILD}" == "1" ]]; then
  source_build
fi

# ---- normal immutable digest path ------------------------------------------
#
# Re-entry is a verification operation when the pinned image is already here.
# This keeps an always-run recipe step idempotent without pulling a large image
# on every setup invocation.
if verify_image_identity "${IMAGE_REFERENCE}" 2>/dev/null; then
  note "existing image ${IMAGE_REFERENCE} verified; skipping pull"
  prepared "${IMAGE_REFERENCE}"
fi

note "pulling ${IMAGE_REFERENCE}"
docker pull "${IMAGE_REFERENCE}" \
  || fail "could not pull the pinned immutable image ${IMAGE_REFERENCE}; refusing to fall back to the mutable tag ${IMAGE_TAG} or to a source build. Retry the digest pull or build explicitly with --source-build."
verify_image_identity "${IMAGE_REFERENCE}" \
  || fail "pulled image ${IMAGE_REFERENCE} failed the install-tree contents check; refusing to build from source silently. Fix the digest pin or build explicitly with --source-build."
prepared "${IMAGE_REFERENCE}"
