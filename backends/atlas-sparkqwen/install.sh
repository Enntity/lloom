#!/usr/bin/env bash
# MIT. LLooM orchestration only.
#
# Prepares (or verifies) the Atlas SparkQwen image pinned in pins.json. This
# script contains no Atlas engine source and never builds: the engine image is
# built by install/build.sh in Enntity/sparkqwen and published to GHCR.
#
# The image is addressed by its immutable registry digest (image.reference,
# ghcr.io/...@sha256:...). The mutable tag is never pulled. The pulled image
# must be arm64 and carry io.enntity.sparkqwen.install-tree equal to the pinned
# install tree (a contents check), and ship the serving entrypoint, the profile
# the recipe selects and the pinned engine commit in its source manifest.
#
# An already verified local image is reused; otherwise the digest is pulled. A
# failed pull or a failed check is a hard failure with no fallback.
#
# --check-only verifies the local image without pulling.
#
# Usage: install.sh [--manifest <pins.json>] [--check-only]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/pins.json"
CHECK_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --manifest=*) MANIFEST="${1#*=}"; shift ;;
    --check-only) CHECK_ONLY=1; shift ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "install.sh: unexpected argument: $1" >&2; exit 2 ;;
  esac
done

[[ -f "${MANIFEST}" ]] || { echo "install.sh: pin manifest not found: ${MANIFEST}" >&2; exit 2; }

fail() { echo "atlas-sparkqwen install: $*" >&2; exit 1; }
note() { echo "atlas-sparkqwen install: $*"; }

# ---- pin gate: fail closed on placeholder pins -----------------------------
node "${SCRIPT_DIR}/verify-pins.mjs" "${MANIFEST}" \
  || fail "pin manifest ${MANIFEST} is not a final immutable install manifest; record the image digest before installing"

pin() { node -e 'const m=require(process.argv[1]);let v=m;for(const k of process.argv[2].split(".")){v=v?.[k];}process.stdout.write(String(v??""))' "${MANIFEST}" "$1"; }

INSTALL_TREE="$(pin source.installTree)"
ENGINE_COMMIT="$(pin engine.commit)"
IMAGE_REFERENCE="$(pin image.reference)"
IMAGE_LABEL="$(pin image.label)"
IMAGE_ARCHITECTURE="$(pin image.architecture)"
ENTRYPOINT_PATH="$(pin image.entrypoint)"
PROFILE_PATH="$(pin image.profilePath)"

command -v docker >/dev/null 2>&1 || fail "docker is required to prepare and verify the Atlas SparkQwen image"

verify_image_identity() {
  local identity
  identity="$(docker image inspect --format "{{.Architecture}} {{index .Config.Labels \"${IMAGE_LABEL}\"}}" "${IMAGE_REFERENCE}" 2>/dev/null)" || {
    echo "atlas-sparkqwen install: image ${IMAGE_REFERENCE} is not present locally" >&2
    return 1
  }
  [[ "${identity}" == "${IMAGE_ARCHITECTURE} ${INSTALL_TREE}" ]] || {
    echo "atlas-sparkqwen install: image ${IMAGE_REFERENCE} has architecture and ${IMAGE_LABEL} '${identity}'; expected '${IMAGE_ARCHITECTURE} ${INSTALL_TREE}'" >&2
    return 1
  }
  note "image ${IMAGE_REFERENCE} verified: arch=${IMAGE_ARCHITECTURE} ${IMAGE_LABEL}=${INSTALL_TREE}"
}

verify_image_contract() {
  # Run on every path: a matching label alone does not prove the image ships
  # the serving entrypoint, the selected profile and the pinned engine.
  docker run --rm --entrypoint bash "${IMAGE_REFERENCE}" -lc \
    "test -f '${ENTRYPOINT_PATH}' && test -f '${PROFILE_PATH}' && grep -q '\"${ENGINE_COMMIT}\"' /opt/atlas/source-manifest.json" \
    || fail "image ${IMAGE_REFERENCE} is missing ${ENTRYPOINT_PATH}, ${PROFILE_PATH} or engine commit ${ENGINE_COMMIT} in /opt/atlas/source-manifest.json"
  note "image ${IMAGE_REFERENCE} ships ${ENTRYPOINT_PATH}, ${PROFILE_PATH} and engine ${ENGINE_COMMIT}"
}

if [[ "${CHECK_ONLY}" == "1" ]]; then
  verify_image_identity || fail "installed Atlas SparkQwen image ${IMAGE_REFERENCE} failed verification; --check-only never pulls"
  verify_image_contract
  exit 0
fi

if verify_image_identity 2>/dev/null; then
  note "existing image ${IMAGE_REFERENCE} verified; skipping pull"
else
  note "pulling ${IMAGE_REFERENCE}"
  docker pull "${IMAGE_REFERENCE}" \
    || fail "could not pull the pinned immutable image ${IMAGE_REFERENCE}; refusing to fall back to a mutable tag or a build"
  verify_image_identity \
    || fail "pulled image ${IMAGE_REFERENCE} failed the install-tree contents check; fix the digest pin"
fi
verify_image_contract
note "image prepared. LLooM starts runtimes from this image only; nothing is built on the serving path."
