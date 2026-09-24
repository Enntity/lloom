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

The current high-memory defaults include Apple Silicon Qwen3.6 lanes, Unsloth Qwen3.6 35B-A3B and 27B NVFP4 lanes for NVIDIA GB10, FLUX.2 Klein 4B for fast conventional image generation and reference editing, Qwen-Image-2512 for higher-quality generation, and Qwen-Image-Edit-2511 for reference-faithful edits. Local clone TTS uses Qwen3-TTS on Apple Silicon by default; add Chatterbox with `apple-silicon-chatterbox` or `linux-nvidia-gb10-chatterbox` when you want exaggeration and CFG control.

DGX Spark uses the dedicated `linux-nvidia-gb10-image-generation` recipe. It materializes three additive, on-demand Docker runtimes backed by LLooM's stable-diffusion.cpp CUDA image, so the host does not need a separate CUDA compiler toolchain. The cross-platform `high-memory-local-image-generation` recipe remains the source-build path for Apple Silicon and CUDA development hosts.

## Apple Silicon Qwen3.6 Starting Point

On the current M2 Max 96 GB machine, the strongest observed Qwen3.6 lanes were:

- Dense 27B: `Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed`
- 35B-A3B MoE: `Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16`

These are encoded in `recipes/apple-silicon-qwen36.json` and exposed by default in `config/default.json`.

## Chatterbox TTS

Local clone TTS with exaggeration and CFG:

- Apple Silicon (MPS): `apple-silicon-chatterbox`
- DGX Spark / NVIDIA CUDA: `linux-nvidia-gb10-chatterbox`

Add it beside an existing gateway without replacing chat defaults:

```zsh
lloom setup --recipe apple-silicon-chatterbox --additive --apply --yes
lloom runtime-start chatterbox
```

Speech API extras: `voice` (named LLooM profile), `ref_audio` / `audio_prompt_path`, `exaggeration`, `cfg_weight`, `temperature`, `language` / `language_id` (multilingual), plus `ResembleAI/chatterbox-turbo` for the faster lane. Do not install the Spark recipe until the host has spare memory.

Chatterbox keeps ResembleAI's built-in Perth watermark enabled. Only create or clone voices you own or have explicit permission to use, and disclose synthetic audio where appropriate.
Community host seed recipes also publish split Apple Silicon MTPLX lanes plus a Linux/NVIDIA Qwen3.6 27B NVFP4 vLLM lane under `community/recipes/`; first-run onboarding can consume those signed packs directly from `lloom-host` and let machine-profile evidence decide which one fits.

## LLooM Hear

The `lloom-hear` recipe provides CPU sound and music analysis with a Markdown
report, structured estimates, and an optional dashboard image. It requires
Python 3.11 or newer, ffmpeg, and ffprobe.

```sh
lloom setup --recipe lloom-hear --additive --apply --yes
lloom runtime-start hear
```

Call `model: "hear"` with inline `input_audio` in a non-streaming chat completion.
Local paths and remote URLs require operator configuration. Interpretation is
off by default; `hear.interpret: true` sends the analyzed segment to the configured
upstream model. Handle abstention, withheld estimates, and key/tempo ambiguity.

See [LLooM Hear](../backends/hear/README.md) for the calling convention, input
limits, permissions, tests, and measurement limitations.

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
- `capabilities`: the API contract the model supports, for example `responses`, `anthropic-messages`, `tools`, `reasoning`, `vision`, `mtp`, or `long-context`. Media capabilities select the model kind and therefore the serving route: `image-generation`/`image-editing` give `image`, `video-generation` gives `video`, `audio-generation`/`music-generation`/`audio-music-generation` give `audio_generation`, and `audio-speech`/`tts` give `audio_speech`. A music capability wins over a speech capability when a recipe declares both.
- `settings`: runtime knobs consumed during config materialization, including `contextWindow`, `maxOutputTokens`, `maxActiveRequests`, `profile`, `draftDepth`, `reasoning`, `preserveThinking`, `batchingPreset`, `memoryGb`, `startupTimeoutMs`, `priority`, `keepWarm`, and session-cache fields. `keepWarm` is the single hard residency pin and is valid only for a managed internal runtime. `priority` orders only unpinned eviction candidates; lower values are evicted first.
- `settings.runtime`: optional explicit launcher data for recipes that need backend-specific command lines or bootstrap-only managed containers. LLooM templates `command`, `args`, `env`, `bootstrap`, `healthPath` or `healthUrl`, `warmup`, `watchdog`, and session-cache hints with variables such as `${modelRoot}`, `${modelPath}`, `${modelId}`, `${port}`, `${contextWindow}`, `${maxOutputTokens}`, `${maxActiveRequests}`, `${runtimeId}`, and `${sessionCacheDir}`. If it is absent, LLooM uses the built-in defaults for known backends.
- `settings.placement`: optional cluster placement. `{"mode":"replicated"}` materializes one local target on every configured node (or the `nodes` subset) plus leader-side LLooM proxy targets for remote replicas; distributed logical runtimes use ordered delegated `members` with per-node resource estimates. See [`clusters.md`](clusters.md).
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

For reproducible acquisition, a `download-model` step may also declare an immutable provider `revision`, a `downloadSizeBytes` disk preflight, per-file `integrity.files` size/SHA-256 evidence, and an `include` list of repository-relative paths or globs. Use `include` for any model whose repository carries more than the lane serves: a checkpoint repository usually holds every quantization, so fetching the whole repository pulls tens of gigabytes the runtime never loads. An `include` list and `integrity.files` should name the same files; the integrity entries are what make an interrupted acquisition resumable and a re-run skippable. LLooM downloads these steps into a sibling `.incomplete` directory, resumes there after interruption, verifies the declared evidence, writes `.lloom-acquisition.json`, and atomically publishes the completed model directory. Existing unpinned recipes remain backward compatible and continue to use payload-presence checks.

Recipe evaluation also exposes a versioned `resourceFit` result. Profiles describe stable `memoryDomains` (including Apple unified memory and discrete accelerator memory) plus a topology fingerprint. A recipe can supply `requirements.resourceEstimate` with aggregate or per-domain memory, reserve, context, source, confidence, and provenance. Stable hardware fit remains separate from point-in-time loadability; the runtime admission policy remains authoritative for current memory pressure and eviction.

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

Standalone image, video and music recipes with a shared ComfyUI backend are documented in [ComfyUI media](comfyui-media.md).

## Atlas SparkGLM candidate

`linux-nvidia-dgx-spark-2x-glm53-atlas` is the LLooM-managed candidate lane for
the source-built Atlas SparkGLM engine on two directly connected DGX Sparks.
Its portable source and model pins are final for the current candidate, while
live hardware and full serving qualification remain pending.

```sh
lloom setup --recipe linux-nvidia-dgx-spark-2x-glm53-atlas --additive --apply --yes
lloom runtime-start glm53-flash-atlas-cluster
```

The recipe is additive. It does not set a default model and does not overwrite
aliases, so an existing GLM-5.3 Flash route keeps working.

### Single pin manifest and fail-closed pin gate

All portable identities for the lane live in exactly one place,
`backends/atlas-sparkglm/pins.json`: the `Enntity/sparkglm` source revision, the
image tag, the `nvidia/GLM-5.3-Flash-NVFP4` revision, and the conversion marker
contract. Image IDs are host-local and are checked from each build receipt plus
the local OCI image metadata. The current source pin is product revision
`e31900c3ba01809dc39e63ba55f43194f040f933`; a later product revision can be
adopted by changing this one portable pin and its derived local image tag.

While any required value is missing, malformed, or a placeholder, the gate
fails closed:

```sh
node backends/atlas-sparkglm/verify-pins.mjs
```

The same check runs as backend setup step `check-atlas-pins`, and again inside
`install.sh` and `convert-overlay.sh`, so an invalid manifest cannot build,
convert, or start anything. The recipe test uses an explicit temporary
placeholder manifest to cover that refusal path. The checker also rejects a
revision that is not a 40-character commit. Host-local image identity is
checked by the installer against its receipt, image architecture, and OCI
revision label.

### Source-built image, no registry publish

There is no published registry image. Setup step `build-atlas-image` runs
`bash backends/atlas-sparkglm/install.sh` with the managed backend and install
roots. It clones `Enntity/sparkglm` at the exact `SOURCE_REVISION`, verifies
`HEAD`, delegates compilation to that repository's
`research/atlas/install/build.sh`, and then confirms that the local tag
`lloom/atlas-sparkglm:SOURCE_REVISION` matches this host's build receipt, arm64
image inspection, and OCI revision label. A mismatch is a hard failure.

**No build runs on the serving path.** Only a prepared image is started.

### Overlay conversion gate

The NVFP4 checkpoint needs a once-per-node overlay conversion before it can be
served. Setup step `convert-atlas-overlay` runs
`backends/atlas-sparkglm/convert-overlay.sh`, which is idempotent per node and
never infers completion from directory existence: it requires
`conversion.complete.json` with `converted_matrices` equal to 864, nonempty
`shards`, absolute `source` and `output` paths, and a numeric `finished` value.
The converter's full CPU `--verify-overlay` pass must succeed. A directory
without that marker or without successful CPU verification remains incomplete.

### Container contract

The engine profile ships inside the image, not in the recipe. LLooM passes
environment and mounts; the image's `/opt/atlas/serve.py` selects the argument
vector from `/opt/atlas/profile.json`.

| Variable                                               | Meaning                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `NODE_RANK`                                            | `0` on the leader, `1` on the worker                                      |
| `MASTER_ADDR`                                          | discovered direct-fabric address of the leader                            |
| `MASTER_PORT`                                          | `29510`                                                                   |
| `FABRIC_INTERFACE`                                     | discovered direct-fabric NIC, also `NCCL_SOCKET_IFNAME`                   |
| `MODEL_PATH`                                           | mounted converted overlay root, `${installRoot}/atlas-overlay`            |
| `SERVED_MODEL_NAME`                                    | `glm-5.3-flash-atlas`                                                     |
| `ATLAS_WORLD_SIZE` / `ATLAS_TP_SIZE` / `ATLAS_EP_SIZE` | `2`                                                                       |
| `NCCL_*`                                               | IB transport with `NCCL_IB_HCA=rocep1s0f0`, `AF_INET`, `NCCL_CROSS_NIC=0` |

Listeners are private and loopback-bound per node: leader `127.0.0.1:8893`,
worker `127.0.0.1:8894`. The worker starts first (`order` 10, rank 1) with
`healthStrategy: "container"` and no warmup, because the engine exposes no
separate worker HTTP surface. The leader starts second (`order` 20, rank 0),
health-checks `/health`, runs a POST warmup, and then owns routing.

### Baseline envelope

The candidate profile uses a 36864-token total context, concurrency 4, BF16 KV
cache, FP32 SSM state, MTP2 speculation with native fallback above 32K, and
`--memory=114g` with a 4096 MiB OOM guard. `disable-tool-grammar` is **not** set,
so structured output and tool calling stay functional. The source build
includes image and video input support; gateway and two-node serving canaries
remain required for qualification.

Both nodes must carry the same portable source, model and converter pins and an
identical `backends/atlas-sparkglm` directory. Each host verifies its own
node-local image against its build receipt and OCI revision label; image IDs may
differ across hosts.

### OpenAI multimodal request

The Atlas model accepts OpenAI-compatible `image_url` and `video_url` content in
`/v1/chat/completions`. Use a real base64 payload in place of the placeholders
below. The gateway keeps these media parts intact, passes native JSON Schema and
tools through to Atlas, and still applies its normal request body byte limit.

```sh
curl http://127.0.0.1:8100/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "glm-5.3-flash-atlas",
    "stream": true,
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe the clip and image."},
        {"type": "video_url", "video_url": {"url": "data:video/mp4;base64,<base64-mp4>"}},
        {"type": "video_url", "video_url": {"url": "data:image/gif;base64,<base64-gif>"}},
        {"type": "image_url", "image_url": {"url": "https://example.test/frame.png", "detail": "low"}}
      ]
    }],
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "caption",
        "strict": true,
        "schema": {
          "type": "object",
          "properties": {"caption": {"type": "string"}},
          "required": ["caption"],
          "additionalProperties": false
        }
      }
    },
    "tools": [{
      "type": "function",
      "function": {
        "name": "save_caption",
        "parameters": {"type": "object", "properties": {"caption": {"type": "string"}}}
      }
    }]
  }'
```

Responses clients can send the same media URLs as `input_image` and
`input_video` content parts; LLooM converts those parts to the matching Chat
Completions form before forwarding the request.
