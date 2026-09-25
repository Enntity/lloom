# Atlas SparkGLM under LLooM

LLooM-managed two-node Atlas SparkGLM candidate for a directly connected pair
of NVIDIA DGX Spark systems. This directory is **MIT orchestration only**: no
Atlas engine source is committed here. The engine is compiled from immutable
revision `f8a3603aebf22ff2cff91383fbdf99b930afe2bf` of `Enntity/sparkglm` by
that repository's `research/atlas/install/build.sh`. Live hardware and full
serving qualification remain pending.

## Layout

- `pins.json` — the single portable pin manifest for the candidate. It carries
  the immutable source and model revisions plus the image tag and conversion
  marker contract. Image identity is host-local and lives in each build
  receipt.
- `verify-pins.mjs` — fail-closed pin gate. Exits non-zero while the manifest
  is not final, the source revision is not a 40-character commit, or any
  portable identity is a placeholder. It deliberately rejects a global image
  ID because source builds produce host-local image IDs.
- `install.sh` — clones `Enntity/sparkglm` at the exact pinned revision,
  verifies `HEAD`, delegates compilation to `research/atlas/install/build.sh`,
  then verifies that `lloom/atlas-sparkglm:<SOURCE_REVISION>` resolves to this
  host's build receipt, arm64 inspection and OCI revision label.
- `convert-overlay.sh` — explicit, once-per-node NVFP4 overlay conversion gate.

## Fail-closed pin policy

The checked-in manifest carries final portable identities for this source-built
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
2. `check-atlas-pins` — the final immutable pin gate above.
3. `download-atlas-model` — acquires `nvidia/GLM-5.3-Flash-NVFP4` at its exact
   40-character revision into the managed model root and records the LLooM
   acquisition manifest.
4. `build-atlas-image` — `bash backends/atlas-sparkglm/install.sh` with the
   managed backend and install roots.
5. `convert-atlas-overlay` — runs the GPU conversion once with at least 8 GiB
   free and then runs the full CPU verification pass. It never stops a serving
   container implicitly. On GB10, unavailable GPU-memory readings fall back to
   Linux `MemAvailable`. Forced reconversion moves the prior overlay to a dated
   backup so it remains recoverable.

## Container contract

The image ships its own engine profile and entrypoint. LLooM supplies
environment and mounts only; it does not pass per-flag engine arguments.

Inside the image:

- `/opt/atlas/serve.py` — entrypoint. Reads the environment below, then starts
  the engine with the profile's argument vector.
- `/opt/atlas/profile.json` — the exact reconstructed engine environment
  profile (`--max-seq-len=36864`, `--max-prefill-tokens=4096`,
  `--max-num-seqs=4`, `--max-batch-size=4`, `--gpu-memory-utilization=0.921`,
  `--oom-guard-mb=4096`, `--kv-cache-dtype=bf16`, `--ssm-h-dtype=f32`,
  `--speculative --num-drafts=2`, `--block-size=16`, and the rest of the
  measured baseline). The profile keeps native MTP through 32768 and uses its
  fallback above that boundary. `disable-tool-grammar` is deliberately **not**
  set, so structured output and tool grammar stay functional. The source build
  includes image and video input support; live gateway qualification remains
  pending.

Environment contract consumed by `/opt/atlas/serve.py`:

| Variable | Source | Meaning |
| --- | --- | --- |
| `NODE_RANK` | `${nodeRank}` | distributed rank; `0` on the leader, `1` on the worker |
| `MASTER_ADDR` | `${leaderAddress}` | discovered direct-fabric address of the leader |
| `MASTER_PORT` | `29510` | distributed rendezvous port |
| `FABRIC_INTERFACE` | `${fabricInterface}` | discovered direct-fabric NIC, also used for `NCCL_SOCKET_IFNAME` |
| `FABRIC_HCA` | `rocep1s0f0` | RoCE HCA, defaulted by the image and pinned by the recipe |
| `MODEL_PATH` | `${installRoot}/atlas-overlay` | converted GLM-5.3-Flash-NVFP4 overlay root; the same absolute host/container path is used during conversion and serving |
| `SERVED_MODEL_NAME` | `glm-5.3-flash-atlas` | client-visible gateway model ID |
| `ATLAS_WORLD_SIZE`, `ATLAS_TP_SIZE`, `ATLAS_EP_SIZE` | `2` | two-node tensor/expert parallelism |
| `NCCL_*` | see recipe | IB transport, `NCCL_IB_HCA=rocep1s0f0`, `AF_INET`, `NCCL_CROSS_NIC=0` |

Ports are private and loopback-bound on each node: leader `127.0.0.1:8893`,
worker `127.0.0.1:8894`. With `--network host` the leader's port is what LLooM
uses for health and routing; the worker is readiness-checked through its
container state. The original checkpoint is also mounted read-only at the same
absolute path used by conversion so absolute symlinks in the overlay remain
valid at runtime.

## Distributed startup

The worker starts first (`order` 10, rank 1) and the leader second (`order` 20,
rank 0). The worker uses `healthStrategy: "container"` and no warmup; the leader
uses `/health` plus a POST warmup, then owns routing.
