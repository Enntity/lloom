#!/usr/bin/env bash
set -euo pipefail

: "${QWEN_MODEL:?QWEN_MODEL is required}"
: "${QWEN_MODEL_REVISION:?QWEN_MODEL_REVISION is required}"
: "${SERVED_MODEL_NAME:?SERVED_MODEL_NAME is required}"
: "${NODE_RANK:?NODE_RANK is required}"
: "${NODE_ADDRESS:?NODE_ADDRESS is required}"
: "${MASTER_ADDR:?MASTER_ADDR is required}"
: "${FABRIC_INTERFACE:?FABRIC_INTERFACE is required}"

# SGLang reserves SGLANG_PORT as the base hint for internal distributed
# listeners.  Reusing it for the public API makes the scheduler claim the API
# port before Uvicorn can bind on multi-node launches.  Consume the legacy
# value for compatibility, then remove it from SGLang's runtime environment.
api_port="${SGLANG_API_PORT:-${SGLANG_PORT:-8889}}"
unset SGLANG_PORT

python3 /opt/lloom/apply-sm121-patches.py

if [[ -z "${NCCL_IB_HCA:-}" ]]; then
  for hca_path in /sys/class/infiniband/*; do
    [[ -d "${hca_path}/device/net/${FABRIC_INTERFACE}" ]] || continue
    NCCL_IB_HCA="${hca_path##*/}"
    export NCCL_IB_HCA
    break
  done
fi
: "${NCCL_IB_HCA:?Unable to resolve the RoCE HCA for ${FABRIC_INTERFACE}}"

exec python3 -m sglang.launch_server \
  --model-path "${QWEN_MODEL}" \
  --revision "${QWEN_MODEL_REVISION}" \
  --served-model-name "${SERVED_MODEL_NAME}" \
  --trust-remote-code \
  --host "${SGLANG_API_HOST:-0.0.0.0}" \
  --port "${api_port}" \
  --tp-size "${CLUSTER_NODE_COUNT:-2}" \
  --nnodes "${CLUSTER_NODE_COUNT:-2}" \
  --node-rank "${NODE_RANK}" \
  --dist-init-addr "${MASTER_ADDR}:${MASTER_PORT:-26400}" \
  --quantization modelopt_fp4 \
  --fp4-gemm-backend flashinfer_cutlass \
  --attention-backend flashinfer \
  --kv-cache-dtype nvfp4 \
  --page-size 64 \
  --mamba-ssm-dtype bfloat16 \
  --mamba-radix-cache-strategy extra_buffer \
  --mamba-track-interval 64 \
  --max-mamba-cache-size "${MAX_MAMBA_CACHE_SIZE:-30}" \
  --mamba-full-memory-ratio "${MAMBA_FULL_MEMORY_RATIO:-0.3}" \
  --mem-fraction-static "${MEM_FRACTION_STATIC:-0.76}" \
  --chunked-prefill-size "${CHUNKED_PREFILL_SIZE:-1024}" \
  --max-running-requests "${MAX_RUNNING_REQUESTS:-6}" \
  --max-total-tokens "${MAX_TOTAL_TOKENS:-627648}" \
  --context-length "${CONTEXT_LENGTH:-262144}" \
  --speculative-algorithm NEXTN \
  --speculative-num-steps "${SPECULATIVE_NUM_STEPS:-3}" \
  --speculative-eagle-topk 1 \
  --speculative-num-draft-tokens "${SPECULATIVE_NUM_DRAFT_TOKENS:-4}" \
  --enable-linear-replayssm-spec \
  --reasoning-parser auto \
  --tool-call-parser auto \
  --default-chat-template-kwargs '{"enable_thinking":false}' \
  --enable-metrics \
  --enable-cache-report \
  --disable-prefill-cuda-graph \
  --cuda-graph-bs-decode 1 2 3 4 5 6
