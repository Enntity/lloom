# Q38FN v8 PLE residual + QSA fused output gate

This directory is the v8 fusion layer for the pinned
`vllm/vllm-openai` e962733e08d10f7ca65dac4df99e116460b8b174 image. It is
applied AFTER the baseline `nvidia-e962733e` PLE/MTP overlays and the
`nvidia-e962733e-prefix` hybrid block-size prefix fixes; it never replaces
them. Container name `lloom-qwen38-v8-${nodeId}` preserves the stopped v7
containers during qualification. LLooM drains and stops removed runtime IDs
on config reload, so promotion from an experiment to canonical runtime IDs
restarts the backend.

## Upstream source (Apache-2.0)

Backports vLLM PR 55309:

- PLE short-conv residual fusion: the outer pre-norm residual is threaded
  through `_short_conv`/`_short_conv_dilated_dispatch` so the profiling no-op
  path still accumulates it, and the fused `ops/ple.py` kernel adds the outer
  residual in FP32 opmath (`outer_residual.to(tl.float32) +
  ple_output.to(tl.float32)`) with the upstream rounding correction.
- QSA fused output gate: `attn_output_gate` is mandatory for this
  architecture, so `sigmoid(gate)` moves into the fused Triton kernels (BF16
  attention-output rounding preserved, gate applied in FP32), the Python-side
  sigmoid is removed, and `warmup_qsa_sparse_paged_attention` passes the gate
  and its strides so JIT warmup matches runtime specializations.

The five whole-file overlays (`model.py`, `ple_layer.py`, `ops/ple.py`,
`qsa.py`, `ops/qsa.py`) carry the exact upstream diff against e962733e plus
the residual `hidden_states = self.ple(...)` change. Original vLLM
authors and copyright notices are retained; upstream is Apache-2.0. The LLooM
guard manifest, launcher and tests in this directory are MIT.

## Deferred

- PR 54713 (scheduler replay boundary): needs scheduler/replay architecture
  absent from the pinned revision; not transplanted. Prefix-cache retention
  stays 1600.
- PR 55513 (mixed-quant MTP loader): already present and guarded in the
  baseline Tony overlay; no equivalent correction remains to backport.

## KV budget

Per-rank KV defaults to 30064771072 bytes (28 GiB) via
`KV_CACHE_MEMORY_BYTES`. BF16 KV only and a full-vocabulary MTP3 draft are
retained; no reduced draft vocab and no FP8/NVFP4 KV. The base paged-KV and
prefix-cache behavior is unchanged.

The launcher composes both manifests in `apply-stack.py` so a normal restart
accepts the final fused files while still checking every baseline-only file.
Admission reserves 110 GiB per host; the OS exposes about 121.7 GiB on these
128 GB Sparks. Live qualification must verify headroom with the 28 GiB cache.
