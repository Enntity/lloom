#!/usr/bin/env bash
set -euo pipefail

: "${QWEN_MODEL:?QWEN_MODEL is required}"
: "${QWEN_MODEL_REVISION:?QWEN_MODEL_REVISION is required}"
: "${SERVED_MODEL_NAME:?SERVED_MODEL_NAME is required}"
: "${NODE_RANK:?NODE_RANK is required}"
: "${NODE_ADDRESS:?NODE_ADDRESS is required}"
: "${MASTER_ADDR:?MASTER_ADDR is required}"
: "${FABRIC_INTERFACE:?FABRIC_INTERFACE is required}"

python3 /opt/lloom/apply-ple-fp8-patch.py

extra_args=()
if [[ "${NODE_RANK}" == "0" ]]; then
  extra_args+=(--host "${NODE_ADDRESS}" --port "${VLLM_PORT:-8888}")
else
  extra_args+=(--headless)
fi

expert_parallel_args=()
if [[ "${ENABLE_EXPERT_PARALLEL:-1}" == "1" ]]; then
  expert_parallel_args+=(--enable-expert-parallel --all2all-backend allgather_reducescatter)
fi

speculative_args=()
if [[ "${MTP_NUM_SPECULATIVE_TOKENS:-3}" =~ ^[1-9][0-9]*$ ]]; then
  speculative_args+=(
    --speculative-config
    "{\"method\":\"mtp\",\"num_speculative_tokens\":${MTP_NUM_SPECULATIVE_TOKENS:-3}}"
  )
fi

exec vllm serve "${QWEN_MODEL}" \
  --revision "${QWEN_MODEL_REVISION}" \
  --served-model-name "${SERVED_MODEL_NAME}" \
  --distributed-executor-backend mp \
  --nnodes "${CLUSTER_NODE_COUNT:-2}" \
  --node-rank "${NODE_RANK}" \
  --master-addr "${MASTER_ADDR}" \
  --master-port "${MASTER_PORT:-50000}" \
  --tensor-parallel-size "${CLUSTER_NODE_COUNT:-2}" \
  "${expert_parallel_args[@]}" \
  --load-format safetensors \
  --safetensors-load-strategy lazy \
  --max-model-len "${MAX_MODEL_LEN:-262144}" \
  --max-num-seqs "${MAX_NUM_SEQS:-8}" \
  --max-num-batched-tokens "${MAX_NUM_BATCHED_TOKENS:-8192}" \
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION:-0.835}" \
  --kv-cache-dtype "${KV_CACHE_DTYPE:-auto}" \
  --enable-chunked-prefill \
  --enable-prefix-caching \
  "${speculative_args[@]}" \
  --compilation-config '{"mode":0,"cudagraph_mode":"FULL_DECODE_ONLY"}' \
  --reasoning-parser qwen3 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder \
  "${extra_args[@]}"
