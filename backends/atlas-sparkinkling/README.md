# Atlas SparkInkling under LLooM

LLooM-managed SparkInkling 0.5.1 lane: Thinking Machines'
[Inkling 2 Mini](https://huggingface.co/thinkingmachines/Inkling-2-Mini) on one
NVIDIA DGX Spark, served by the Atlas engine with incoai's DFlash2 drafter,
1,048,576-token requests (window-bounded KV), prefix caching, reasoning, tool
calls and image input (no video).
This directory is **MIT orchestration only**: no
Atlas engine source is committed here. The engine image is built from
`Enntity/sparkinkling` at the revision pinned in
`pins-0.5.1.json` (`main`, tag `v0.5.1`) by that repository's
`install/build.sh` and published as
`ghcr.io/enntity/atlas-sparkinkling:<install tree>` (also `:0.5.1`). The
recipe's `--weights` option defaults to `spark`. The recipe is
`linux-nvidia-dgx-spark-inkling2-mini-atlas`.

## Layout

- `pins-0.5.1.json`: the pin manifest (recipe version 5;
  `pins-0.5.0-a9fac42abe15.json`, `pins-0.5.0.json`, `pins-0.4.2.json` and
  `pins-0.4.1.json` stay for the archived versions 4, 3, 2 and 1).
  SparkInkling source revision and its `install/` git tree, the engine commit
  (`Enntity/atlas` `inkling2/rc-0.5.1-20261126` at `a4dbba37810f`, which
  carries an opt-in LoopCD the recipe leaves off), the image
  by GHCR manifest digest with the tag kept as metadata, the install-tree
  label, the checkpoint, overlay and DFlash2 drafter revisions, and
  `prepareTool`: the sha256 of the three SparkInkling install files
  `prepare.sh` runs.
- `verify-pins.mjs`: fail-closed pin gate. Exits non-zero while the manifest is
  not `final`, any identity is missing or a DRAFT/TODO placeholder, a revision,
  tree or commit is not a 40-character git object id, the tag is not
  `ghcr.io/enntity/atlas-sparkinkling:` plus the first 12 characters of the
  install tree, `image.reference` is not a digest reference in that repository,
  an image ID is pinned, the checkpoint, overlay or drafter leaves its pinned
  revision, or a `prepareTool` digest is missing (a manifest without a
  `dflash2` pin, the archived 0.4.x ones, also needs `dspark_drafter.py`'s).
- `install.sh`: prepares the image. It reuses an already verified local image,
  otherwise pulls the immutable digest; it never pulls the mutable tag and
  never builds. The image must be arm64 with
  `io.enntity.sparkinkling.install-tree` equal to the pinned tree and must ship
  `/opt/atlas/serve.py`, `/opt/atlas/profiles/default.json` and the pinned
  engine commit in `/opt/atlas/source-manifest.json`. `--check-only` verifies
  without pulling.
- `prepare.sh --manifest <pins> --model-root <dir> --weights strict|spark`:
  fetches `install/checkpoint.json`, `check_files.py` and `spark_overlay.py`
  from `Enntity/sparkinkling` at the pinned revision, refuses any whose sha256
  differs from `prepareTool`, and runs them in the pinned image with no
  network, as the calling user, with the model root mounted at its own path.
  It checks the checkpoint's weight and tokenizer files and the DFlash2
  drafter (`incoai--Inkling-2-Mini-DFlash2`, downloaded by the recipe) against
  their pinned sha256. With `spark` it also checks the overlay and assembles
  `thinkingmachines--Inkling-2-Mini+spark-nvfp4` (the checkpoint's files linked
  and the overlay mapped in), rebuilt only when a revision changes. For an
  archived 0.4.x manifest it assembles the DSpark drafter directory
  (`thinkingmachines--Inkling-2-Mini+dspark`) as before.

## Weights

| `--weights`       | Serves                                                                                                                                                     | Extra download                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `strict`          | The checkpoint as shipped: NVFP4 experts in layers 0-19, MXFP8 in 20-23, BF16 attention, router and vocabulary head                                        | none                                         |
| `spark` (default) | Strict plus calibrated NVFP4 attention projections, vocabulary head and layer 20-23 experts; next-token KL 0.0081 to Strict on 224 documents (97.0% top-1) | `Enntity/Inkling-2-Mini-Spark-NVFP4`, 2.9 GB |

## Modes

| Mode                | Profile   | Requests x tokens | GPU memory utilization | Reserved |
| ------------------- | --------- | ----------------- | ---------------------- | -------- |
| `saver`             | `saver`   | 8 x 786,432       | 0.50                   | 66 GB    |
| `default` (default) | `default` | 8 x 1,048,576     | 0.80                   | 104 GB   |
| `max`               | `max`     | 32 x 1,048,576    | 0.85                   | 110 GB   |

The profiles in the image own the utilization; the reservations are estimates
(peak host memory per mode was not measured).

## Installation

```sh
lloom setup --recipe linux-nvidia-dgx-spark-inkling2-mini-atlas --additive --apply --yes
lloom setup --recipe linux-nvidia-dgx-spark-inkling2-mini-atlas --weights spark --mode max --additive --apply --yes
```

The recipe is additive: it sets no default model and adds no aliases. Setup
steps, in order: `check-docker`, `verify-atlas-pins`, `download-atlas-model`,
`download-atlas-drafter` (incoai's DFlash2 drafter, about 1 GB, sha256-checked,
its README kept for attribution), `download-atlas-overlay` (spark only; sha256-checked, with the overlay's
README kept for attribution), `pull-atlas-image` (`install.sh`),
`prepare-atlas-model` (`prepare.sh`) and `prepare-atlas-cuda-cache`
(`${installRoot}/atlas-sparkinkling-cuda-cache`, mounted at `/atlas-cuda-cache`).

## Container contract

LLooM mirrors SparkInkling 0.5.1's `start.sh`: host network and IPC, 16 GiB
shm, `--memory 114g` (a GB10 that runs out of shared memory hangs instead of
killing a process), all GPUs, `no-new-privileges`, a 60 s stop timeout, every
model directory mounted read-only at its own path, and the CUDA cache.
Environment: `MODEL_PATH` (the checkpoint, or its `+spark-nvfp4` directory),
`SPARKINKLING_MODE` (`strict` or `spark`), `SPARKINKLING_DRAFTER=dflash2`,
`DRAFTER_PATH` (the drafter's directory), `SPARKINKLING_PROFILE` (the mode's profile),
`SERVED_MODEL_NAME=inkling-2-mini-atlas`, the tool-call guard
(`SPARKINKLING_TOOL_GUARD=stream`: a request that sends
`stream_tool_arguments: true` gets its calls' arguments as they are written
and the guard checks each call when it ends; every other request's calls are
held until they pass; `_MAX_BYTES=1048576`, empty allow and deny lists), offline Hugging Face and the CUDA cache settings. The engine serves
`127.0.0.1:8895`, fixed by the image. SparkInkling 0.5.x has no disk tier for evicted prefix-cache KV.

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
  `thinkingmachines/Inkling-2-Mini`, `Enntity/Inkling-2-Mini-Spark-NVFP4` and
  `incoai/Inkling-2-Mini-DFlash2` are Apache-2.0.
