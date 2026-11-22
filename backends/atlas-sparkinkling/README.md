# Atlas SparkInkling under LLooM

LLooM-managed SparkInkling 0.4.0 lane: Thinking Machines'
[Inkling 2 Mini](https://huggingface.co/thinkingmachines/Inkling-2-Mini) on one
NVIDIA DGX Spark, served by the Atlas engine with the checkpoint's own DSpark
drafter, prefix caching, reasoning and tool calls. Text input only (the engine
target has no vision tower). This directory is **MIT orchestration only**: no
Atlas engine source is committed here. The engine image is built from
`Enntity/sparkinkling` revision `76ed675d069484cc0a46007ea71f633b45235665`
(install tree `646b6c9dafe6`) by that repository's `install/build.sh` and
published as `ghcr.io/enntity/atlas-sparkinkling:646b6c9dafe6`. The recipe is
`linux-nvidia-dgx-spark-inkling2-mini-atlas`.

## Layout

- `pins-0.4.0.json`: the pin manifest. SparkInkling source revision and its
  `install/` git tree, the engine commit (`Enntity/atlas`
  `inkling2/mini-20261121` at `f0f0a2c78b53`), the image by GHCR manifest
  digest with the tag kept as metadata, the install-tree label, the checkpoint
  and overlay revisions, and `prepareTool`: the sha256 of the four SparkInkling
  install files `prepare.sh` runs.
- `verify-pins.mjs`: fail-closed pin gate. Exits non-zero while the manifest is
  not `final`, any identity is missing or a DRAFT/TODO placeholder, a revision,
  tree or commit is not a 40-character git object id, the tag is not
  `ghcr.io/enntity/atlas-sparkinkling:` plus the first 12 characters of the
  install tree, `image.reference` is not a digest reference in that repository,
  an image ID is pinned, the checkpoint or overlay leaves its pinned revision,
  or a `prepareTool` digest is missing.
- `install.sh`: prepares the image. It reuses an already verified local image,
  otherwise pulls the immutable digest; it never pulls the mutable tag and
  never builds. The image must be arm64 with
  `io.enntity.sparkinkling.install-tree` equal to the pinned tree and must ship
  `/opt/atlas/serve.py`, `/opt/atlas/profiles/default.json` and the pinned
  engine commit in `/opt/atlas/source-manifest.json`. `--check-only` verifies
  without pulling.
- `prepare.sh --manifest <pins> --model-root <dir> --weights strict|spark`:
  fetches `install/checkpoint.json`, `check_files.py`, `dspark_drafter.py` and
  `spark_overlay.py` from `Enntity/sparkinkling` at the pinned revision, refuses
  any whose sha256 differs from `prepareTool`, and runs them in the pinned image
  with no network, as the calling user, with the model root mounted at its own
  path. It checks the checkpoint's weight and tokenizer files against their
  pinned sha256 and assembles `thinkingmachines--Inkling-2-Mini+dspark` (the
  drafter directory: a relative link to the checkpoint's `mtp.safetensors` and
  its config). With `spark` it also checks the overlay and assembles
  `thinkingmachines--Inkling-2-Mini+spark-nvfp4` (the checkpoint's files linked
  and the overlay mapped in). Both directories are rebuilt only when their
  revisions change.

## Weights

| `--weights`        | Serves                                                                                                                                                     | Extra download                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `strict` (default) | The checkpoint as shipped: NVFP4 experts in layers 0-19, MXFP8 in 20-23, BF16 attention, router and vocabulary head                                        | none                                         |
| `spark`            | Strict plus calibrated NVFP4 attention projections, vocabulary head and layer 20-23 experts; next-token KL 0.0081 to Strict on 224 documents (97.0% top-1) | `Enntity/Inkling-2-Mini-Spark-NVFP4`, 2.9 GB |

## Modes

| Mode                | Profile   | Requests x tokens | GPU memory utilization | Reserved |
| ------------------- | --------- | ----------------- | ---------------------- | -------- |
| `saver`             | `saver`   | 8 x 131,072       | 0.50                   | 66 GB    |
| `default` (default) | `default` | 8 x 131,072       | 0.80                   | 104 GB   |
| `max`               | `max`     | 32 x 262,144      | 0.85                   | 110 GB   |

The profiles in the image own the utilization; the reservations are estimates
(peak host memory per mode was not measured).

## Installation

```sh
lloom setup --recipe linux-nvidia-dgx-spark-inkling2-mini-atlas --additive --apply --yes
lloom setup --recipe linux-nvidia-dgx-spark-inkling2-mini-atlas --weights spark --mode max --additive --apply --yes
```

The recipe is additive: it sets no default model and adds no aliases. Setup
steps, in order: `check-docker`, `verify-atlas-pins`, `download-atlas-model`,
`download-atlas-overlay` (spark only; sha256-checked, with the overlay's
README kept for attribution), `pull-atlas-image` (`install.sh`),
`prepare-atlas-model` (`prepare.sh`) and `prepare-atlas-cuda-cache`
(`${installRoot}/atlas-sparkinkling-cuda-cache`, mounted at `/atlas-cuda-cache`).

While the GHCR package `ghcr.io/enntity/atlas-sparkinkling` is private, the
pull needs `docker login ghcr.io` with a token that can read it.

## Container contract

LLooM mirrors SparkInkling 0.4.0's `start.sh`: host network and IPC, 16 GiB
shm, `--memory 114g` (a GB10 that runs out of shared memory hangs instead of
killing a process), all GPUs, `no-new-privileges`, a 60 s stop timeout, every
model directory mounted read-only at its own path, and the CUDA cache.
Environment: `MODEL_PATH` (the checkpoint, or its `+spark-nvfp4` directory),
`SPARKINKLING_MODE` (`strict` or `spark`), `SPARKINKLING_DRAFTER=dspark`,
`DRAFTER_PATH`, `SPARKINKLING_PROFILE` (the mode's profile),
`SERVED_MODEL_NAME=inkling-2-mini-atlas`, the tool-call guard
(`SPARKINKLING_TOOL_GUARD=on`, `_MAX_BYTES=1048576`, empty allow and deny
lists), offline Hugging Face and the CUDA cache settings. The engine serves
`127.0.0.1:8895`, fixed by the image. The disk tier for evicted prefix-cache KV
(`PREFIX_CACHE_DIR` in `start.sh`) is not enabled by this recipe.

## Credits and licenses

LLooM's files in this directory and the recipe are MIT. What they start is not
part of LLooM:

- **Engine.** [Atlas](https://github.com/Atlas-Inf/atlas) on the
  [Enntity/atlas](https://github.com/Enntity/atlas) fork (upstream PR
  Atlas-Inf/atlas#401), and SparkInkling's install tools, licensed
  **AGPL-3.0-only**. They run from a separate container image alongside LLooM
  (an aggregate); `prepare.sh` fetches the tools at a pinned, digest-checked
  revision and runs them in that image. No engine source or binary is included
  in LLooM. Corresponding source: `Enntity/sparkinkling` at the pinned revision
  plus the engine commit recorded in the image's
  `/opt/atlas/source-manifest.json`.
- **Weights.** Downloaded from their publishers, not distributed by LLooM.
  `thinkingmachines/Inkling-2-Mini` and `Enntity/Inkling-2-Mini-Spark-NVFP4`
  are Apache-2.0.
