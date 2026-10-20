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

Per-model image, video and music recipes, each in its own ComfyUI runtime, are documented in [ComfyUI media](comfyui-media.md).

Per-model NVIDIA speech and transcription recipes are documented in [Spark audio](spark-audio.md).
## Atlas SparkGLM

`linux-nvidia-dgx-spark-2x-glm53-atlas` is the LLooM-managed lane for the
Atlas SparkGLM engine on two directly connected DGX Sparks, pinned to the
2026-10-17 FP4-Local release. It serves `nvidia/GLM-5.3-Flash-FP4-Local` as
published. The release image qualified on a DGX Spark pair (Enntity/sparkglm
`results/2026-10-17-fp4local`) and serves in production.

```sh
lloom setup --recipe linux-nvidia-dgx-spark-2x-glm53-atlas --additive --apply --yes
lloom runtime-start glm53-flash-atlas-cluster
```

The recipe is additive. It does not set a default model and does not overwrite
aliases, so an existing GLM-5.3 Flash route keeps working.

Licenses: the recipe and LLooM's backend files are MIT. The engine is
[Atlas](https://github.com/Atlas-Inf/atlas) with SparkGLM's work on the
[Enntity/atlas](https://github.com/Enntity/atlas) fork, **AGPL-3.0-only**, and
runs from its own container image; LLooM includes none of its source. The
DFlash2 drafter `incoai/GLM-5.3-Flash-DFlash2` is **CC BY-NC-ND 4.0
(non-commercial)**. See the backend README's "Credits and licenses" section and
[Third-Party Notices](../THIRD_PARTY_NOTICES.md).

### Single pin manifest and fail-closed pin gate

All portable identities for the lane live in exactly one place,
`backends/atlas-sparkglm/pins.json`: the `Enntity/sparkglm` source revision and
the git tree of its `install/` directory, the immutable image manifest
reference (`image.reference`) with the tag kept as source-build metadata and
the install-tree contents label, the Enntity/atlas engine commit the image
records, and the `nvidia/GLM-5.3-Flash-FP4-Local` and drafter revisions. The
current source pin is product revision
`c28da418444e954323ee885ffc3954965794a679` with install tree
`c8ced64316bf0b9b2b116d6a0bcdfca52064545b` and engine `b3b016ab`, so the normal
install path addresses the immutable digest
`ghcr.io/enntity/atlas-sparkglm@sha256:0b91fd790afb2ee3aa5a7f39a0bc5a90db05751436ae7810e00f129c36ebbb7b`.
The tag `ghcr.io/enntity/atlas-sparkglm:c8ced64316bf` is source-build metadata
(first 12 characters of the install tree) and is never pulled; a tag alone is
not an immutable artifact identity. A later product revision is adopted by
changing the revision, the install tree, the engine commit, the derived tag
and the pinned digest.

While any required value is missing, malformed, or a placeholder, the gate
fails closed:

```sh
node backends/atlas-sparkglm/verify-pins.mjs
```

The same check runs as backend setup step `check-atlas-pins`, and again inside
`install.sh`, so an invalid manifest cannot pull, build, or start anything. The
recipe test uses an explicit temporary placeholder manifest to cover that
refusal path. The checker also rejects a revision, install tree, engine commit
or drafter revision that is not a 40-character lowercase git object id, a model
other than the pinned FP4-Local revision, an image tag
not derived from the install tree, and an `image.reference` that is not
`ghcr.io/enntity/atlas-sparkglm@sha256:` followed by 64 lowercase hex
characters. Image IDs are never pinned; the installer checks the local image's
architecture and install-tree contents label, which proves contents but is not
the artifact identity.

### Pinned image: immutable digest pull or explicit source build

Setup step `build-atlas-image` runs `bash backends/atlas-sparkglm/install.sh`
with the managed backend and install roots. The normal path reuses an already
verified local image, otherwise pulls the immutable manifest digest
(`image.reference`) from GHCR. It never pulls the mutable tag, and a failed
pinned digest pull is a hard failure: there is no silent fallback to the tag or
to a source build. The explicit `--source-build` option instead clones
`Enntity/sparkglm` at the exact `SOURCE_REVISION`, checks that `HEAD` is the
pinned revision and `HEAD:install` is the pinned install tree, and runs that
repository's `install/build.sh`, which must print the pinned tag. That build
produces a **LOCAL tag** for an explicitly overridden local recipe only; it does
**not** satisfy the normal immutable recipe, which addresses `image.reference`.
`--check-only` combined with `--source-build` deliberately verifies the local
source-build tag instead of the digest. On every path the selected image must be
arm64 and carry `io.enntity.sparkglm.install-tree` equal to the pinned tree, and
it must ship the entrypoint, the selected profile and the pinned engine commit
in `/opt/atlas/source-manifest.json`. A mismatch is a hard failure.

**No build runs on the serving path.** Only a prepared image is started.

### Checkpoint served as published

`nvidia/GLM-5.3-Flash-FP4-Local` ships its MTP layer quantized, so there is no
conversion step: setup step `download-atlas-model` acquires the pinned revision
into `${modelRoot}/nvidia--GLM-5.3-Flash-FP4-Local`, and both members mount that
directory read-only as `MODEL_PATH`. The image's `serve.py` refuses to start
unless the checkpoint is complete and its MTP layer is quantized. The earlier
`nvidia/GLM-5.3-Flash-NVFP4` checkpoint needs an MTP overlay this recipe does
not prepare; Enntity/sparkglm's own `start.sh` still serves it.

### Container contract

The engine profile ships inside the image, not in the recipe. LLooM passes
environment and mounts; the image's `/opt/atlas/serve.py` selects the argument
vector from `/opt/atlas/profiles/4x1m.json` (the recipe's `SPARKGLM_PROFILE=4x1m`;
`serve.py` defaults to `4x512k`).

| Variable                                               | Meaning                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `NODE_RANK`                                            | `0` on the leader, `1` on the worker                                      |
| `MASTER_ADDR`                                          | discovered direct-fabric address of the leader                            |
| `MASTER_PORT`                                          | `29510`                                                                   |
| `FABRIC_INTERFACE`                                     | discovered direct-fabric NIC, also `NCCL_SOCKET_IFNAME`                   |
| `MODEL_PATH`                                           | mounted checkpoint, `${modelRoot}/nvidia--GLM-5.3-Flash-FP4-Local`        |
| `SERVED_MODEL_NAME`                                    | `glm-5.3-flash-atlas`                                                     |
| `ATLAS_WORLD_SIZE` / `ATLAS_TP_SIZE` / `ATLAS_EP_SIZE` | `2`                                                                       |
| `NCCL_*`                                               | IB transport with per-node `NCCL_IB_HCA=${fabricHca}`, `AF_INET`, `NCCL_CROSS_NIC=0` |

Listeners are private and loopback-bound per node: leader `127.0.0.1:8893`,
worker `127.0.0.1:8894`. The worker starts first (`order` 10, rank 1) with
`healthStrategy: "container"` and no warmup, because the engine exposes no
separate worker HTTP surface. The leader starts second (`order` 20, rank 0),
health-checks `/health`, runs a POST warmup, and then owns routing.

### Baseline envelope

The 4x1m profile serves 1048576-token contexts to four concurrent sequences
from one shared FP8-latent KV pool, split between the two nodes (about 2.6M tokens at the recipe's 0.91 GPU memory utilization with the display carveout and the disk prefix cache; it also holds the prefix cache, with 16 recurrent-state snapshot slots), with FP32 SSM state,
DFlash2 speculation (gamma 8) on the head rank, GPU memory utilization 0.91
(the recipe's `SPARKGLM_GPU_MEMORY_UTILIZATION`, overriding the profile
default of 0.88), and `--memory=114g` with a 4096 MiB OOM guard. `disable-tool-grammar` is **not**
set, so structured output and tool calling stay functional. The image includes
image and video input support. Release qualification with this image: prompt
logprob hash `25bc828eea3f`, tools 21/21, ToolEvalBench 91.

Both nodes must carry the same portable source, engine, model and drafter pins and an
identical `backends/atlas-sparkglm` directory. The normal path has both hosts
pull the same immutable digest, so they run the same artifact; each host then
verifies the pulled image's install-tree contents label, arm64 architecture and
engine commit.
An explicit `--source-build` produces a **LOCAL tag** for an explicitly
overridden local recipe only, does not satisfy the normal immutable recipe, and
can produce different image IDs across hosts.

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

### Per-node RDMA ports for Atlas SparkGLM

The Atlas recipe requires `fabricInterface` and `fabricHca` on each participating
`cluster.nodes` entry. `fabricHca` is a comma-separated list of exact local RDMA
device names, without spaces or `:port` suffixes. Names and physical port numbers
can differ between nodes. For example:

```json
{
  "cluster": {
    "leaderNode": "left",
    "nodes": {
      "left": { "backendHost": "192.0.2.1", "fabricInterface": "enp1s0f1np1", "fabricHca": "rocep1s0f1,roceP2p1s0f1" },
      "right": { "backendHost": "192.0.2.2", "fabricInterface": "enp1s0f0np0", "fabricHca": "rocep1s0f0,roceP2p1s0f0", "labels": { "role": "worker" } }
    }
  }
}
```

Check each host's `/sys/class/infiniband/<device>/device/net` and active RoCE
IPv4 GIDs against the pair's network interfaces. Include only rails to the other
participating node; a backchannel to a third node is not a serving rail. NVIDIA
Sync discovery supplies network inventory, but does not prove which additional
RDMA rails should participate. Missing or malformed settings stop recipe
materialization with the node and field named in the error.

The recipe passes each node's exact list as `FABRIC_HCA` and `NCCL_IB_HCA`, and
sets `FABRIC_SIBLINGS=0` so the image cannot add another device. The pinned image
sets Atlas's direct RDMA rails from the same list. Existing running containers
are unchanged; set these fields before reapplying the updated recipe. No image
rebuild is required for this LLooM configuration change.

Applying NVIDIA Sync discovery refuses ambiguous peer/interface observations.
An explicit per-node `fabricHca` selection also preserves that node's configured
interface and backend address when refreshing discovery.

## Atlas SparkGLM TP-4 chain

`linux-nvidia-dgx-spark-4x-glm53-atlas-tp4` serves the same
`nvidia/GLM-5.3-Flash-FP4-Local` checkpoint and DFlash2 drafter as the pair
lane on four DGX Sparks cabled as a daisy chain (no switch, no cable between
the ends), at tensor and expert parallelism 4. It is a separate lane,
`glm-5.3-flash-atlas-tp4`, with its own runtimes
(`glm53-flash-atlas-tp4-cluster`, `-head`, `-worker-<node>`) and containers
(`lloom-atlas-sparkglm-tp4-<node>`), so it can be configured beside
`glm-5.3-flash-atlas`. Both lanes use 127.0.0.1:8893 on rank 0's Spark and
114 GiB on every Spark they share, so admission runs one at a time.

**The pins are drafts.** No TP-4 release image exists yet:
`backends/atlas-sparkglm/pins-tp4.json` has status `draft` and `TODO-TP4-RC`
placeholders for the Enntity/sparkglm revision and install tree, the engine
branch and commit, and the GHCR digest and tag, and the recipe's
`bootstrap.image` is the matching placeholder digest. The setup steps
`verify-atlas-pins` and `build-atlas-image` run `verify-pins.mjs` and
`install.sh --manifest` against that manifest on every apply and refuse it, so
nothing is downloaded, pulled or started. To adopt a release candidate:

1. Fill `source.revision`, `source.installTree`, `engine.branch`,
   `engine.commit` and `image.reference` from the RC (the image must ship
   `/opt/atlas/profiles/4x1m-tp4.json`), set `image.tag` to
   `ghcr.io/enntity/atlas-sparkglm:` plus the first 12 characters of the
   install tree and `status` to `final`, and update the manifest's `note`;
   `node backends/atlas-sparkglm/verify-pins.mjs backends/atlas-sparkglm/pins-tp4.json`
   must pass.
2. Put the same `image.reference` in both members' `bootstrap.image`, replace
   the draft wording in the recipe's description, provenance, hardware notes
   and index entry with the RC's identities and qualification receipts, and
   run `node test/atlas-sparkglm-tp4-recipe.test.mjs` (update its draft-status
   assertions).
3. On each of the four Sparks, with the chain declared as below, preview and
   then apply `lloom setup --recipe linux-nvidia-dgx-spark-4x-glm53-atlas-tp4
   --additive`, and start it with `lloom runtime-start
   glm53-flash-atlas-tp4-cluster` from the leader.

The chain is declared per node with `cluster.nodes[ID].fabricChain` (see
[chain topology](clusters.md#chain-topology)): rank, the interface every rank
reaches the others on, rank 0's address on it, and the exact RDMA devices
toward each neighbour. Each ConnectX-7 port shows two RDMA devices, one per
PCIe half, so each side lists both. Rank 0 must be the cluster leader in every
node's LLooM config.

| Variable | Source | Meaning |
| --- | --- | --- |
| `NODE_RANK` | `fabricChain.rank` | position along the chain |
| `MASTER_ADDR` | rank 0's `fabricChain.address` | rendezvous; every rank must reach it |
| `FABRIC_INTERFACE`, `NCCL_SOCKET_IFNAME`, `GLOO_SOCKET_IFNAME` | `fabricChain.interface` | startup traffic |
| `FABRIC_LEFT_HCA`, `FABRIC_RIGHT_HCA` | `fabricChain.leftHca`, `rightHca` | the engine's per-link RDMA rails (empty at the ends) |
| `FABRIC_SIBLINGS` | `0` | use exactly the listed devices |
| `SPARKGLM_PROFILE` | `4x1m-tp4` | world/TP/EP 4, 1048576-token contexts, four sequences |
| `SPARKGLM_GPU_MEMORY_UTILIZATION` | `0.88` | the profile's default |
| `SPARKGLM_KV_SHARD`, `SPARKGLM_DISPLAY_CARVEOUT` | `0` | off: refused beyond two ranks / not qualified at four |
| `SPARKGLM_PREFIX_CACHE_GB` | `${prefixCacheGb}` (`0`) | disk prefix cache, off until qualified at four ranks |

The recipe passes no `ATLAS_*` and no `NCCL_*` transport variable: the
image's `serve.py` drops `ATLAS_*` from the container environment, and the
4x1m-tp4 profile carries every engine switch plus NCCL's transport (sockets,
IB off, since NCCL cannot reach a Spark that is not cabled to it; the engine
runs the all-reduce over the rails above). Container hardening, limits and
mounts are the pair lane's. The workers start from the far end (ranks 3, 2, 1;
`rankOrder: "descending"`) with container health, then the leader (rank 0)
with `/health` and a POST warmup.

## Atlas SparkQwen FP4-Local

Maintenance release accepted with disclosed limits; full_quality_pass=false. Recipe integration and guarded production canaries are approved; persistent activation remains pending live evidence. `linux-nvidia-dgx-spark-2x-qwen38-flash-next-atlas` serves the unchanged FP4-Local checkpoint with native MTP and the 8x262k profile. Product `050743206a7fd921eaa5acf1cbe50653b9f155cc`, install tree `70890529ba64dede889814f99f21b3c9a981d9bc`, engine `63bebfa60d5086de9fc8cc07c21e5fbe38f3b742`. Engine source reference `sparkqwen/fidelity-rc-20261019` is an annotated tag, not a new branch. Maintenance review: https://github.com/Enntity/sparkqwen/blob/050743206a7fd921eaa5acf1cbe50653b9f155cc/results/2026-10-20-fidelity-review/qualification.json (SHA256 d591b033b0c396a2b0222b6c63136bc323e1bb5b69a206eac3c7df942b24be8b). Publication acceptance SHA256 7e2e699de3e8d06cb4a6eb3a3df5add15c8aaf18172f0f299aa1a0628ea91de0; separate production disposition SHA256 7b626caea8a546f868854d5c07eeaed103f5bf0c4ba3048b0e2d16fa85ede346.

- Full quality gate remains failed. This release does not establish numerical parity, universal speculative equivalence, a lossless recipe, or an all-quality-pass result.
- Canonical prompt NLL is 1.0659923317039264, a residual of +0.0404426398902944 against the observed A4 reference. The earlier native baseline was higher at 1.1216532930400633. These comparisons do not establish a cause.
- Needle recall is 59/60 versus the retained historical 60/60 result. One lookup failed at 163,290 prompt tokens. Speculative ON and OFF at concurrency 1 returned the same wrong decoded fields; the original concurrency-4 run and different cache histories limit this comparison.
- Automatic tool selection combined with strict JSON can choose an unrelated tool. The explicit tool_choice: none control returned the correct JSON.
- Performance is mixed, including slower Rig medians and concurrency-2/4/8 cells. The matrix has one invocation per cell; its concurrency-1 32K cell is slower. Four warm-conversation request bodies differ because earlier responses generate later history.
- Logit bias on the first prefill token remains an inherited unsupported contract.
- The oversized PNG probe establishes header admission only; it does not prove full pixel decoding.

```sh
lloom setup --recipe linux-nvidia-dgx-spark-2x-qwen38-flash-next-atlas --additive --apply --yes
lloom runtime-start qwen38-flash-next-atlas-cluster
```

For shared hosts, the image accepts `SPARKQWEN_GPU_MEMORY_UTILIZATION=0.70`
through `0.95` in each physical runtime's Docker environment. Lower settings
leave room for host services and reduce the shared KV pool; the published
context/concurrency measurements apply to the default 0.88 allocation. Keep
the logical runtime, physical runtimes, and each placement member's
`resources.memoryGb` reservation consistent with the chosen deployment.
Do not raise the host memory safety limit to make an oversized cache fit.

The recipe is additive (no default model, no aliases, `keepWarm` false). Pins
live in `backends/atlas-sparkqwen/pins.json` (source `Enntity/sparkqwen`
`05074320`, install tree `70890529ba64`). The GHCR manifest digest is pinned in the same manifest.
`node backends/atlas-sparkqwen/verify-pins.mjs`, setup step
`verify-atlas-pins` and `install.sh` reject missing or placeholder identities. The
installer only pulls that digest and verifies the image's arm64 architecture,
`io.enntity.sparkqwen.install-tree` label, entrypoint, profile and engine
commit; it never builds.

Each member receives `FABRIC_HCA=${fabricHca}` and `FABRIC_SIBLINGS=0`. As with
the SparkGLM recipe, LLooM requires an explicit per-node `fabricHca` (a
comma-separated list of exact local RDMA device names) and `fabricInterface` on
every participating `cluster.nodes` entry; it never guesses an HCA from the NIC
name, because PCI naming and cabling differ by host. Missing or malformed
settings stop recipe materialization with the node and field named in the error.
The image's `serve.py` fixes the API port: rank 0 serves `127.0.0.1:8893` on the
leader (rank 1 binds `127.0.0.1:8894` on the worker), the same ports as the
SparkGLM lane, so the two lanes cannot share a pair. The bounded tools and vision checks are recorded in the release evidence.
Automatic tools combined with strict JSON retain the failure disclosed above;
these checks do not establish a full quality pass. The engine is
**AGPL-3.0-only** and the checkpoint is under the NVIDIA Open Model License; see
the [backend README](../backends/atlas-sparkqwen/README.md#credits-and-licenses).
