#!/usr/bin/env bash
set -euo pipefail

# Build the exact MiaAI source revision used by recipe v10. The public :exl3
# image currently predates the compiled E2 fat-expert kernel, so changing only
# launch flags is not an equivalent refresh.
readonly UPSTREAM_URL="https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks.git"
readonly UPSTREAM_COMMIT="eb0469fbb2b49fd7c025f594a3339a121e58f7a9"
readonly IMAGE="lloom-glm53-mia-eb0469:exl3"

tmp_dir="$(mktemp -d -t lloom-glm53-mia.XXXXXX)"
cleanup() {
  case "${tmp_dir}" in
    /tmp/lloom-glm53-mia.*|/private/tmp/lloom-glm53-mia.*) rm -rf -- "${tmp_dir}" ;;
  esac
}
trap cleanup EXIT

git clone --filter=blob:none "${UPSTREAM_URL}" "${tmp_dir}/source"
git -C "${tmp_dir}/source" checkout --detach "${UPSTREAM_COMMIT}"
actual="$(git -C "${tmp_dir}/source" rev-parse HEAD)"
[[ "${actual}" == "${UPSTREAM_COMMIT}" ]] || {
  printf 'source pin mismatch: expected %s, got %s\n' "${UPSTREAM_COMMIT}" "${actual}" >&2
  exit 1
}

docker build \
  --build-arg "GLM53_RECIPE_STAMP=${UPSTREAM_COMMIT}" \
  --tag "${IMAGE}" \
  "${tmp_dir}/source"

if [[ -n "${WORKER_SSH:-}" ]]; then
  printf 'shipping %s to %s\n' "${IMAGE}" "${WORKER_SSH}"
  docker save "${IMAGE}" | ssh -o BatchMode=yes "${WORKER_SSH}" docker load
fi

docker image inspect \
  --format 'image={{index .RepoTags 0}} id={{.Id}} source=eb0469fbb2b49fd7c025f594a3339a121e58f7a9 recipe={{index .Config.Labels "glm53.recipe.stamp"}}' \
  "${IMAGE}"
