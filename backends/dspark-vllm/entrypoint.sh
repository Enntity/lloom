#!/usr/bin/env bash
set -euo pipefail

# LLooM's two-node launcher follows the runtime contract validated by MiaAI Lab's
# DeepSeek V4 Flash DSpark recipe, while resolving each node's RoCE GID locally.
# Upstream: https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark

: "${NODE_ADDRESS:?NODE_ADDRESS is required}"
: "${FABRIC_INTERFACE:?FABRIC_INTERFACE is required}"
: "${MASTER_ADDR:?MASTER_ADDR is required}"
: "${NODE_RANK:?NODE_RANK is required}"

validate_numeric_knob() {
  local name="$1" minimum="$2" maximum="$3" value="${!1}"
  if [[ ! "${value}" =~ ^[0-9]+$ ]] || [ "${#value}" -gt 10 ]; then
    echo "${name} must be an integer between ${minimum} and ${maximum}: ${value}" >&2
    exit 2
  fi
  value="$((10#${value}))"
  if [ "${value}" -lt "${minimum}" ] || [ "${value}" -gt "${maximum}" ]; then
    echo "${name} must be between ${minimum} and ${maximum}: ${value}" >&2
    exit 2
  fi
  printf -v "${name}" '%d' "${value}"
  export "${name}"
}

MAX_NUM_SEQS="${MAX_NUM_SEQS:-6}"
MTP_NUM_TOKENS="${MTP_NUM_TOKENS:-5}"
MAX_NUM_BATCHED_TOKENS="${MAX_NUM_BATCHED_TOKENS:-8192}"
validate_numeric_knob MAX_NUM_SEQS 1 4096
validate_numeric_knob MTP_NUM_TOKENS 0 64
validate_numeric_knob MAX_NUM_BATCHED_TOKENS 1 8388608

fabric_interfaces="${FABRIC_INTERFACES:-${FABRIC_INTERFACE}}"
IFS=',' read -r -a fabric_interface_list <<<"${fabric_interfaces}"

resolve_hca_for_interface() {
  local interface="$1" net_path
  for net_path in /sys/class/infiniband/*/device/net/"${interface}"; do
    if [ -e "${net_path}" ]; then
      basename "$(dirname "$(dirname "$(dirname "${net_path}")")")"
      return 0
    fi
  done
  return 1
}

resolved_hcas=()
for interface in "${fabric_interface_list[@]}"; do
  hca="$(resolve_hca_for_interface "${interface}")" || {
    echo "Could not resolve RDMA HCA for ${interface}" >&2
    exit 1
  }
  resolved_hcas+=("${hca}")
done

if [ -z "${NCCL_IB_HCA:-}" ]; then
  resolved_hca_csv="$(IFS=,; echo "${resolved_hcas[*]}")"
  # The leading '=' selects exact HCA names in NCCL's selector grammar.
  NCCL_IB_HCA="=${resolved_hca_csv}"
fi

if [ -z "${NCCL_IB_GID_INDEX:-}" ]; then
  shared_gid_index=""
  for index in "${!fabric_interface_list[@]}"; do
    interface="${fabric_interface_list[${index}]}"
    hca="${resolved_hcas[${index}]}"
    interface_gid_index=""
    for gid_path in /sys/class/infiniband/"${hca}"/ports/1/gids/*; do
      [ -e "${gid_path}" ] || continue
      gid_index="${gid_path##*/}"
      gid_type="$(cat "/sys/class/infiniband/${hca}/ports/1/gid_attrs/types/${gid_index}" 2>/dev/null || true)"
      [ "${gid_type}" = "RoCE v2" ] || continue
      gid_interface="$(cat "/sys/class/infiniband/${hca}/ports/1/gid_attrs/ndevs/${gid_index}" 2>/dev/null || true)"
      [ "${gid_interface}" = "${interface}" ] || continue
      case "$(cat "${gid_path}")" in
        ::|0000:0000:0000:0000:0000:0000:0000:0000) continue ;;
        *) interface_gid_index="${gid_index}"; break ;;
      esac
    done
    [ -n "${interface_gid_index}" ] || {
      echo "Could not resolve a RoCE v2 GID for ${hca}/${interface}" >&2
      exit 1
    }
    if [ -n "${shared_gid_index}" ] && [ "${shared_gid_index}" != "${interface_gid_index}" ]; then
      echo "Selected HCAs do not share one RoCE v2 GID index: ${shared_gid_index} != ${interface_gid_index}" >&2
      exit 1
    fi
    shared_gid_index="${interface_gid_index}"
  done
  NCCL_IB_GID_INDEX="${shared_gid_index}"
fi
: "${NCCL_IB_GID_INDEX:?Could not resolve a shared RoCE v2 GID index for ${NCCL_IB_HCA}}"
export NCCL_IB_HCA NCCL_IB_GID_INDEX

mkdir -p \
  "${B12X_CUTE_COMPILE_CACHE_DIR:-/cache/huggingface/b12x-cute-cache}" \
  "$(dirname "${TORCH_FR_DUMP_TEMP_FILE:-/cache/huggingface/nccl-fr/comm_lib_trace_rank_}")"

echo "DSpark fabric: interfaces=${fabric_interfaces} hcas=${NCCL_IB_HCA} gid_index=${NCCL_IB_GID_INDEX}"
if [ "${DSPARK_FABRIC_PROBE_ONLY:-0}" = "1" ]; then
  exit 0
fi

export PATH="/usr/local/cuda/bin:/usr/local/bin:${PATH:-}"
export CUDA_HOME="${CUDA_HOME:-/usr/local/cuda}"
export CUDA_PATH="${CUDA_PATH:-${CUDA_HOME}}"
export CUDAToolkit_ROOT="${CUDAToolkit_ROOT:-${CUDA_HOME}}"
export LD_LIBRARY_PATH="/usr/local/cuda/lib64:${LD_LIBRARY_PATH:-}"

model_id="${DSPARK_MODEL:-deepseek-ai/DeepSeek-V4-Flash-0731}"
model_revision="${DSPARK_MODEL_REVISION:-9e165c30e2704aec5d9d593cce3eebd58bbef1cb}"
model_hub_dir="${model_id//\//--}"
encoding_source="${DSPARK_ENCODING_FILE:-}"
if [ -z "${encoding_source}" ] && [ -f "/cache/huggingface/hub/models--${model_hub_dir}/snapshots/${model_revision}/encoding/encoding_dsv4.py" ]; then
  encoding_source="/cache/huggingface/hub/models--${model_hub_dir}/snapshots/${model_revision}/encoding/encoding_dsv4.py"
fi
if [ -z "${encoding_source}" ]; then
  for candidate in /cache/huggingface/hub/models--"${model_hub_dir}"/snapshots/*/encoding/encoding_dsv4.py; do
    if [ -f "${candidate}" ]; then encoding_source="${candidate}"; break; fi
  done
fi
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

pack_options="$(dirname "${pack_manifest}")/launch-options.sh"
for knob in DSPARK_ENABLE_DSML_RECOVERY DSPARK_ENABLE_MXFP4_INDEXER_CACHE DSPARK_ENABLE_ISSUE144_EFFORT_ALIGN; do
  if [[ "${!knob:-0}" != "0" && ! -f "${pack_options}" ]]; then
    echo "${knob} requires a supporting patch pack" >&2
    exit 2
  fi
done
python3 "${pack_runner}" \
  --manifest "${pack_manifest}" \
  --runtime-image "${DSPARK_RUNTIME_IMAGE}" \
  --model "${model_id}" \
  --model-revision "${model_revision}" \
  --vllm-root "${vllm_root}"

dspark_attention_args=()
if [[ -f "${pack_options}" ]]; then source "${pack_options}"; fi

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

speculation_mode="${DSPARK_SPECULATION_MODE:-dspark}"
speculation_args=()
case "${speculation_mode}" in
  dspark)
    if [ "${MTP_NUM_TOKENS:-5}" -lt 5 ]; then
      echo "MTP_NUM_TOKENS must be at least the checkpoint dspark_block_size (5) when DSPARK_SPECULATION_MODE=dspark" >&2
      exit 2
    fi
    case "${DRAFT_SAMPLE_METHOD:-probabilistic}" in
      probabilistic|greedy) draft_sample_method="${DRAFT_SAMPLE_METHOD:-probabilistic}" ;;
      *) echo "DRAFT_SAMPLE_METHOD must be probabilistic or greedy" >&2; exit 2 ;;
    esac
    speculative_config="{\"method\":\"dspark\",\"num_speculative_tokens\":${MTP_NUM_TOKENS:-5},\"draft_sample_method\":\"${draft_sample_method}\"}"
    speculation_args=(--speculative-config "${speculative_config}")
    expanded_decode_rows="$(( MAX_NUM_SEQS * (MTP_NUM_TOKENS + 1) ))"
    # vLLM generates capture sizes in 8-row increments above four. Round up
    # so the configured concurrency ceiling is captured instead of silently
    # truncating (K5/C6 is 36 rows and therefore needs a 40-row ceiling).
    cudagraph_capture_size="$(( (expanded_decode_rows + 7) / 8 * 8 ))"
    ;;
  target-only)
    # Safety profile for vLLM #51593-shaped stalls. Without speculative
    # expansion, next_n stays at 1 and CUDA-graph padding cannot underflow an
    # MTP context length before the sparse top-k kernel.
    cudagraph_capture_size="$(( (MAX_NUM_SEQS + 7) / 8 * 8 ))"
    ;;
  *)
    echo "DSPARK_SPECULATION_MODE must be dspark or target-only" >&2
    exit 2
    ;;
esac
headless=()
if [ "${NODE_RANK}" != "0" ]; then headless=(--headless); fi

async_scheduling_args=()
case "${DSPARK_ASYNC_SCHEDULING:-1}" in
  1) async_scheduling_args=(--async-scheduling) ;;
  0) ;;
  *) echo "DSPARK_ASYNC_SCHEDULING must be 0 or 1" >&2; exit 2 ;;
esac

limit_mm_args=()
if [ -n "${LIMIT_MM_PER_PROMPT:-}" ]; then
  case "${LIMIT_MM_PER_PROMPT}" in
    image=*) limit_mm_args=(--limit-mm-per-prompt "{\"image\":${LIMIT_MM_PER_PROMPT#image=}}") ;;
    *) limit_mm_args=(--limit-mm-per-prompt "${LIMIT_MM_PER_PROMPT}") ;;
  esac
fi

exec /usr/local/bin/vllm serve "${model_id}" \
  --revision "${model_revision}" \
  --served-model-name "${SERVED_MODEL_NAME:-deepseek-v4-flash-0731}" \
  --host "${VLLM_HOST:-${NODE_ADDRESS}}" --port "${VLLM_PORT:-8888}" \
  --trust-remote-code --tensor-parallel-size 2 --pipeline-parallel-size 1 \
  --kv-cache-dtype "${KV_CACHE_DTYPE:-nvfp4_ds_mla}" --block-size 256 \
  --max-model-len "${MAX_MODEL_LEN:-1048576}" --max-num-seqs "${MAX_NUM_SEQS:-6}" \
  --max-num-batched-tokens "${MAX_NUM_BATCHED_TOKENS:-8192}" \
  --long-prefill-token-threshold "${LONG_PREFILL_TOKEN_THRESHOLD:-1024}" \
  --max-cudagraph-capture-size "${cudagraph_capture_size}" \
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION:-0.80}" \
  --enable-prefix-caching --enable-prompt-tokens-details "${async_scheduling_args[@]}" --enable-chunked-prefill \
  "${speculation_args[@]}" "${dspark_attention_args[@]}" --tokenizer-mode deepseek_v4 \
  "${limit_mm_args[@]}" \
  --distributed-executor-backend mp --moe-backend flashinfer_b12x \
  --tool-call-parser deepseek_v4 --enable-auto-tool-choice --reasoning-parser deepseek_v4 \
  --reasoning-config '{"reasoning_parser":"deepseek_v4","reasoning_start_str":"<think>","reasoning_end_str":"</think>"}' \
  --default-chat-template-kwargs "${default_chat_template_kwargs}" --generation-config vllm \
  --enable-flashinfer-autotune --nnodes "${CLUSTER_NODE_COUNT:-2}" --node-rank "${NODE_RANK}" \
  --master-addr "${MASTER_ADDR}" --master-port "${MASTER_PORT:-25000}" "${headless[@]}"
