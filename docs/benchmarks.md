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

The current score favors interactive generation first, then prefill and context size. That is intentionally simple while the community format is young; recipe authors should still include raw metrics and settings so rankings can improve without losing evidence. The gateway's `/gateway/metrics` feed is useful for local evidence collection because it separates first-content latency from decode throughput before a formal benchmark suite is submitted.
