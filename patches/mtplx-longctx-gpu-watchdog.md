# MTPLX long-context Metal abort fix

These files contain modifications to Apache-2.0-licensed MTPLX code. See [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and [`../LICENSES/Apache-2.0.txt`](../LICENSES/Apache-2.0.txt). They are an LLooM-maintained workaround, not an official upstream MTPLX release.

## Symptom
At ~90k+ prompt tokens, Python dies with:
```
mlx::core::gpu::check_error(MTL::CommandBuffer*) → SIGABRT
```
Activity Monitor often still looks fine (not classic unified-memory OOM).

## Root cause
macOS GPU watchdog (`kIOGPUCommandBufferCallbackErrorImpactingInteractivity`,
~5s) kills a process when a **single** Metal command buffer runs too long.

MLX `steel_attention` (full SDPA when `q_len > 8`) over ~65k+ keys hits that
limit. See [ml-explore/mlx#3302](https://github.com/ml-explore/mlx/issues/3302).

With `--paged-kv-quantization q4`, MTPLX’s `kv_quant` attention path could
fall through to **dense** `scaled_dot_product_attention` on fully dequantised
K/V — especially when the large-q split path rejected non-`"causal"` string
masks (array/bool masks are normal for Qwen hybrid prefill). That is a
process-killing command-buffer error, not system OOM.

## Fix (two layers)

### 1. Site-package patch (required)
```bash
/path/to/mtplx/venv/bin/python \
  patches/apply_mtplx_longctx_fix.py
```
Patches:
- `mtplx/cache_state.py` — accept array masks in large-q split; force chunked
  attention for long offsets when `q_len > 8`
- `mtplx/attention_split.py` — prefer large-q split over dense fallback

Backups: `*.bak-lloom-longctx`. Re-run after `pip install -U mtplx`.

The helper matches exact upstream source blocks and exits without modifying files when they no longer match. Treat it as version-sensitive: after any MTPLX upgrade, review the upstream changes and re-run the long-context validation ladder before applying or publishing an updated patch.

### 2. Runtime env (LLooM applies for adapter `mtplx`)
| Variable | Default | Role |
|----------|---------|------|
| `AGX_RELAX_CDM_CTXSTORE_TIMEOUT` | `1` | Relaxes residual GPU watchdog |
| `MTPLX_LONG_CTX_CHUNKED_ATTN_THRESHOLD` | `4096` | Force chunked path above this offset |
| `MTPLX_VLLM_METAL_PAGED_LARGE_Q_*_CHUNK_SIZE` | `512` | Tile size for long-ctx SDPA |
| `MTPLX_PREFILL_CHUNK_SIZE*` | `512` | Smaller prefill command buffers |

Set via `runtimes.*.env` or rely on `runtime-manager.mjs` defaults.

## Verified on M2 Max 96GB (2026-07-09)
27B Speed FP16 turbo, q4 paged-kv, after patch + env:

| Prompt tokens | Result |
|---------------|--------|
| ~43k | OK |
| ~77k | OK |
| ~93k | OK (patch only, past old ~90k wall) |
| ~105k | OK (patch + AGX_RELAX) |
| ~122k | OK |
| ~144k | OK |

Prefill is slow at these lengths (minutes); that is expected, not a hang.

## Honest limits
- Not a true free 262k SLA — other cliffs may remain.
- `AGX_RELAX_*` is a system GPU timeout relaxation; use on dedicated inference
  machines. Prefer the code patch so dense full-KV SDPA is avoided entirely.
- Raise `models[].maxPromptTokens` only after ladder-testing on your silicon.
