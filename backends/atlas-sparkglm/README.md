# Atlas SparkGLM under LLooM

LLooM-managed two-node Atlas SparkGLM for a directly connected pair of NVIDIA
DGX Spark systems, pinned to the 2026-10-17 FP4-Local release. This directory
is **MIT orchestration only**: no Atlas engine source is committed here. The
engine image is built from immutable revision
`c28da418444e954323ee885ffc3954965794a679` of `Enntity/sparkglm` by that
repository's `install/build.sh`. The engine inside the image is AGPL-3.0-only;
see [Credits and licenses](#credits-and-licenses). It serves
`nvidia/GLM-5.3-Flash-FP4-Local` as published: the checkpoint ships its MTP
layer quantized, so there is no conversion step and no overlay. The release
image qualified on a DGX Spark pair (Enntity/sparkglm
`results/2026-10-17-fp4local`: prompt-logprob hash `25bc828eea3f`, tools 21/21,
ToolEvalBench 91) and serves in production with `SPARKGLM_PROFILE=4x1m`.

## Layout

- `pins.json` — the single portable pin manifest: the source revision and its
  `install/` git tree, the Enntity/atlas engine commit the image records, the
  immutable image manifest reference (`image.reference`) with the tag kept as
  source-build metadata and the install-tree contents label, and the model and
  drafter revisions.
- `pins-tp4.json` — the pin manifest of the four-Spark TP-4 chain lane
  (recipe `linux-nvidia-dgx-spark-4x-glm53-atlas-tp4`), in the same format.
  It is a **draft** until a TP-4 release image exists; see
  [Four-Spark TP-4 chain](#four-spark-tp-4-chain-draft).
- `verify-pins.mjs` — fail-closed pin gate. Exits non-zero while the manifest
  is not final, the source revision, install tree, engine commit or drafter
  revision is not a 40-character lowercase git object id, the model is not the
  pinned FP4-Local revision, `image.reference` is not
  `ghcr.io/enntity/atlas-sparkglm@sha256:` plus 64 lowercase hex characters,
  the source-build metadata tag is not `ghcr.io/enntity/atlas-sparkglm:` plus
  the first 12 characters of the install tree, or any portable identity is a
  placeholder. It rejects a pinned image ID: IDs differ between a pull and a
  local build. The immutable digest is the identity of the normal path; the
  install-tree label is a contents check, not an artifact identity.
- `install.sh` — prepares the image. The normal path reuses an already
  verified local image, otherwise pulls the immutable manifest digest
  `ghcr.io/enntity/atlas-sparkglm@sha256:0b91fd790afb2ee3aa5a7f39a0bc5a90db05751436ae7810e00f129c36ebbb7b`
  from GHCR. It never pulls the mutable tag, and a failed pinned digest pull is
  a hard failure with no silent source build. The explicit `--source-build`
  option instead clones `Enntity/sparkglm` at the pinned revision, checks that
  `HEAD` is the pinned revision and `HEAD:install` is the pinned tree, and runs
  `install/build.sh`, which must print the pinned tag. That build produces a
  **LOCAL tag** for an explicitly overridden local recipe; it does **not**
  satisfy the normal immutable recipe, which addresses `image.reference`. In
  every case the selected image must be arm64 with
  `io.enntity.sparkglm.install-tree` equal to the pinned tree and must ship the
  entrypoint, the selected profile and the pinned engine commit in
  `/opt/atlas/source-manifest.json`. `--check-only` verifies the local image
  without pulling or building; combined with `--source-build` it deliberately
  verifies the local source-build tag instead of the digest.

## Fail-closed pin policy

The checked-in manifest carries final portable identities for this release.
The gate still rejects temporary or malformed manifests before any model
acquisition, image pull or build, or serving step:

```sh
node backends/atlas-sparkglm/verify-pins.mjs
```

The recipe test exercises that failure path with an explicit temporary
placeholder manifest; the checked-in manifest verifies successfully.

## Installation

```sh
lloom setup --recipe linux-nvidia-dgx-spark-2x-glm53-atlas --additive --apply --yes
lloom runtime-start glm53-flash-atlas-cluster
```

The recipe is additive only. It does not set a default model and does not
overwrite aliases. Setup is the path that acquires the checkpoint and prepares
the image; the serving path only ever starts the **prepared** image. Nothing is
built while a runtime is starting.

Setup steps, in order:

1. `check-docker` — Docker must be present.
2. `verify-atlas-pins` — the final immutable pin gate above.
3. `download-atlas-model` — acquires `nvidia/GLM-5.3-Flash-FP4-Local` (about
   165 GiB) at its exact 40-character revision into
   `${modelRoot}/nvidia--GLM-5.3-Flash-FP4-Local` and records the LLooM
   acquisition manifest. Both members mount that directory read-only as
   `MODEL_PATH`; it is served as published.
4. `download-atlas-drafter` — acquires `incoai/GLM-5.3-Flash-DFlash2` at its
   pinned revision. The drafter's weights are licensed **CC BY-NC-ND 4.0
   (non-commercial)**; read its model card before use.
5. `build-atlas-image` — `bash backends/atlas-sparkglm/install.sh` with the
   managed backend and install roots: pull the immutable digest, then verify.
   A source build runs only with the explicit `--source-build` flag.
6. `prepare-atlas-prefix-cache` — creates `${installRoot}/atlas-prefix-cache`
   with `kv/` and `ssm/`, which both members mount at `/prefix-cache`. It stays
   empty unless the prefix cache on disk is turned on (below).

## Container contract

The image ships its own engine profile and entrypoint. LLooM supplies
environment and mounts only; it does not pass per-flag engine arguments.

Inside the image:

- `/opt/atlas/serve.py` — entrypoint. Reads the environment below, then starts
  the engine with the profile's argument vector.
- `/opt/atlas/profiles/4x1m.json` — the engine profile the recipe selects
  (`SPARKGLM_PROFILE=4x1m`; the image also ships `4x512k`, `serve.py`'s
  default, and `8x128k`), from `install/profiles/` in Enntity/sparkglm:
  `--kernel-target=glm-5.3-flash`,
  `--max-seq-len=1048576`, `--max-num-seqs=4`, `--max-batch-size=4`,
  `--gpu-memory-utilization=0.88` (the profile default; the recipe overrides it
  with `SPARKGLM_GPU_MEMORY_UTILIZATION=0.91`), `--oom-guard-mb=4096`, `--kv-cache-dtype=fp8_g128`,
  `--ssm-h-dtype=f32`, `--ssm-rollback-mode=records`, `--dflash --dflash-gamma=8`
  with the DFlash2 drafter, and the rest of the profile's settings. Four requests
  share one physical FP8-latent KV pool, split between the nodes by `SPARKGLM_KV_SHARD=1` (about 2.6M tokens at the recipe's 0.91 GPU memory utilization with the display carveout and the disk prefix cache, up to 1,048,576 per request with `SPARKGLM_PROFILE=4x1m`; it also holds the prefix cache, with 16 recurrent-state snapshot slots); it does not reserve
  four full windows. `disable-tool-grammar` is deliberately **not** set, so
  structured output and tool grammar stay functional. The engine is built from
  Enntity/atlas `sparkglm/atlas-20261017-fp4local` @ `b3b016ab` (recorded in
  the image's `/opt/atlas/source-manifest.json`, which `install.sh` checks);
  measured results are in Enntity/sparkglm `results/2026-10-17-fp4local/`.
- `/opt/atlas/converter/` — SparkGLM's overlay converter for the older
  `nvidia/GLM-5.3-Flash-NVFP4` checkpoint. This recipe never runs it.

Environment contract consumed by `/opt/atlas/serve.py`:

| Variable | Source | Meaning |
| --- | --- | --- |
| `NODE_RANK` | `${nodeRank}` | distributed rank; `0` on the leader, `1` on the worker |
| `MASTER_ADDR` | `${leaderAddress}` | discovered direct-fabric address of the leader |
| `MASTER_PORT` | `29510` | distributed rendezvous port |
| `FABRIC_INTERFACE` | `${fabricInterface}` | discovered direct-fabric NIC, also used for `NCCL_SOCKET_IFNAME` |
| `FABRIC_HCA` | `rocep1s0f0` | RoCE HCA, defaulted by the image and pinned by the recipe |
| `MODEL_PATH` | `${modelRoot}/nvidia--GLM-5.3-Flash-FP4-Local` | the acquired checkpoint, mounted read-only at the same absolute path and served as published |
| `DRAFTER_PATH` | `${modelRoot}/incoai--GLM-5.3-Flash-DFlash2` | DFlash2 drafter checkpoint |
| `SERVED_MODEL_NAME` | `glm-5.3-flash-atlas` | client-visible gateway model ID |
| `SPARKGLM_GPU_MEMORY_UTILIZATION` | `0.91` | share of each Spark's unified memory for the engine; 0.91 assumes Sparks dedicated to this model (lower it if the node also runs other workloads) |
| `SPARKGLM_KV_SHARD` | `1` | split the GLM latent KV between the two nodes (each stores half the blocks' latents): about 2.6M pool tokens at 0.91 with the display carveout and the disk prefix cache; the disk prefix cache runs beside it, and the outputs are bit-identical to the unsplit pool's |
| `SPARKGLM_PROFILE` | `4x1m` | the launch profile in the image: `4x1m` (four 1,048,576-token contexts sharing the pool), `4x512k` or `8x128k` |
| `SPARKGLM_PREFIX_CACHE_GB` | `${prefixCacheGb}` (model setting, default `48`) | prefix cache on disk: `0` is off; 16-100 is its size in GiB per node (below) |
| `ATLAS_WORLD_SIZE`, `ATLAS_TP_SIZE`, `ATLAS_EP_SIZE` | `2` | two-node tensor/expert parallelism |
| `NCCL_*` | see recipe | IB transport, `NCCL_IB_HCA=rocep1s0f0`, `AF_INET`, `NCCL_CROSS_NIC=0` |

Ports are private and loopback-bound on each node: leader `127.0.0.1:8893`,
worker `127.0.0.1:8894`. With `--network host` the leader's port is what LLooM
uses for health and routing; the worker is readiness-checked through its
container state.

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

## Display memory as KV cache (on)

The recipe sets `SPARKGLM_DISPLAY_CARVEOUT=1` on both members. Each DGX Spark's
firmware reserves 2 GiB for the display (`DISPLAY_FRM`), which Linux never sees;
the NVIDIA driver manages it as the display's memory pool, and a headless Spark's
display uses only a few MiB of it. The image starts the engine through
`spark display-carveout`, which asks the driver for the rest (about 2042 MiB),
GPU-cacheable, and lends it to whole per-layer latent KV pools, so the pool grows
with system memory unchanged. Because the driver hands it out, it never overlaps
the display's own memory and needs no extra container capability. The recipe
adds, on both members, a bind mount of `${installRoot}/atlas-carveout-lock`
(created by the prepare step, so it survives reboots) at `/run/lock/sparkglm`:
one process per host holds the carveout.

Any NVIDIA open kernel module from 580.76.05 on lends it; the engine checks what
the driver gives rather than its version, and serves without the carveout,
logging why, when it cannot get it. To roll back, set
`SPARKGLM_DISPLAY_CARVEOUT=0` (the mount is then
unused). It is SparkGLM-only (the Enntity/atlas fork's SparkGLM layer); details
and credits are in Enntity/sparkglm's README under "Display memory as KV cache".

## Distributed startup

The worker starts first (`order` 10, rank 1) and the leader second (`order` 20,
rank 0). The worker uses `healthStrategy: "container"` and no warmup; the leader
uses `/health` plus a POST warmup, then owns routing.

## Memory policy for the long-context profile

On each Spark, preview `lloom runtime-policy --max-memory-utilization 0.97
--reserve-memory-gb 4`, then repeat with `--apply --yes` to apply those explicit
limits. Keep normal memory enforcement enabled. The command preserves mode and
node overrides; review its output before starting the model. The release
receipts cover four concurrent ~204K-token sessions (12/12 retrieved); four
concurrent full 1048576-token windows and 128K generated-output endurance have
not been measured on this lane.

## Four-Spark TP-4 chain (draft)

`recipes/linux-nvidia-dgx-spark-4x-glm53-atlas-tp4.json` runs this image's
`4x1m-tp4` profile on four Sparks cabled as a daisy chain, as the separate
gateway model `glm-5.3-flash-atlas-tp4`. It reuses this directory's
`install.sh` and `verify-pins.mjs` with `--manifest pins-tp4.json`, and the
pair lane's model, drafter, container hardening, limits and mounts. Its
environment is what `serve.py` reads at four ranks: `NODE_RANK`,
`MASTER_ADDR`, `FABRIC_INTERFACE`, `FABRIC_LEFT_HCA` and `FABRIC_RIGHT_HCA`
from each node's `cluster.nodes[ID].fabricChain`, `FABRIC_SIBLINGS=0`,
`SPARKGLM_PROFILE=4x1m-tp4`, and no KV shard, display carveout or disk prefix
cache. `pins-tp4.json` carries `TODO-TP4-RC` placeholders with status `draft`,
which the gate refuses, so the lane cannot install until a TP-4 release image
is pinned; the steps to adopt one are in
[docs/recipes.md](../../docs/recipes.md#atlas-sparkglm-tp-4-chain).

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
  at the pinned revision (`c28da418`) plus the Enntity/atlas commit recorded
  in the image's `/opt/atlas/source-manifest.json`
  ([`b3b016ab`](https://github.com/Enntity/atlas/tree/b3b016ab7e91b73bea220b7280c9e9aa1a2cfb13)).
  SparkGLM's `NOTICE` and `docs/LICENSING.md` list everything else it fetches.
- **Third-party notices in the image.** FlashKDA (MoonshotAI, MIT), FlashInfer
  including NVIDIA's sparse-MLA prefill source (Apache-2.0) and CUTLASS
  (BSD-3-Clause) ship their notices under `/opt/atlas/notices/`; the engine's
  license is at `/LICENSE`.
- **Converter kernel.** The image still ships SparkGLM's NVFP4 overlay
  converter, whose quantization kernel in `libatlas_mtp_quantize.so` is copied
  unchanged from [Mango-kid/atlas](https://github.com/Mango-kid/atlas)
  (AGPL-3.0-only). This recipe never runs it.
- **Transport tuning.** The RoCE/NCCL transport tuning in the recipe (IB
  timeout/retry, Ring/Simple, 1-2 channels, 32 MiB buffers, DMA-BUF off)
  follows Atlas upstream's GB10 launch scripts (Atlas-Inf/atlas
  `scripts/start-ep2.sh`, `scripts/start-deepseek-ep2.sh`; Thomas Braun, Nick
  Gerakines et al.).
- **Models.** Weights are downloaded from their publishers, not distributed by
  LLooM. `nvidia/GLM-5.3-Flash-FP4-Local` is under the NVIDIA Open Model
  Agreement (the GLM-5.3-Flash base model is MIT) per SparkGLM's
  `docs/LICENSING.md`; `incoai/GLM-5.3-Flash-DFlash2` is **CC BY-NC-ND 4.0
  (non-commercial)**. Read each model card before use.
