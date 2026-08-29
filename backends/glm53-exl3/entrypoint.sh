#!/usr/bin/env bash
set -euo pipefail

log() { printf '[glm53-exl3 rank=%s] %s\n' "${NODE_RANK:-?}" "$*"; }

: "${NODE_RANK:?NODE_RANK is required}"
: "${CLUSTER_NODE_COUNT:?CLUSTER_NODE_COUNT is required}"
: "${MASTER_ADDR:?MASTER_ADDR is required}"
: "${MODEL_DIR:?MODEL_DIR is required}"

[[ -f "${MODEL_DIR}/config.json" ]] || {
  log "missing target config: ${MODEL_DIR}/config.json"
  exit 1
}

if [[ "${SPEC_METHOD:-dflash}" == "dflash" && ! -f "${DFLASH_MODEL_DIR:-}/config.json" ]]; then
  log "missing DFlash2 config: ${DFLASH_MODEL_DIR:-unset}/config.json"
  exit 1
fi

# These are the exact runtime overlays from MiaAI-Lab commit 0e2e78f3.
# They fail closed if their pinned vLLM anchors drift.
python3 /opt/lloom/patch_glm_video_placeholders.py
python3 /opt/lloom/patch_suppress_stops_in_reasoning.py
python3 /opt/lloom/patch_scheduler_decode_floor.py
python3 /opt/lloom/patch_glm5_drafter_group.py
python3 /opt/lloom/patch_hybrid_prefix_hit.py
python3 /opt/lloom/patch_xgrammar_termination.py

if [[ -z "${LIMIT_MM_PER_PROMPT:-}" ]]; then
  LIMIT_MM_PER_PROMPT='{"image":4,"video":1}'
fi

args=(
  --served-model-name "${SERVED_MODEL_NAME:-glm-5.3-flash-exl3}"
  --host "${VLLM_HOST:-0.0.0.0}"
  --port "${VLLM_PORT:-8890}"
  --tensor-parallel-size "${CLUSTER_NODE_COUNT}"
  --nnodes "${CLUSTER_NODE_COUNT}"
  --node-rank "${NODE_RANK}"
  --master-addr "${MASTER_ADDR}"
  --master-port "${MASTER_PORT:-29521}"
  --distributed-executor-backend mp
  --tool-call-parser glm47
  --enable-auto-tool-choice
  --reasoning-parser glm45
  --enable-prefix-caching
  --no-enable-flashinfer-autotune
  --quantization exl3
  --max-model-len "${MAX_MODEL_LEN:-1000000}"
  --gpu-memory-utilization "${GPU_MEMORY_UTILIZATION:-0.87}"
  --max-num-seqs "${MAX_NUM_SEQS:-4}"
  --max-num-batched-tokens "${MAX_NUM_BATCHED_TOKENS:-1024}"
  --kv-cache-dtype "${KV_CACHE_DTYPE:-fp8}"
  --chat-template /opt/lloom/chat_template.jinja
  --limit-mm-per-prompt "${LIMIT_MM_PER_PROMPT}"
  --skip-mm-profiling
)

if [[ -n "${KV_CACHE_MEMORY_BYTES:-}" ]]; then
  args+=(--kv-cache-memory-bytes "${KV_CACHE_MEMORY_BYTES}")
fi

if [[ "${NODE_RANK}" != "0" ]]; then
  args+=(--headless)
fi

case "${SPEC_METHOD:-dflash}" in
  dflash)
    dflash_tokens="${DFLASH_TOKENS:-7}"
    dflash_draft_tp="${DFLASH_DRAFT_TP:-1}"
    [[ "${dflash_tokens}" =~ ^[0-9]+$ ]] || { log "invalid DFLASH_TOKENS=${dflash_tokens}"; exit 1; }
    [[ "${dflash_draft_tp}" =~ ^[0-9]+$ ]] || { log "invalid DFLASH_DRAFT_TP=${dflash_draft_tp}"; exit 1; }
    # Do not launch Python here: Mia's installed video .pth emits a status line
    # on interpreter startup, which would contaminate command-substitution JSON.
    printf -v spec '{"method":"dflash","model":"%s","num_speculative_tokens":%d,"kv_cache_dtype":"auto","draft_sample_method":"probabilistic","rejection_sample_method":"standard","draft_tensor_parallel_size":%d}' \
      "${DFLASH_MODEL_DIR}" "${dflash_tokens}" "${dflash_draft_tp}"
    args+=(--speculative-config "${spec}")
    ;;
  mtp)
    args+=(--speculative-config "{\"method\":\"mtp\",\"num_speculative_tokens\":${MTP_TOKENS:-2}}")
    ;;
  none) ;;
  *)
    log "unsupported SPEC_METHOD=${SPEC_METHOD}"
    exit 1
    ;;
esac

if [[ "${ENFORCE_EAGER:-0}" == "1" ]]; then
  args+=(--enforce-eager)
else
  args+=(--cudagraph-capture-sizes 1 2 4 8 16 24 32)
fi

log "starting vLLM with Mia EXL3/TR3 TP=${CLUSTER_NODE_COUNT}, spec=${SPEC_METHOD:-dflash}"
exec vllm serve "${MODEL_DIR}" "${args[@]}"
