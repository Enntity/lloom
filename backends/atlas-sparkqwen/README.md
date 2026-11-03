# Atlas SparkQwen under LLooM

LLooM-managed two-node SparkQwen 0.4.0 lane for a directly connected pair of
NVIDIA DGX Spark systems, serving `nvidia/Qwen3.8-Flash-Next-FP4-Local` as
published (no overlay conversion, no separate drafter: speculation uses the
checkpoint's own MTP head) in SparkQwen's Spark mode. This directory is **MIT
orchestration only**: no Atlas engine source is committed here. The engine
image is built from `Enntity/sparkqwen` tag `v0.4.0` (revision
`70c6c8453724b6541ca027b985229c58271e7a96`, install tree `3e0d9e7e4b29`) by
that repository's `install/build.sh` and published as
`ghcr.io/enntity/atlas-sparkqwen:3e0d9e7e4b29` (also `:0.4.0`). The engine
inside the image is AGPL-3.0-only; see [Credits and licenses](#credits-and-licenses).

## Image digest

`pins.json` addresses `ghcr.io/enntity/atlas-sparkqwen@sha256:939277f01cfc9fd529876d3db8675143d19d781f1b331f8e6fc67f348838bd05`,
the GHCR manifest digest the 0.4.0 release records. Both recipe members use the
same reference as `bootstrap.image`.

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
  `nvidia/Qwen3.8-Flash-Next-FP4-Local@b9ce18a6887e18c089fdea8509a33e63429a3300`.
- `install.sh` — prepares the image: reuses an already verified local image,
  otherwise pulls the immutable digest. It never pulls the mutable tag and
  never builds; a failed pull or check is a hard failure. The image must be
  arm64 with `io.enntity.sparkqwen.install-tree` equal to the pinned tree and
  must ship `/opt/atlas/serve.py`, `/opt/atlas/profiles/8x262k.json` and the
  pinned engine commit in `/opt/atlas/source-manifest.json`. `--check-only`
  verifies without pulling.

## Modes

| Mode                  | Profile        | GPU memory utilization | Reserved per Spark | Use                                                        |
| --------------------- | -------------- | ---------------------- | ------------------ | ---------------------------------------------------------- |
| `dedicated` (default) | `8x262k`       | 0.88                   | 114 GB             | The pair serves Qwen alone                                 |
| `sidecars`            | `saver-8x262k` | 0.74, display carveout | 96 GB              | Leaves memory for other admitted runtimes on the same pair |

Both modes serve eight requests of up to 262,144 tokens from one BF16 KV pool;
the sidecars pool is smaller (SparkQwen's README measured 1.85–1.98M tokens).
The profiles in the image own the utilization; LLooM's reservation matches it,
so admission can place sidecars such as embedding or image generation next to
the sidecars mode and not next to the dedicated one.

## Installation

```sh
lloom setup --recipe linux-nvidia-dgx-spark-2x-qwen38-flash-next-atlas --additive --apply --yes
lloom setup --recipe linux-nvidia-dgx-spark-2x-qwen38-flash-next-atlas --mode sidecars --additive --apply --yes
lloom resume qwen3.8-flash-next-atlas --apply --yes
```

The recipe is additive: it sets no default model and adds no aliases. Setup
keeps the installed mode when it runs again without `--mode`. Setup steps, in
order: `check-docker`, `verify-atlas-pins`, `download-atlas-model` (the pinned
checkpoint, about 95 GiB, into `${modelRoot}/nvidia--Qwen3.8-Flash-Next-FP4-Local`),
`pull-atlas-image` (`install.sh`), and `prepare-atlas-cuda-cache` (creates
`${installRoot}/atlas-sparkqwen-cuda-cache` and `${installRoot}/atlas-sparkqwen-ple`,
mounted at `/atlas-cuda-cache` and `/atlas-ple` so compiled CUDA kernels and the
checkpoint's PLE tables survive container recreation).

## Container contract

The image ships its own entrypoint and profiles; LLooM supplies environment and
mounts only, mirroring SparkQwen 0.4.0's `install/start-node.sh`: host network
and IPC, 32 GiB shm, `--memory 114g`, all GPUs, `/dev/infiniband`, `IPC_LOCK`
and `SYS_NICE`, unlimited memlock, `no-new-privileges`, a 60 s stop timeout,
the checkpoint mounted read-only at the same absolute path, the CUDA and PLE
caches, and `/run/lock/sparkglm`, the display-carveout lock every Spark
product shares.

| Variable                                                            | Source                                              | Meaning                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `NODE_RANK`                                                         | `${nodeRank}`                                       | `0` on the leader, `1` on the worker                                         |
| `MASTER_ADDR`                                                       | `${leaderAddress}`                                  | the leader's direct-fabric address                                           |
| `MASTER_PORT`                                                       | `29510`                                             | distributed rendezvous port                                                  |
| `FABRIC_INTERFACE`                                                  | `${fabricInterface}`                                | the node's direct-fabric NIC, also `NCCL_SOCKET_IFNAME`/`GLOO_SOCKET_IFNAME` |
| `FABRIC_HCA`, `NCCL_IB_HCA`                                         | `${fabricHca}`                                      | the node's exact RoCE devices; `FABRIC_SIBLINGS=0` adds none                 |
| `MODEL_PATH`                                                        | `${modelRoot}/nvidia--Qwen3.8-Flash-Next-FP4-Local` | the checkpoint                                                               |
| `SERVED_MODEL_NAME`                                                 | `qwen3.8-flash-next-atlas`                          | gateway model ID                                                             |
| `SPARKQWEN_PROFILE`                                                 | the mode: `8x262k` or `saver-8x262k`                | `/opt/atlas/profiles/<profile>.json`                                         |
| `SPARKQWEN_MODE`                                                    | `spark`                                             | SparkQwen's Spark precision mode; both modes keep native MTP                 |
| `SPARKQWEN_TOOL_GUARD`, `_MAX_BYTES`, `_ALLOW_HOSTS`, `_DENY_HOSTS` | `on`, `1048576`, empty, empty                       | the default tool-call guard                                                  |

The profile sets every `ATLAS_*` and `NCCL_*` tuning value; `serve.py` drops
ambient `ATLAS_*` variables so the profile wins.

`${fabricHca}` and `${fabricInterface}` are materialized per node by LLooM from
the node's own config. Because recipes that consume `${fabricHca}` require exact,
node-local device names, LLooM expects `cluster.nodes.<id>.fabricHca` (a
comma-separated list of exact local RDMA device names, without spaces or `:port`
suffixes) and `cluster.nodes.<id>.fabricInterface` on every participating node;
it never guesses an HCA from the NIC name, since PCI naming and cabling differ by
host. Missing or malformed overrides stop recipe materialization with the node
and field named in the error.

Ports are fixed by the image's `serve.py` and loopback-bound: rank 0 serves
`127.0.0.1:8893` on the leader and rank 1 binds `127.0.0.1:8894` on the worker.
The leader's port is what LLooM health-checks and routes to; the worker is
readiness-checked through its container state. SparkGLM's lane uses the same
ports, so the two lanes cannot run on the same pair at once.

## Distributed startup

The worker starts first (`order` 10, rank 1, `healthStrategy: "container"`, no
warmup); the leader starts second (`order` 20, rank 0), health-checks
`/health`, runs a POST warmup and owns routing. The first start compiles CUDA
kernels into the cache; allow several minutes.

## Credits and licenses

LLooM's files in this directory and the recipe are MIT. The engine they start
is not part of LLooM:

- **Engine.** [Atlas](https://github.com/Atlas-Inf/atlas) (Atlas-Inf) with the
  shared Spark layer on the [Enntity/atlas](https://github.com/Enntity/atlas)
  fork, branch `spark-shared` at
  [`9b25f575`](https://github.com/Enntity/atlas/tree/9b25f57596d1ba05b75bdc5c62d22fb75e1736c0),
  licensed **AGPL-3.0-only**. It runs from a separate container image,
  `ghcr.io/enntity/atlas-sparkqwen`, alongside LLooM (an aggregate); no engine
  source or binary is included in LLooM.
- **Corresponding source.** [Enntity/sparkqwen](https://github.com/Enntity/sparkqwen)
  at `v0.4.0` plus the Enntity/atlas commit recorded in the image's
  `/opt/atlas/source-manifest.json`. SparkQwen's `NOTICE` and
  `docs/LICENSING.md` list everything else the build fetches; the image ships
  CUTLASS's license and the Rust crate notices under `/opt/atlas/notices/` and
  the engine's license at `/LICENSE`.
- **Model.** Weights are downloaded from their publisher, not distributed by
  LLooM. `nvidia/Qwen3.8-Flash-Next-FP4-Local` is under the **NVIDIA Open Model
  License** per its model card (SparkQwen `docs/LICENSING.md`); read the model
  card before use and before redistributing anything derived from it.
