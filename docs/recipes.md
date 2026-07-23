# Recipes

Recipes are evidence-backed backend/model choices for a machine class. They should record:

- Hardware class and memory
- Backend and version
- Model artifact
- Quantization or tensor format
- Context window
- Startup and warmup requirements
- Prompt-processing and generation throughput
- Known client compatibility issues

## Bundled library and host library

LLooM intentionally has two catalog tiers:

- `recipes/` is the small offline library: one or two high-confidence ways to get productive on each supported hardware class without contacting a community host.
- `community/recipes/` contains broader, specialized, experimental, and opt-in choices. `lloom-host` automatically merges the bundled library into its configured host library, with host entries overriding duplicate IDs, so the host is always a strict superset.

The current high-memory defaults include Apple Silicon Qwen3.6 lanes, Unsloth Qwen3.6 35B-A3B and 27B NVFP4 lanes for NVIDIA GB10, FLUX.2 Klein 4B for fast conventional image generation and reference editing, Qwen-Image-2512 for higher-quality generation, and Qwen-Image-Edit-2511 for reference-faithful edits.

DGX Spark uses the dedicated `linux-nvidia-gb10-image-generation` recipe. It materializes three additive, on-demand Docker runtimes backed by LLooM's stable-diffusion.cpp CUDA image, so the host does not need a separate CUDA compiler toolchain. The cross-platform `high-memory-local-image-generation` recipe remains the source-build path for Apple Silicon and CUDA development hosts.

## Apple Silicon Qwen3.6 Starting Point

On the current M2 Max 96 GB machine, the strongest observed Qwen3.6 lanes were:

- Dense 27B: `Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed`
- 35B-A3B MoE: `Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16`

These are encoded in `recipes/apple-silicon-qwen36.json` and exposed by default in `config/default.json`.
Community host seed recipes also publish split Apple Silicon MTPLX lanes plus a Linux/NVIDIA Qwen3.6 27B NVFP4 vLLM lane under `community/recipes/`; first-run onboarding can consume those signed packs directly from `lloom-host` and let machine-profile evidence decide which one fits.

## Plan Contract

Recipes are JSON documents with these top-level sections:

- `requirements`: platform, memory, disk, and command prerequisites.
- `backend`: the runtime family being configured.
- `setup.steps`: ordered checks, downloads, commands, and tuning operations.
- `models`: role-to-artifact mappings plus gateway model/runtime IDs.

`backend.id` should match an entry in `backends/catalog.json`.
Recipes are portable setup intent. They do not need the consumer's local config to already contain the named model, backend config, or runtime. During `init`, `setup`, or `onboard`, LLooM materializes missing model catalog entries, backend endpoints, runtime commands, warmup requests, session-cache settings, and client model ordering from the selected recipe.

Model entries should be specific enough for LLooM to create the local runtime without guessing:

- `model`: the artifact ID, such as a Hugging Face repo ID, local model path, GGUF file, or Ollama tag.
- `gatewayModel`: the stable model ID LLooM advertises through `/v1/models` and client configs.
- `runtime`: the stable local runtime ID to start, stop, warm, and report in `/gateway/status`.
- `backendConfig`: optional stable backend config ID when the recipe should not use an auto-generated ID.
- `input` and `output`: modalities such as `text`, `image`, `video`, `audio`, `embedding`, or `scores`.
- `capabilities`: the API contract the model supports, for example `responses`, `anthropic-messages`, `tools`, `reasoning`, `vision`, `mtp`, or `long-context`.
- `settings`: runtime knobs consumed during config materialization, including `contextWindow`, `maxOutputTokens`, `maxActiveRequests`, `profile`, `draftDepth`, `reasoning`, `preserveThinking`, `batchingPreset`, `memoryGb`, `startupTimeoutMs`, `priority`, `evictable`, `keepWarm`, and session-cache fields.
- `settings.runtime`: optional explicit launcher data for recipes that need backend-specific command lines or bootstrap-only managed containers. LLooM templates `command`, `args`, `env`, `bootstrap`, `healthPath` or `healthUrl`, `warmup`, `watchdog`, and session-cache hints with variables such as `${modelRoot}`, `${modelPath}`, `${modelId}`, `${port}`, `${contextWindow}`, `${maxOutputTokens}`, `${maxActiveRequests}`, `${runtimeId}`, and `${sessionCacheDir}`. If it is absent, LLooM uses the built-in defaults for known backends.
- `setDefault`: optional explicit instruction to select that model as the installed default for its output modality. This also applies during additive recipe updates, so use it only when the recipe intentionally owns the default choice.
- `observed`: a lightweight performance summary for humans. Ranking-quality evidence should still live in a linked `benchmark-suite.v1`.

Inspect a plan without running it:

```zsh
lloom profile
lloom select
lloom recipe-index
lloom benchmarks apple-silicon-qwen36
lloom plan apple-silicon-qwen36 --model-root ~/Models
```

`selectable` means the recipe fits the machine platform and memory. `runnable` means the required backend commands are already visible on `PATH`. A selectable recipe with `setupRequired: true` is still a valid choice for automatic setup.

When benchmark evidence exists for the recipe, `plan` attaches the best matching result to each model role. That keeps the recipe executable while making the "best model for this machine" claim auditable.

Run a safe dry-run install:

```zsh
lloom install apple-silicon-qwen36 --model-root ~/Models
```

Execute the same plan only after review:

```zsh
lloom install apple-silicon-qwen36 --model-root ~/Models --apply --yes
```

To add a recipe to an existing multi-model gateway without replacing its current model registry,
default chat model, or existing keep-warm runtimes, use additive setup:

```zsh
lloom setup --recipe <recipe-id> --additive --apply --yes --start
```

Only recipe models with `settings.keepWarm: true` have `keepWarm: true` applied to their runtime in
additive mode. Replacement-oriented first-run setup remains the default when `--additive` is absent.

Real execution records completed steps in `~/.lloom/install-state.json` unless `--state` overrides it. If setup is interrupted, rerunning the command skips completed steps and resumes from the next pending step.

Inspect current install state and seeded model folders:

```zsh
lloom setup-status --recipe apple-silicon-qwen36 --model-root ~/Models --no-runtimes
```

The report compares the selected recipe plan to installer state, checks whether model destinations are already populated, and verifies whether selected client integration files match the generated registry.

`download-model` steps currently support Hugging Face artifacts. LLooM resolves `LLOOM_HF_BIN`, `HF_HUB_CLI`, `hf`, then `huggingface-cli`, and runs:

```zsh
hf download <model-id> --local-dir <model-root>/<model-id>
```

MTPLX recipes use MTPLX's cache-safe directory convention for Hugging Face model IDs, so `owner/model` is stored under `<model-root>/owner--model`. This matches `mtplx pull` and lets `mtplx serve` resolve already-cached models without a second copy.

Existing destination directories with model payload files are treated as already downloaded, which lets users seed model files manually or resume after external downloads. Metadata-only partial downloads are reported as missing.

## Ad Hoc Model Intake

Community recipes are the preferred route when LLooM should decide the best backend/model lane for a machine. For one-off models, use `add-model`:

```zsh
lloom add-model mlx-community/Qwen3.6-27B-OptiQ-4bit
lloom add-model https://huggingface.co/unsloth/Qwen3.6-27B-MTP-GGUF/blob/main/Qwen3.6-27B-MTP-Q4_K_XL.gguf
lloom add-model qwen3:8b --backend ollama
lloom add-model ~/Models/model.gguf --context-window 131072
```

The command accepts Hugging Face URLs, Hugging Face repo IDs, local paths, and Ollama tags. It infers MTPLX, MLX LM, llama.cpp, or Ollama where possible, allocates a backend port from the configured range, and returns a dry-run JSON plan with backend setup, download, config, runtime, and integration follow-up commands. Apply writes only the LLooM config:

```zsh
lloom add-model mlx-community/Qwen3.6-27B-OptiQ-4bit --keep-warm --default --apply --yes
```

Use `--go` instead of `--apply --yes` for the one-step managed flow. LLooM installs the inferred backend, downloads the model, writes the registry/runtime configuration, starts and warms the runtime, and waits for its health endpoint:

```bash
lloom add-model mlx-community/Qwen3.6-27B-OptiQ-4bit --keep-warm --default --go
```

Remove an imported model with a complete dry-run first:

```bash
lloom remove-model mlx-community/Qwen3.6-27B-OptiQ-4bit
lloom remove-model mlx-community/Qwen3.6-27B-OptiQ-4bit --apply --yes
```

Removal clears aliases, defaults, and client catalog entries that lead to the model. Dedicated runtimes and backends are removed; shared ones are preserved and identified in the plan. Weights remain in place unless `--delete-files` is supplied, and that destructive option is accepted only for an unshared path safely contained by the configured model root.

The existing `--apply --yes` form intentionally remains registration-only for automation that wants to manage backend installation, model transfer, or runtime startup separately. Unmanaged external OpenAI-compatible and LM Studio entries have no runtime for LLooM to start, so `--go` registers them after skipping the managed install/download/start phases.

## Community Index

`recipes/index.json` is the local cache that automatic selection reads. A hosted `lloom-host` service can publish signed recipe packs, but the gateway always imports them into this local index before setup uses them:

- `id`: recipe ID, matching the recipe JSON.
- `path`: relative path under `recipes/`.
- `name` and `summary`: display copy for pickers and reports.
- `tags`: searchable traits such as hardware family, backend, model family, context, or modality.
- `recommendedFor`: short machine/workload guidance.
- `source`: where the recipe entry came from.

Validate the index and its attached evidence:

```zsh
lloom recipe-index
```

The report checks the index schema, verifies that each listed recipe file loads, validates the portable recipe shape against the backend catalog, attaches the best benchmark evidence for each model role, and emits `plan`, `install`, and `bootstrap` commands.

## Community Recommendations

When `community.hostUrl` is configured, or when a host is supplied explicitly, LLooM can ask `lloom-host` for the best recipe packs for the current `machine-profile.v1` hardware profile:

```zsh
lloom onboard --host https://community.example
lloom community --host https://community.example
lloom community-import --host https://community.example --apply --yes
```

`onboard --host` is the normal first-run path: it fetches the host `recommendation-response.v1`, validates the selected pack, uses the recommended recipe in memory for the setup dry-run, and imports the pack before setup when applied. `community` is a lower-level dry-run that fetches the same response, normalizes direct pack URLs or inline pack JSON, and returns the same recipe-pack validation plan used by `recipe-import`. `community-import` is guarded by `--apply --yes` and writes only to the local recipe index, recipe files, and benchmark evidence roots.

The gateway exposes the same flow:

```zsh
curl -sS 'http://127.0.0.1:8100/gateway/community/recommendations?host=https%3A%2F%2Fcommunity.example'
curl -sS 'http://127.0.0.1:8100/gateway/onboarding/plan?host=https%3A%2F%2Fcommunity.example'
curl -sS -X POST http://127.0.0.1:8100/gateway/community/import \
  -H 'content-type: application/json' \
  -d '{"host":"https://community.example","requireSignature":true,"yes":true}'
```

After import, normal setup continues from the local cache:

```zsh
lloom library
lloom setup --apply --yes --start
```

## Recipe Packs

Community packs bundle one or more recipes, index entries, and benchmark suites into a single importable JSON file:

```zsh
lloom recipe-export apple-silicon-qwen36 --output qwen-pack.json
lloom validate qwen-pack.json
lloom recipe-export apple-silicon-qwen36 --output qwen-pack.json --apply --yes
lloom recipe-import ./qwen-next-pack.json
lloom recipe-import ./qwen-next-pack.json --trusted-key publisher=./publisher.pub --require-signature
lloom recipe-import ./qwen-next-pack.json --apply --yes
```

Dry-run is the default. `recipe-export` bundles local recipe-index entries, recipe files, and matching benchmark suites into the versioned `recipe-pack.v1` interchange format. `lloom validate` is the short form of `lloom interchange validate`; use it before publishing packs or benchmark suites. Real export writes require `--apply --yes`. `recipe-import` writes recipe files under `recipes/`, merges entries into `recipes/index.json`, and writes attached benchmark suites under `benchmarks/community/`.

For signed publishing:

```zsh
lloom recipe-export apple-silicon-qwen36 \
  --output qwen-pack.json \
  --key-id publisher \
  --private-key publisher.key \
  --public-key publisher.pub \
  --apply --yes
```

The running gateway exposes the same guarded import flow for dashboards and hosted feed URLs:

```zsh
curl -sS -X POST http://127.0.0.1:8100/gateway/recipe-packs/plan \
  -H 'content-type: application/json' \
  -d '{"source":"https://community.example/v1/recipe-packs/apple-silicon.json"}'
curl -sS -X POST http://127.0.0.1:8100/gateway/recipe-packs/import \
  -H 'content-type: application/json' \
  -d '{"source":"https://community.example/v1/recipe-packs/apple-silicon.json","requireSignature":true,"yes":true}'
```

Signed packs use Ed25519 signatures over a canonical form of the pack without the `signatures` field. Import reports signature status in dry-runs. Passing `--require-signature` rejects unsigned packs; passing one or more `--trusted-key key-id=pubkey.pem` flags also requires a verified signature from one of those trusted key IDs.

Minimal pack shape:

```json
{
  "schemaVersion": 1,
  "id": "example-pack",
  "name": "Example Pack",
  "signatures": [
    {
      "keyId": "publisher",
      "algorithm": "ed25519",
      "signature": "base64-signature"
    }
  ],
  "recipes": [
    {
      "index": {
        "id": "example-recipe",
        "path": "example-recipe.json",
        "name": "Example Recipe",
        "summary": "What this recipe is best for."
      },
      "recipe": {},
      "benchmarks": []
    }
  ]
}
```

`recipe-import` also accepts HTTP(S) URLs, so `lloom-host` can offer direct one-command imports while keeping the same guarded validation path.

`lloom-host` remains outside the local gateway. It can rank submissions, build leaderboards, moderate publishers, rotate signing keys, and emit packs. It should not proxy model calls, start runtimes, or decide local memory eviction.

The portable JSON contracts are documented in `docs/interchange.md` and backed by JSON Schemas in `schemas/`.

Contributor publish flow:

1. Add `recipes/<recipe-id>.json`, or archive the old document before updating it.
2. Add benchmark evidence under `benchmarks/community/`.
3. Add or update the recipe in `recipes/index.json`.
4. Run `npm run check`.
5. Run `npm run smoke`.
6. Run `lloom recipe-index` and confirm `ok: true`.

### Recipe version history

An active recipe always keeps the stable path `recipes/<recipe-id>.json`. Before changing it, preserve the old document unchanged at `recipes/archive/<recipe-id>/v<version>.json`, increment the active document's `version`, and update the index entry:

```json
{
  "id": "example-recipe",
  "path": "example-recipe.json",
  "currentVersion": 2,
  "versions": [
    { "version": 1, "path": "archive/example-recipe/v1.json", "status": "archived" },
    { "version": 2, "path": "example-recipe.json", "status": "current" }
  ]
}
```

Only the stable active file participates in planning and automatic recommendation. `lloom recipe-index` also reads every declared history file and fails validation if its `id` or `version` does not match the index. The seed host keeps a matching archive below `community/recipes/archive/`.

LLooM intentionally does not use stale model fallback aliases to make an index pass. Recipe `model` and `gatewayModel` values must be exact advertised IDs.
