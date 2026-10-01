# Atlas SparkGLM under LLooM

LLooM-managed two-node Atlas SparkGLM candidate for a directly connected pair
of NVIDIA DGX Spark systems. This directory is **MIT orchestration only**: no
Atlas engine source is committed here. The engine image is built from immutable
revision `e58cdc237522f70e82d95e835721660608860eac` of `Enntity/sparkglm` by
that repository's `install/build.sh`. The engine inside the image is
AGPL-3.0-only; see [Credits and licenses](#credits-and-licenses). Live hardware
and full serving qualification remain pending.

## Layout

- `pins.json` — the single portable pin manifest for the candidate: the
  source revision and its `install/` git tree, the image tag and identity
  label, and the model, drafter and conversion marker contract.
- `verify-pins.mjs` — fail-closed pin gate. Exits non-zero while the manifest
  is not final, the source revision or install tree is not a 40-character git
  object id, the image tag is not `ghcr.io/enntity/atlas-sparkglm:` plus the
  first 12 characters of the install tree, or any portable identity is a
  placeholder. It rejects a pinned image ID: IDs differ between a pull and a
  local build, so identity is the install-tree label.
- `install.sh` — prepares `ghcr.io/enntity/atlas-sparkglm:76b6e4976aa1`. It
  reuses an already verified local image, otherwise pulls the tag from GHCR,
  otherwise clones `Enntity/sparkglm` at the pinned revision, checks that
  `HEAD:install` is the pinned tree, and runs `install/build.sh`, which must
  print the same tag. In every case the image must be arm64 with
  `io.enntity.sparkglm.install-tree` equal to the pinned tree and must ship the
  entrypoint, profile and converter contract below. `--check-only` verifies
  without pulling or building.
- `convert-overlay.sh` — explicit, once-per-node NVFP4 overlay conversion gate.

## Fail-closed pin policy

The checked-in manifest carries final portable identities for this
candidate. The gate still rejects temporary or malformed manifests before any
model acquisition, image build, conversion, or serving step:

```sh
node backends/atlas-sparkglm/verify-pins.mjs
```

The recipe test exercises that failure path with an explicit temporary
placeholder manifest; the installed candidate manifest verifies successfully.

No step infers completion from a directory existing. The overlay requires a
`conversion.complete.json` marker containing `converted_matrices` equal to 864,
nonempty `shards`, absolute `source` and `output` paths, and a numeric
`finished` value. The converter's CPU `--verify-overlay` pass is mandatory.
LLooM stores a sibling `conversion.complete.json.identity.json` sidecar with the
model revision and SHA-256 identities of the image's converter script and
library. Re-entry verifies the current acquisition before checking that sidecar;
an unchanged model and converter can reuse an overlay after a source/image pin
moves, while an incompatible completed overlay is preserved and requires
`--force` for a dated backup and reconversion.

## Installation

```sh
lloom setup --recipe linux-nvidia-dgx-spark-2x-glm53-atlas --additive --apply --yes
lloom runtime-start glm53-flash-atlas-cluster
```

The recipe is additive only. It does not set a default model and does not
overwrite aliases. Setup is the path that builds the image and converts the
overlay; the serving path only ever starts the **prepared** image. Nothing is
built while a runtime is starting.

Setup steps, in order:

1. `check-docker` — Docker must be present.
2. `verify-atlas-pins` — the final immutable pin gate above.
3. `download-atlas-model` — acquires `nvidia/GLM-5.3-Flash-NVFP4` at its exact
   40-character revision into the managed model root and records the LLooM
   acquisition manifest.
4. `download-atlas-drafter` — acquires `incoai/GLM-5.3-Flash-DFlash2` at its
   pinned revision. The drafter's weights are licensed **CC BY-NC-ND 4.0
   (non-commercial)**; read its model card before use.
5. `build-atlas-image` — `bash backends/atlas-sparkglm/install.sh` with the
   managed backend and install roots: pull or build, then verify.
6. `convert-atlas-overlay` — runs the GPU conversion once with at least 8 GiB
   free and then runs the full CPU verification pass. It never stops a serving
   container implicitly. On GB10, unavailable GPU-memory readings fall back to
   Linux `MemAvailable`. Forced reconversion moves the prior overlay to a dated
   backup so it remains recoverable.
7. `prepare-atlas-prefix-cache` — creates `${installRoot}/atlas-prefix-cache`
   with `kv/` and `ssm/`, which both members mount at `/prefix-cache`. It stays
   empty unless the prefix cache on disk is turned on (below).

## Container contract

The image ships its own engine profile and entrypoint. LLooM supplies
environment and mounts only; it does not pass per-flag engine arguments.

Inside the image:

- `/opt/atlas/serve.py` — entrypoint. Reads the environment below, then starts
  the engine with the profile's argument vector.
- `/opt/atlas/profiles/4x512k.json` — the benchmarked engine profile from
  `install/profiles/4x512k.json` in Enntity/sparkglm, selected by `serve.py`
  through `SPARKGLM_PROFILE` (default `4x512k`; the image also ships `8x128k`):
  `--kernel-target=glm-5.3-flash`,
  `--max-seq-len=524288`, `--max-num-seqs=4`, `--max-batch-size=4`,
  `--gpu-memory-utilization=0.88` (the profile default; the recipe overrides it
  with `SPARKGLM_GPU_MEMORY_UTILIZATION=0.93`), `--oom-guard-mb=4096`, `--kv-cache-dtype=fp8_g128`,
  `--ssm-h-dtype=f32`, `--ssm-rollback-mode=records`, `--dflash --dflash-gamma=8`
  with the DFlash2 drafter, and the rest of the candidate settings. Four requests
  share one physical FP8-latent KV pool (about 1.6M tokens at the recipe's 0.93 GPU memory utilization; it also holds the prefix cache, with 16 recurrent-state snapshot slots); it does not reserve
  four full windows. `disable-tool-grammar` is deliberately **not** set, so
  structured output and tool grammar stay functional. The engine is built from
  Enntity/atlas `sparkglm/atlas-20260930e` @ `08c90d8e` (recorded in the
  image's `/opt/atlas/source-manifest.json`); measured results are in
  Enntity/sparkglm `results/2026-09-30-decode-step/` (this engine) and
  `results/2026-09-30-nvme-tier/` (this image).
- `/opt/atlas/converter/convert.py` and `libatlas_mtp_quantize.so` — the
  overlay converter, including `--verify-overlay`. Its NVFP4 quantization
  kernel is copied unchanged from
  [Mango-kid/atlas](https://github.com/Mango-kid/atlas)
  (`kernels/gb10/common/quantize_bf16_to_nvfp4.cu` @ `90b3584a`,
  AGPL-3.0-only); see SparkGLM's `install/converter/provenance.json`.

Environment contract consumed by `/opt/atlas/serve.py`:

| Variable | Source | Meaning |
| --- | --- | --- |
| `NODE_RANK` | `${nodeRank}` | distributed rank; `0` on the leader, `1` on the worker |
| `MASTER_ADDR` | `${leaderAddress}` | discovered direct-fabric address of the leader |
| `MASTER_PORT` | `29510` | distributed rendezvous port |
| `FABRIC_INTERFACE` | `${fabricInterface}` | discovered direct-fabric NIC, also used for `NCCL_SOCKET_IFNAME` |
| `FABRIC_HCA` | `rocep1s0f0` | RoCE HCA, defaulted by the image and pinned by the recipe |
| `MODEL_PATH` | `${installRoot}/atlas-overlay` | converted GLM-5.3-Flash-NVFP4 overlay root; the same absolute host/container path is used during conversion and serving |
| `DRAFTER_PATH` | `${modelRoot}/incoai--GLM-5.3-Flash-DFlash2` | DFlash2 drafter checkpoint |
| `SERVED_MODEL_NAME` | `glm-5.3-flash-atlas` | client-visible gateway model ID |
| `SPARKGLM_GPU_MEMORY_UTILIZATION` | `0.93` | share of each Spark's unified memory for the engine; 0.93 assumes Sparks dedicated to this model (lower it if the node also runs other workloads) |
| `SPARKGLM_PREFIX_CACHE_GB` | `${prefixCacheGb}` (model setting, default `48`) | prefix cache on disk: `0` is off; 16-100 is its size in GiB per node (below) |
| `ATLAS_WORLD_SIZE`, `ATLAS_TP_SIZE`, `ATLAS_EP_SIZE` | `2` | two-node tensor/expert parallelism |
| `NCCL_*` | see recipe | IB transport, `NCCL_IB_HCA=rocep1s0f0`, `AF_INET`, `NCCL_CROSS_NIC=0` |

Ports are private and loopback-bound on each node: leader `127.0.0.1:8893`,
worker `127.0.0.1:8894`. With `--network host` the leader's port is what LLooM
uses for health and routing; the worker is readiness-checked through its
container state. The original checkpoint is also mounted read-only at the same
absolute path used by conversion so absolute symlinks in the overlay remain
valid at runtime.

## Prefix cache on disk (on, 48 GiB per node)

With the model setting `prefixCacheGb` at 16-100 (the recipe sets 48; `0` turns it off), each node writes prefix-cache
entries that fall out of the KV pool to `${installRoot}/atlas-prefix-cache`
(mounted at `/prefix-cache`) instead of dropping them, and reads them back
when the conversation returns. `serve.py` in the image splits the size evenly
between KV records and recurrent-state snapshots and sets the engine's tier
variables identically on both ranks; the recipe passes no `ATLAS_*` tier
variable itself. What it measured and what it costs (about 60K tokens of KV
pool at the default 48 GiB) are in Enntity/sparkglm's README under "Prefix
cache on disk".

- It needs an image from a SparkGLM revision whose `serve.py` reads
  `SPARKGLM_PREFIX_CACHE_GB` (the image pinned above does).
- The directory must be on the node's own disk (ext4/xfs), with the size free.
  The engine refuses tmpfs, ramfs, overlayfs, an unwritable directory, a disk
  that cannot hold the KV half, and ranks whose settings differ. To use
  another disk, make `${installRoot}/atlas-prefix-cache` a symlink to a
  directory there before setup.
- Nothing is kept across restarts; the engine deletes its files while they
  are open and clears leftovers of a crash at startup.

## Distributed startup

The worker starts first (`order` 10, rank 1) and the leader second (`order` 20,
rank 0). The worker uses `healthStrategy: "container"` and no warmup; the leader
uses `/health` plus a POST warmup, then owns routing.

## Memory policy for the long-context candidate

On each Spark, preview `lloom runtime-policy --max-memory-utilization 0.97
--reserve-memory-gb 4`, then repeat with `--apply --yes` to apply those explicit
candidate limits. Keep normal memory enforcement enabled. The command preserves
mode and node overrides; review its output before starting the model. These
values still require live qualification through LLooM: the profile's
524288-token context, four concurrent full-length windows, and 128K
generated-output endurance have not been qualified on this lane yet.

## Credits and licenses

LLooM's files in this directory and the recipe are MIT. The engine they start
is not part of LLooM:

- **Engine.** [Atlas](https://github.com/Atlas-Inf/atlas) (Atlas-Inf), with
  SparkGLM's GLM-5.3 Flash work on the
  [Enntity/atlas](https://github.com/Enntity/atlas) fork, licensed
  **AGPL-3.0-only**. It runs from a separate container image,
  `ghcr.io/enntity/atlas-sparkglm`, alongside LLooM (an aggregate); no engine
  source or binary is included in LLooM.
- **Corresponding source.** [Enntity/sparkglm](https://github.com/Enntity/sparkglm)
  at the pinned revision (`e58cdc23`) plus the Enntity/atlas commit recorded
  in the image's `/opt/atlas/source-manifest.json`
  ([`08c90d8e`](https://github.com/Enntity/atlas/tree/08c90d8e88f5c7db4e4542e26cddb9b3001fac5c)).
  SparkGLM's `NOTICE` and `docs/LICENSING.md` list everything else it fetches.
- **Third-party notices in the image.** FlashKDA (MoonshotAI, MIT), FlashInfer
  including NVIDIA's sparse-MLA prefill source (Apache-2.0) and CUTLASS
  (BSD-3-Clause) ship their notices under `/opt/atlas/notices/`; the engine's
  license is at `/LICENSE`.
- **Converter kernel.** The NVFP4 quantization kernel in
  `libatlas_mtp_quantize.so`, which setup step `convert-atlas-overlay` runs, is
  copied unchanged from [Mango-kid/atlas](https://github.com/Mango-kid/atlas)
  (AGPL-3.0-only).
- **Transport tuning.** The RoCE/NCCL transport tuning in the recipe (IB
  timeout/retry, Ring/Simple, 1-2 channels, 32 MiB buffers, DMA-BUF off)
  follows Atlas upstream's GB10 launch scripts (Atlas-Inf/atlas
  `scripts/start-ep2.sh`, `scripts/start-deepseek-ep2.sh`; Thomas Braun, Nick
  Gerakines et al.).
- **Models.** Weights are downloaded from their publishers, not distributed by
  LLooM. `nvidia/GLM-5.3-Flash-NVFP4` is MIT per SparkGLM's
  `docs/LICENSING.md`; `incoai/GLM-5.3-Flash-DFlash2` is **CC BY-NC-ND 4.0
  (non-commercial)**. Read each model card before use.
