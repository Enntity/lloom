#!/usr/bin/env bash
set -euo pipefail

pack_root="$(cd "$(dirname "$0")" && pwd)"
patches="${pack_root}/patches"
vllm_root="${VLLM_ROOT:-/usr/local/lib/python3.12/dist-packages/vllm}"

python3 "${patches}/hotfix-encoding-dsv4-issue21.py"
python3 "${patches}/hotfix-dsv4-issue55-tool-truncation.py"
VLLM_ROOT="${vllm_root}" bash "${patches}/hotfix-nvfp4-ds-mla-issue22.sh"
VLLM_ROOT="${vllm_root}" bash "${patches}/hotfix-gb10-spin-wait.sh"
python3 "${patches}/hotfix-vllm-issue117-shm-ring-buffer.py"
python3 "${patches}/hotfix-vllm-issue117-shm-ring-buffer.py" --status

for patch in \
  hotfix-dsv4-mtp-buffer-50312.sh \
  hotfix-dsv4-skip-topk-49486.sh \
  hotfix-dsv4-dense-prefill-indexer-48407.sh \
  hotfix-dsv4-skip-empty-c128-48957.sh \
  hotfix-dsv4-flashmla-workspace-50298.sh \
  hotfix-dsv4-grammar-advance.sh
do
  VLLM_ROOT="${vllm_root}" bash "${patches}/${patch}"
done

python3 "${patches}/hotfix-dsv4-vision-exp.py" \
  "${patches}/vision_exp" \
  "${vllm_root}/models/deepseek_v4/nvidia/model.py" \
  "${vllm_root}/tokenizers/deepseek_v4_encoding.py" \
  "${vllm_root}/models/deepseek_v4/nvidia/dspark.py"
python3 "${patches}/hotfix-vllm-empty-encoder-output.py"
python3 "${patches}/hotfix-dsv4-issue27-partial-prefill-concurrency.py"
python3 "${patches}/hotfix-dsv4-issue43-decode-fairness-and-diag.py"
python3 "${patches}/hotfix-dsv4-issue26-hybrid-swa-min.py"
python3 "${patches}/hotfix-dsv4-issue133-triton-specialization.py"
python3 "${patches}/hotfix-dsv4-suppress-stops-in-reasoning.py"

# Mia f5665e8: the current correctness chain and trained block-size unlock.
python3 "${patches}/hotfix-vllm-issue136-xgrammar-termination.py"
python3 "${patches}/hotfix-vllm-issue191-toolcall-failclosed.py"
python3 "${patches}/hotfix-vllm-dspark-block-k.py"

# Source-pinned correctness fixes, independently switchable for controlled A/B.
if [[ "${DSPARK_ENABLE_ROPE_SWA_FIX:-0}" == "1" ]]; then
  python3 "${patches}/hotfix-vllm-rope-swa-fix.py"
  python3 "${patches}/hotfix-vllm-rope-swa-fix.py" --status
fi

# Exact upstream long-prefill optimization. Decode remains on the stock path.
if [[ "${DSPARK_ENABLE_DEEPGEMM_SM121_ALIAS:-0}" == "1" ]]; then
  bash "${patches}/hotfix-deepgemm-sm121-mqa-header-alias.sh"
  bash "${patches}/hotfix-deepgemm-sm121-mqa-header-alias.sh" --status
fi
if [[ "${DSPARK_ENABLE_SP_INDEXER:-0}" == "1" ]]; then
  python3 "${patches}/hotfix-dsv4-sp-indexer-prefill.py"
  python3 "${patches}/hotfix-dsv4-sp-indexer-prefill.py" --status
fi
if [[ "${DSPARK_ENABLE_DSPARK_SWA_PREFIX:-0}" == "1" ]]; then
  python3 "${patches}/hotfix-vllm-dspark-swa-prefix.py"
  python3 "${patches}/hotfix-vllm-dspark-swa-prefix.py" --status
fi
