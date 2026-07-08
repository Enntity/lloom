# Benchmarks

LLooM recipes are meant to be evidence-backed. Benchmark files under `benchmarks/community/` are the local prototype of the future community index: each file can contain a suite with one or more measured model/backend results.

Inspect all evidence:

```zsh
node bin/lloom.mjs benchmarks
node bin/lloom.mjs recipe-index
```

Inspect the evidence attached to one recipe:

```zsh
node bin/lloom.mjs benchmarks apple-silicon-qwen36
node bin/lloom.mjs plan apple-silicon-qwen36 --model-root ~/Models
```

`plan`, `bootstrap`, and `recipe-index` attach the best matching benchmark to each recipe model role. The gateway does not silently rewrite stale model IDs; benchmark `model` and `gatewayModel` values must match recipe and registry IDs exactly.

Recipe packs can carry benchmark suites alongside recipes:

```zsh
node bin/lloom.mjs recipe-import ./qwen-next-pack.json
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

The current score favors interactive generation first, then prefill and context size. That is intentionally simple while the community format is young; recipe authors should still include raw metrics and settings so rankings can improve without losing evidence.
