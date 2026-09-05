#!/usr/bin/env bash
set -euo pipefail

: "${QWEN_MODEL:?QWEN_MODEL is required}"
: "${QWEN_MODEL_REVISION:?QWEN_MODEL_REVISION is required}"
: "${NODE_RANK:?NODE_RANK is required}"
: "${NODE_ADDRESS:?NODE_ADDRESS is required}"
: "${MASTER_ADDR:?MASTER_ADDR is required}"
: "${SERVED_MODEL_NAME:?SERVED_MODEL_NAME is required}"

python3 /opt/lloom/qwen-nvidia/apply-overlays.py
model_dir="${HF_HOME:-/root/.cache/huggingface}/hub/models--${QWEN_MODEL//\//--}/snapshots/${QWEN_MODEL_REVISION}"
[[ -f "$model_dir/config.json" ]] || { echo "Pinned Qwen snapshot missing: $model_dir" >&2; exit 1; }
export QWEN4EXP_PLE_MODEL_DIR="$model_dir"

node_args=()
if [[ "$NODE_RANK" == "0" ]]; then
  node_args+=(--host "$NODE_ADDRESS" --port "${VLLM_PORT:-8889}")
else
  node_args+=(--headless)
fi
spec_args=()
if [[ "${MTP_NUM_SPECULATIVE_TOKENS:-3}" =~ ^[1-9][0-9]*$ ]]; then
  spec_args+=(--speculative-config "{\"method\":\"mtp\",\"num_speculative_tokens\":${MTP_NUM_SPECULATIVE_TOKENS:-3}}")
fi
cache_args=(--no-enable-prefix-caching)
if [[ "${ENABLE_PREFIX_CACHING:-0}" == "1" ]]; then
  cache_args=(--enable-prefix-caching)
fi
ep_args=()
if [[ "${ENABLE_EXPERT_PARALLEL:-0}" == "1" ]]; then
  ep_args+=(--enable-expert-parallel --all2all-backend allgather_reducescatter)
fi

exec vllm serve "$model_dir" \
  --served-model-name "$SERVED_MODEL_NAME" \
  --quantization modelopt \
  --distributed-executor-backend mp \
  --nnodes "${CLUSTER_NODE_COUNT:-2}" --node-rank "$NODE_RANK" \
  --master-addr "$MASTER_ADDR" --master-port "${MASTER_PORT:-50000}" \
  --tensor-parallel-size "${CLUSTER_NODE_COUNT:-2}" "${ep_args[@]}" \
  --load-format safetensors --safetensors-load-strategy lazy \
  --max-model-len "${MAX_MODEL_LEN:-262144}" \
  --max-num-seqs "${MAX_NUM_SEQS:-8}" \
  --max-num-batched-tokens "${MAX_NUM_BATCHED_TOKENS:-8192}" \
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION:-0.75}" \
  --kv-cache-dtype "${KV_CACHE_DTYPE:-fp8_e4m3}" \
  --enable-chunked-prefill --no-enable-flashinfer-autotune \
  "${cache_args[@]}" "${spec_args[@]}" \
  --compilation-config '{"cudagraph_mode":"PIECEWISE"}' \
  --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_xml \
  --default-chat-template-kwargs '{"enable_thinking":true,"reasoning_effort":"low"}' \
  "${node_args[@]}"
