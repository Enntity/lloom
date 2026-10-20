# Atlas SparkQwen under LLooM

Maintenance release accepted with disclosed limits; full_quality_pass=false. Recipe integration and guarded production canaries are approved; persistent activation remains pending live evidence. Product `050743206a7fd921eaa5acf1cbe50653b9f155cc`, install tree `70890529ba64dede889814f99f21b3c9a981d9bc`, engine `63bebfa60d5086de9fc8cc07c21e5fbe38f3b742`. Immutable image `ghcr.io/enntity/atlas-sparkqwen@sha256:a0cebe89737898692964d3923477bef293a4ebde9dd32e27202697c54f763c9d`. Engine source reference `sparkqwen/fidelity-rc-20261019` is an annotated tag, not a new branch. Maintenance review: https://github.com/Enntity/sparkqwen/blob/050743206a7fd921eaa5acf1cbe50653b9f155cc/results/2026-10-20-fidelity-review/qualification.json (SHA256 d591b033b0c396a2b0222b6c63136bc323e1bb5b69a206eac3c7df942b24be8b). Publication acceptance SHA256 7e2e699de3e8d06cb4a6eb3a3df5add15c8aaf18172f0f299aa1a0628ea91de0; separate production disposition SHA256 7b626caea8a546f868854d5c07eeaed103f5bf0c4ba3048b0e2d16fa85ede346.

## Release limitations

- Full quality gate remains failed. This release does not establish numerical parity, universal speculative equivalence, a lossless recipe, or an all-quality-pass result.
- Canonical prompt NLL is 1.0659923317039264, a residual of +0.0404426398902944 against the observed A4 reference. The earlier native baseline was higher at 1.1216532930400633. These comparisons do not establish a cause.
- Needle recall is 59/60 versus the retained historical 60/60 result. One lookup failed at 163,290 prompt tokens. Speculative ON and OFF at concurrency 1 returned the same wrong decoded fields; the original concurrency-4 run and different cache histories limit this comparison.
- Automatic tool selection combined with strict JSON can choose an unrelated tool. The explicit tool_choice: none control returned the correct JSON.
- Performance is mixed, including slower Rig medians and concurrency-2/4/8 cells. The matrix has one invocation per cell; its concurrency-1 32K cell is slower. Four warm-conversation request bodies differ because earlier responses generate later history.
- Logit bias on the first prefill token remains an inherited unsupported contract.
- The oversized PNG probe establishes header admission only; it does not prove full pixel decoding.

LLooM materialization, direct/gateway canaries and reservation drain/resume are separate operational requirements. A gateway can retain its own cluster leader and routes while participating in another group's temporary TP4 chain. Keep the Qwen owner gateway active; worker-only deployment disables inference. This directory is MIT orchestration; the image's Atlas engine is AGPL-3.0-only.

The recipe mounts an image- and checkpoint-specific persistent packed PLE cache at `/atlas-ple` on each rank. The first start packs the table once; normal container recreation retains it. Existing research caches are left untouched.

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
(the pinned checkpoint into
`${modelRoot}/nvidia--Qwen3.8-Flash-Next-FP4-Local`), `pull-atlas-image`
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
| `MODEL_PATH`        | `${modelRoot}/nvidia--Qwen3.8-Flash-Next-FP4-Local` | the checkpoint                                                                                                                                                                                                               |
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
  LLooM. `nvidia/Qwen3.8-Flash-Next-FP4-Local` is under the **NVIDIA Open Model
  License** per its model card (SparkQwen `docs/LICENSING.md`); read the model
  card before use and before redistributing anything derived from it.
