# Atlas SparkQwen under LLooM

LLooM-managed two-node Atlas SparkQwen RC16 lane for a directly connected pair
of NVIDIA DGX Spark systems, serving `nvidia/Qwen3.8-Flash-Next-NVFP4` as
published (no overlay conversion, no separate drafter: speculation uses the
checkpoint's own MTP head). This directory is **MIT orchestration only**: no
Atlas engine source is committed here. The engine image is built from
`Enntity/sparkqwen` revision `85325e5104b2a6864e0cf31ec470a8c3327d4de4`
(install tree `656234c336af`) by that repository's `install/build.sh` and
published as `ghcr.io/enntity/atlas-sparkqwen:656234c336af`. The engine inside
the image is AGPL-3.0-only; see [Credits and licenses](#credits-and-licenses).
SparkQwen qualified RC16 on its own launcher; no live run through LLooM is
recorded yet.

## Image digest

`pins.json` addresses `ghcr.io/enntity/atlas-sparkqwen@sha256:c3ea9f85bab9ff3599000b1e96f594714f3851e0b468da8bf2d10232e237e09e`, the GHCR
manifest digest of tag `656234c336af` (recorded 2026-10-13 with
`docker buildx imagetools inspect`). Both recipe members use the same
reference as `bootstrap.image`.

## Layout

- `pins.json` — the single pin manifest: SparkQwen source revision and its
  `install/` git tree, the engine commit, the immutable image reference with
  the tag kept as metadata, the install-tree label, and the checkpoint revision.
- `verify-pins.mjs` — fail-closed pin gate. Exits non-zero while the manifest
  is not `final`, any identity is missing or a DRAFT/TODO placeholder, the
  revision, install tree or engine commit is not a 40-character git object id,
  the entrypoint or profile is not a plain path under `/opt/atlas`, the tag is not
  `ghcr.io/enntity/atlas-sparkqwen:` plus the first 12 characters of the install
  tree, `image.reference` is not `ghcr.io/enntity/atlas-sparkqwen@sha256:` plus
  64 lowercase hex characters, an image ID is pinned, or the model leaves
  `nvidia/Qwen3.8-Flash-Next-NVFP4@fc694b54fb0174e0913e6adf86691ef85a4ead47`.
- `install.sh` — prepares the image: reuses an already verified local image,
  otherwise pulls the immutable digest. It never pulls the mutable tag and
  never builds; a failed pull or check is a hard failure. The image must be
  arm64 with `io.enntity.sparkqwen.install-tree` equal to the pinned tree and
  must ship `/opt/atlas/serve.py`, `/opt/atlas/profiles/8x262k.json` and the
  pinned engine commit in `/opt/atlas/source-manifest.json`. `--check-only`
  verifies without pulling. For a local build, run `install/build.sh` from
  Enntity/sparkqwen at the pinned revision; that produces the tag, not the
  digest this recipe addresses.

## Installation

```sh
lloom setup --recipe linux-nvidia-dgx-spark-2x-qwen38-flash-next-atlas --additive --apply --yes
lloom runtime-start qwen38-flash-next-atlas-cluster
```

The recipe is additive: it sets no default model and adds no aliases. Setup
steps, in order: `check-docker`, `verify-atlas-pins`, `download-atlas-model`
(the pinned checkpoint, about 124 GiB, into
`${modelRoot}/nvidia--Qwen3.8-Flash-Next-NVFP4`), `pull-atlas-image`
(`install.sh`), and `prepare-atlas-cuda-cache` (creates
`${installRoot}/atlas-sparkqwen-cuda-cache`, mounted at `/atlas-cuda-cache` so
compiled CUDA kernels survive container recreation). Run setup on both nodes.

## Container contract

The image ships its own entrypoint and profiles; LLooM supplies environment and
mounts only, mirroring SparkQwen's reviewed `install/start-node.sh`: host
network and IPC, 32 GiB shm, `--memory 114g`, all GPUs, `/dev/infiniband`,
`IPC_LOCK` and `SYS_NICE`, unlimited memlock, `no-new-privileges`, a 60 s stop
timeout, the checkpoint mounted read-only at the same absolute path, and the
CUDA JIT cache.

| Variable            | Source                                          | Meaning                                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_RANK`         | `${nodeRank}`                                   | `0` on the leader, `1` on the worker                                                                                                                                                                                         |
| `MASTER_ADDR`       | `${leaderAddress}`                              | the leader's direct-fabric address                                                                                                                                                                                           |
| `MASTER_PORT`       | `29510`                                         | distributed rendezvous port                                                                                                                                                                                                  |
| `FABRIC_INTERFACE`  | `${fabricInterface}`                            | the node's direct-fabric NIC, also `NCCL_SOCKET_IFNAME`/`GLOO_SOCKET_IFNAME`                                                                                                                                                 |
| `FABRIC_HCA`        | `${fabricHca}`                                  | the node's RoCE device (below); `serve.py` adds the device behind the port's other PCIe half and sets `NCCL_IB_HCA` and `ATLAS_RDMA_RAILS` from both                                                                         |
| `MODEL_PATH`        | `${modelRoot}/nvidia--Qwen3.8-Flash-Next-NVFP4` | the checkpoint                                                                                                                                                                                                               |
| `SERVED_MODEL_NAME` | `qwen3.8-flash-next-atlas`                      | gateway model ID                                                                                                                                                                                                             |
| `SPARKQWEN_PROFILE` | `8x262k`                                        | `/opt/atlas/profiles/8x262k.json`: up to eight requests of up to 262,144 tokens from one shared BF16 KV pool (about 3.19M tokens at the profile's GPU memory utilization of 0.88); the image also ships `8x32k` and `4x262k` |
| `SPARKQWEN_FP8_GDN` | `0`                                             | the lossy FP8 Gated DeltaNet opt-in stays off                                                                                                                                                                                |

The profile sets every `ATLAS_*` and `NCCL_*` tuning value; `serve.py` drops
ambient `ATLAS_*` variables so the profile wins. To give the KV pool more of a
dedicated pair's memory, add `-e SPARKQWEN_GPU_MEMORY_UTILIZATION=0.80-0.95` to
both members in a local recipe override.

`${fabricHca}` and `${fabricInterface}` are materialized per node by LLooM from
the node's own config. Because recipes that consume `${fabricHca}` require exact,
node-local device names, LLooM expects `cluster.nodes.<id>.fabricHca` (a
comma-separated list of exact local RDMA device names, without spaces or `:port`
suffixes) and `cluster.nodes.<id>.fabricInterface` on every participating node;
it never guesses an HCA from the NIC name, since PCI naming and cabling differ by
host. A pair cabled on the second port therefore needs
`fabricHca: "rocep1s0f1"` and `fabricInterface: "enp1s0f1np1"` on both nodes.
Missing or malformed overrides stop recipe materialization with the node and
field named in the error.

Ports are fixed by the image's `serve.py` and loopback-bound: rank 0 serves
`127.0.0.1:8893` on the leader and rank 1 binds `127.0.0.1:8894` on the worker.
The leader's port is what LLooM health-checks and routes to; the worker is
readiness-checked through its container state. SparkGLM's lane uses the same
ports, so the two lanes cannot run on the same pair at once (neither fits
beside the other anyway).

## Distributed startup

The worker starts first (`order` 10, rank 1, `healthStrategy: "container"`, no
warmup); the leader starts second (`order` 20, rank 0), health-checks
`/health`, runs a POST warmup and owns routing. The first start compiles CUDA
kernels into the cache; allow several minutes.

## Credits and licenses

LLooM's files in this directory and the recipe are MIT. The engine they start
is not part of LLooM:

- **Engine.** [Atlas](https://github.com/Atlas-Inf/atlas) (Atlas-Inf) with
  SparkGLM's upstream series and SparkQwen's Qwen3.8-Flash-Next work on the
  [Enntity/atlas](https://github.com/Enntity/atlas) fork, branch
  `sparkqwen/atlas-20261010-rc16`, licensed **AGPL-3.0-only**. It runs from a
  separate container image, `ghcr.io/enntity/atlas-sparkqwen`, alongside LLooM
  (an aggregate); no engine source or binary is included in LLooM.
- **Corresponding source.** [Enntity/sparkqwen](https://github.com/Enntity/sparkqwen)
  at the pinned revision plus the Enntity/atlas commit recorded in the image's
  `/opt/atlas/source-manifest.json`
  ([`1c43247d`](https://github.com/Enntity/atlas/tree/1c43247d93ca050f02cb67b0603e88edfe3d92a5)).
  SparkQwen's `NOTICE` and `docs/LICENSING.md` list everything else the build
  fetches; the image ships CUTLASS's license and the Rust crate notices under
  `/opt/atlas/notices/` and the engine's license at `/LICENSE`.
- **Model.** Weights are downloaded from their publisher, not distributed by
  LLooM. `nvidia/Qwen3.8-Flash-Next-NVFP4` is under the **NVIDIA Open Model
  License** per its model card (SparkQwen `docs/LICENSING.md`); read the model
  card before use and before redistributing anything derived from it.
