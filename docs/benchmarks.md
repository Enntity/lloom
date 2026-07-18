# Benchmarks

LLooM recipes are meant to be evidence-backed. Benchmark files under `benchmarks/community/` are the local prototype of the future community index: each file can contain a suite with one or more measured model/backend results.

Inspect all evidence:

```zsh
lloom benchmarks
lloom recipe-index
```

Inspect the evidence attached to one recipe:

```zsh
lloom benchmarks apple-silicon-qwen36
lloom plan apple-silicon-qwen36 --model-root ~/Models
```

`plan`, `bootstrap`, and `recipe-index` attach the best matching benchmark to each recipe model role. The gateway does not silently rewrite stale model IDs; benchmark `model` and `gatewayModel` values must match recipe and registry IDs exactly.

Benchmark results for recipe version 2 and later must also declare `recipeVersion`. LLooM only attaches evidence whose `recipeId` and `recipeVersion` match the active recipe, preventing archived runtime measurements from being presented as evidence for a newer recipe. Version 1 evidence may omit the field for compatibility with existing packs.

Recipe packs can carry benchmark suites alongside recipes:

```zsh
lloom recipe-import ./qwen-next-pack.json
```

The import plan validates attached suites before writing them under `benchmarks/community/`.

## Result Contract

A suite file should include:

- `schemaVersion`: benchmark schema version.
- `id`: unique suite ID.
- `source`: where the result came from.
- `submittedAt`: ISO timestamp.
- `results`: list of benchmark results.

Each result should include:

- `id`: unique result ID.
- `recipeId`: recipe this result supports.
- `backendId`: backend catalog ID.
- `model`: tested model artifact ID.
- `gatewayModel`: advertised gateway model ID, when different from artifact ID.
- `machine.platformId`: platform such as `darwin-arm64`.
- `machine.chip` and `machine.memoryGb`: hardware context.
- `settings`: runtime knobs such as context window, MTP depth, turbo mode, quantization, batch settings, and concurrency.
- `metrics.generationTokPerSec`: interactive generation speed.
- `metrics.prefillTokPerSec`: prompt-processing speed, when measured.
- `metrics.contextWindow`: validated context window.
- `metrics.firstContentMs`: first streamed content latency, when captured from gateway metrics.
- `metrics.decodeTokensPerSecond`: mean of the latest ten Spark Arena-style streaming decode measurements, each calculated as `(generated tokens - 1) / (last content token time - first content token time)`. Reported token usage is preferred; otherwise LLooM estimates tokens from observed output characters and increments `estimatedDecodeSamples`. Non-streaming and zero-output requests are excluded.
- `x-rankingEligible: false`: retain historical, unmatched, or ecological evidence for inspection without allowing it to drive recipe recommendations or outrank matched benchmark suites. The interchange consistency check permits such evidence to name a retired gateway model that is no longer present in the current recipe, but the recipe and backend must still exist.

The current score favors interactive generation first, then prefill and context size. That is intentionally simple while the community format is young; recipe authors should still include raw metrics and settings so rankings can improve without losing evidence. The gateway's `/gateway/metrics` feed is useful for local evidence collection because it separates first-content latency from decode throughput before a formal benchmark suite is submitted.

## DGX Spark Qwen3.6 35B-A3B reference comparison

The bundled `dgx-spark-qwen36-35b-a3b-variants-20260711` suite preserves the original July 11 Spark comparison instead of leaving the measurements in an operator transcript. It used a fixed 1,409-token prompt, forced 256 output tokens, temperature 0, ignored EOS, and direct vLLM completion endpoints.

At concurrency 1, the original Unsloth 35B-A3B checkpoint measured a median 66.45 output tok/s after warmup. The block-scaled `-Fast` checkpoint on the matching nightly vLLM/FlashInfer B12x path measured 69.37 output tok/s. Two four-request `-Fast` batches measured 153.78 and 156.82 aggregate output tok/s, or a 155.30 tok/s median.

The suite contains every raw timing used in those medians and marks later Froggeric aggregate telemetry as operational follow-up rather than a controlled benchmark. It also records an important limit: this was a direct-backend, non-streaming harness. Its workload is not matched to the later 27B suite and must not be used as a direct 27B-versus-35B speed ranking. Its results therefore set `x-rankingEligible: false`: they remain inspectable evidence but do not drive recipe recommendations or displace matched suites in the benchmark overview.

## DGX Spark Qwen3.6 27B reference shootout

The bundled `dgx-spark-qwen36-27b-unsloth-vllm-20260713` suite records a matched GB10 comparison using random 2,048-token prompts, 128 generated tokens, temperature 0, ignored EOS, one warmup, and seed `20260713`. The selected Unsloth mixed NVFP4/FP8 checkpoint uses vLLM, FP8 KV cache, FlashInfer attention, MTP depth 2, eight scheduler slots, and an 8,192-token chunked-prefill cap.

Direct-backend output throughput measured 19.17 tok/s at concurrency 1, 48.01 tok/s at concurrency 4, and 64.50 tok/s at concurrency 8. Final LLooM-path validation measured 18.85, 49.11, and 62.95 tok/s respectively. The suite also retains matched comparison numbers for NVIDIA stock vLLM, AEON DFlash, and Atlas.

Atlas emits an early non-content SSE event, so generic OpenAI benchmark clients can report a misleading single-digit-millisecond TTFT. Do not publish that value as model TTFT; use first content token timing or Atlas server telemetry instead.
