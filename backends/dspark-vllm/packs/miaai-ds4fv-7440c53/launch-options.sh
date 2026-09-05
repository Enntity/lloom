#!/usr/bin/env bash
# Sourced by the verified pack and launcher. New upstream features stay opt-in.
for knob in DSPARK_ENABLE_DSML_RECOVERY DSPARK_ENABLE_MXFP4_INDEXER_CACHE DSPARK_ENABLE_ISSUE144_EFFORT_ALIGN; do
  case "${!knob:-0}" in
    0|1) ;;
    *) echo "${knob} must be 0 or 1" >&2; exit 2 ;;
  esac
done
dspark_attention_args=()
if [[ "${DSPARK_ENABLE_MXFP4_INDEXER_CACHE:-0}" == "1" ]]; then
  if [[ "${DSPARK_ENABLE_DEEPGEMM_SM121_ALIAS:-0}" != "1" ]]; then
    echo "MXFP4 indexer cache requires DSPARK_ENABLE_DEEPGEMM_SM121_ALIAS=1" >&2
    exit 2
  fi
  dspark_attention_args=(--attention-config '{"use_fp4_indexer_cache":true}')
fi
# Preserve NCCL's native default when the optional passthrough is empty/unset.
if [[ -z "${NCCL_GIN_ENABLE:-}" ]]; then unset NCCL_GIN_ENABLE; fi
