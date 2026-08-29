#!/usr/bin/env bash
set -euo pipefail

script_root="$(cd "$(dirname "$0")" && pwd)"
build_root="${DSPARK_BUILD_ROOT:-${HOME}/.cache/lloom/dspark-vllm-build}"
anemll_root="${build_root}/anemll"
vllm_root="${build_root}/vllm"

anemll_repository="https://github.com/Anemll/dspark-vllm-gx10.git"
anemll_commit="47503f8e38dadd4dededca798150db2619594fce"
vllm_repository="https://github.com/vllm-project/vllm.git"
vllm_commit="752a3a504485790a2e8491cacbb35c137339ad34"
base_image="${DSPARK_VLLM_BASE_IMAGE:-lloom/dspark-vllm-gx10:vllm-base-51538}"
final_image="${DSPARK_FINAL_IMAGE:-lloom/dspark-vllm-gx10:0.1.1-vllm51538}"

mkdir -p "${build_root}"
if [ ! -d "${anemll_root}/.git" ]; then
  git clone "${anemll_repository}" "${anemll_root}"
fi
git -C "${anemll_root}" fetch --tags origin
git -C "${anemll_root}" checkout --detach "${anemll_commit}"
git -C "${anemll_root}" reset --hard "${anemll_commit}"
git -C "${anemll_root}" clean -fdx

if [ ! -d "${vllm_root}/.git" ]; then
  git clone "${vllm_repository}" "${vllm_root}"
fi
git -C "${vllm_root}" fetch --tags origin
git -C "${vllm_root}" checkout --detach "${vllm_commit}"
git -C "${vllm_root}" reset --hard "${vllm_commit}"
git -C "${vllm_root}" clean -fdx

rsync -a "${anemll_root}/overlay/vllm/" "${vllm_root}/vllm/"
git -C "${vllm_root}" apply "${script_root}/patches/vllm-318d623b-clamp-indexer-lengths.patch"
git -C "${vllm_root}" apply "${script_root}/patches/vllm-f633bd67-harden-topk-lengths.patch"

docker build \
  --file "${vllm_root}/docker/Dockerfile" \
  --target vllm-openai \
  --build-arg torch_cuda_arch_list=12.1a \
  --build-arg max_jobs="${DSPARK_BUILD_MAX_JOBS:-16}" \
  --build-arg nvcc_threads="${DSPARK_BUILD_NVCC_THREADS:-2}" \
  --label org.opencontainers.image.revision.vllm="${vllm_commit}+318d623b+f633bd67" \
  --label org.opencontainers.image.revision.anemll="${anemll_commit}" \
  --tag "${base_image}" \
  "${vllm_root}"

# shellcheck disable=SC1091
source "${anemll_root}/upstream.lock"
docker build \
  --file "${anemll_root}/docker/Dockerfile.runtime" \
  --build-arg VLLM_BASE="${base_image}" \
  --build-arg FLASHINFER_COMMIT="${FLASHINFER_COMMIT}" \
  --build-arg B12X_COMMIT="${B12X_COMMIT}" \
  --build-arg CUTLASS_DSL_VERSION="${CUTLASS_DSL_VERSION}" \
  --build-arg CUDA_PYTHON_VERSION="${CUDA_PYTHON_VERSION}" \
  --build-arg TVM_FFI_VERSION="${TVM_FFI_VERSION}" \
  --label org.opencontainers.image.source="https://github.com/Enntity/lloom" \
  --label org.opencontainers.image.revision.vllm="${vllm_commit}+318d623b+f633bd67" \
  --label org.opencontainers.image.revision.anemll="${anemll_commit}" \
  --tag "${final_image}" \
  "${anemll_root}"

docker image inspect "${final_image}" --format '{{.Id}} {{json .RepoTags}}'
