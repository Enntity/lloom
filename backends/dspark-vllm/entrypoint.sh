#!/usr/bin/env bash
set -euo pipefail

# LLooM's two-node launcher follows the runtime contract validated by MiaAI Lab's
# DeepSeek V4 Flash DSpark recipe, while resolving each node's RoCE GID locally.
# Upstream: https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark

: "${NODE_ADDRESS:?NODE_ADDRESS is required}"
: "${FABRIC_INTERFACE:?FABRIC_INTERFACE is required}"
: "${MASTER_ADDR:?MASTER_ADDR is required}"
: "${NODE_RANK:?NODE_RANK is required}"

if [ -z "${NCCL_IB_HCA:-}" ]; then
  for net_path in /sys/class/infiniband/*/device/net/"${FABRIC_INTERFACE}"; do
    if [ -e "${net_path}" ]; then
      NCCL_IB_HCA="$(basename "$(dirname "$(dirname "$(dirname "${net_path}")")")")"
      break
    fi
  done
fi
: "${NCCL_IB_HCA:?Could not resolve RDMA HCA for ${FABRIC_INTERFACE}}"

ipv4_gid_suffix() {
  local a b c d
  IFS=. read -r a b c d <<<"$1"
  printf '%02x%02x:%02x%02x' "$a" "$b" "$c" "$d"
}

if [ -z "${NCCL_IB_GID_INDEX:-}" ]; then
  suffix="$(ipv4_gid_suffix "${NODE_ADDRESS}")"
  for gid_path in /sys/class/infiniband/"${NCCL_IB_HCA}"/ports/1/gids/*; do
    [ -e "${gid_path}" ] || continue
    gid_index="${gid_path##*/}"
    gid_type="$(cat "/sys/class/infiniband/${NCCL_IB_HCA}/ports/1/gid_attrs/types/${gid_index}" 2>/dev/null || true)"
    [ "${gid_type}" = "RoCE v2" ] || continue
    case "$(cat "${gid_path}")" in
      *ffff:"${suffix}") NCCL_IB_GID_INDEX="${gid_index}"; break ;;
    esac
  done
fi
: "${NCCL_IB_GID_INDEX:?Could not resolve RoCE v2 GID for ${NCCL_IB_HCA}/${NODE_ADDRESS}}"
export NCCL_IB_HCA NCCL_IB_GID_INDEX

export PATH="/usr/local/cuda/bin:/usr/local/bin:${PATH:-}"
export CUDA_HOME="${CUDA_HOME:-/usr/local/cuda}"
export CUDA_PATH="${CUDA_PATH:-${CUDA_HOME}}"
export CUDAToolkit_ROOT="${CUDAToolkit_ROOT:-${CUDA_HOME}}"
export LD_LIBRARY_PATH="/usr/local/cuda/lib64:${LD_LIBRARY_PATH:-}"

encoding_source=""
for candidate in /cache/huggingface/hub/models--deepseek-ai--DeepSeek-V4-Flash-0731/snapshots/*/encoding/encoding_dsv4.py; do
  if [ -f "${candidate}" ]; then encoding_source="${candidate}"; break; fi
done
if [ -n "${encoding_source}" ]; then
  cp "${encoding_source}" /usr/local/lib/python3.12/dist-packages/vllm/tokenizers/deepseek_v4_encoding.py
fi

pack_runner="${DSPARK_PATCH_PACK_RUNNER:-/opt/lloom/apply-patch-pack.py}"
pack_manifest="${DSPARK_PATCH_PACK_MANIFEST:-/opt/lloom/patch-pack/manifest.json}"
vllm_root="${VLLM_ROOT:-/usr/local/lib/python3.12/dist-packages/vllm}"
: "${DSPARK_RUNTIME_IMAGE:?DSPARK_RUNTIME_IMAGE is required for patch-pack compatibility checks}"
if [ ! -f "${pack_runner}" ] || [ ! -f "${pack_manifest}" ]; then
  echo "Required DSv4 patch pack is missing: ${pack_runner} / ${pack_manifest}" >&2
  exit 1
fi

python3 "${pack_runner}" \
  --manifest "${pack_manifest}" \
  --runtime-image "${DSPARK_RUNTIME_IMAGE}" \
  --model "${DSPARK_MODEL:-deepseek-ai/DeepSeek-V4-Flash-0731}" \
  --model-revision "${DSPARK_MODEL_REVISION:-9e165c30e2704aec5d9d593cce3eebd58bbef1cb}" \
  --vllm-root "${vllm_root}"

python3 - <<'PY'
from pathlib import Path

path = Path("/usr/local/lib/python3.12/dist-packages/vllm/tokenizers/deepseek_v4.py")
source = path.read_text()
old = '''elif reasoning_effort in ("max", "xhigh"):
                reasoning_effort = "max"
            else:
                reasoning_effort = "high"'''
new = '''elif reasoning_effort in ("max", "xhigh"):
                reasoning_effort = "max"
            elif reasoning_effort == "high":
                reasoning_effort = "high"
            else:
                reasoning_effort = "low"'''
if new not in source:
    updated = source.replace(old, new)
    if updated == source:
        raise RuntimeError("DeepSeek V4 reasoning-effort compatibility patch no longer matches the pinned image")
    path.write_text(updated)
PY

case "${DEFAULT_THINKING:-low}" in
  off) default_chat_template_kwargs='{"thinking":false}' ;;
  low) default_chat_template_kwargs='{"thinking":true,"reasoning_effort":"low"}' ;;
  high) default_chat_template_kwargs='{"thinking":true,"reasoning_effort":"high"}' ;;
  max) default_chat_template_kwargs='{"thinking":true,"reasoning_effort":"max"}' ;;
  *) echo "DEFAULT_THINKING must be off, low, high, or max" >&2; exit 2 ;;
esac

speculative_config="{\"method\":\"dspark\",\"num_speculative_tokens\":${MTP_NUM_TOKENS:-5},\"draft_sample_method\":\"probabilistic\"}"
headless=()
if [ "${NODE_RANK}" != "0" ]; then headless=(--headless); fi

exec /usr/local/bin/vllm serve "${DSPARK_MODEL:-deepseek-ai/DeepSeek-V4-Flash-0731}" \
  --revision "${DSPARK_MODEL_REVISION:-9e165c30e2704aec5d9d593cce3eebd58bbef1cb}" \
  --served-model-name "${SERVED_MODEL_NAME:-deepseek-v4-flash-0731}" \
  --host "${VLLM_HOST:-${NODE_ADDRESS}}" --port "${VLLM_PORT:-8888}" \
  --trust-remote-code --tensor-parallel-size 2 --pipeline-parallel-size 1 \
  --kv-cache-dtype nvfp4_ds_mla --block-size 256 \
  --max-model-len "${MAX_MODEL_LEN:-1048576}" --max-num-seqs "${MAX_NUM_SEQS:-6}" \
  --max-num-batched-tokens "${MAX_NUM_BATCHED_TOKENS:-8192}" \
  --max-cudagraph-capture-size "$(( ${MAX_NUM_SEQS:-6} * (${MTP_NUM_TOKENS:-5} + 1) ))" \
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION:-0.80}" \
  --enable-prefix-caching --enable-prompt-tokens-details --async-scheduling --enable-chunked-prefill \
  --speculative-config "${speculative_config}" --tokenizer-mode deepseek_v4 \
  --distributed-executor-backend mp --moe-backend flashinfer_b12x \
  --tool-call-parser deepseek_v4 --enable-auto-tool-choice --reasoning-parser deepseek_v4 \
  --reasoning-config '{"reasoning_parser":"deepseek_v4","reasoning_start_str":"<think>","reasoning_end_str":"</think>"}' \
  --default-chat-template-kwargs "${default_chat_template_kwargs}" --generation-config vllm \
  --enable-flashinfer-autotune --nnodes "${CLUSTER_NODE_COUNT:-2}" --node-rank "${NODE_RANK}" \
  --master-addr "${MASTER_ADDR}" --master-port "${MASTER_PORT:-25000}" "${headless[@]}"
