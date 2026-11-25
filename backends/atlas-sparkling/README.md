# Atlas SparkLing under LLooM

LLooM-managed SparkLing 0.1.0 lane: inclusionAI's
[Ling-3.2-air](https://huggingface.co/inclusionAI/Ling-3.2-air) (124B MoE,
5.5B active, 262,144-token window) or
[LingSante-3.1-air-VL](https://huggingface.co/inclusionAI/LingSante-3.1-air-VL)
(the medical vision-language Ling, 131,072-token window) on one NVIDIA DGX
Spark, served by the Atlas engine with MTP drafting, prefix caching, reasoning,
tool calls and text, image and video input. This directory is **MIT
orchestration only**: no Atlas engine source is committed here. The engine
image is built from `Enntity/SparkLing` revision
`46afd596505480a370392f2dc88ea36644e519b7` (tag `v0.1.0`, install tree
`a66a1e6464f4`) by that repository's `install/build.sh` and published as
`ghcr.io/enntity/atlas-sparkling:a66a1e6464f4` (also `:0.1.0`; public).

Two recipes share this directory, one per model:

- `linux-nvidia-dgx-spark-ling32-air-atlas` serves `ling-3.2-air-atlas`.
- `linux-nvidia-dgx-spark-lingsante-air-vl-atlas` serves `lingsante-air-vl`.

They are separate recipes, not one recipe with a model option, because the
models have different gateway ids: an option that renamed the gateway model
would leave the previous model's route behind on a re-run. Both bind the
image's fixed port, so only one runs at a time; each reserves most of the
Spark's memory, so LLooM does not start one beside the other.

## Layout

- `pins-0.1.0.json`: the pin manifest. SparkLing source revision and its
  `install/` git tree, the engine (`Enntity/atlas` `ling/3.2-air` at
  `dc0035de5887`), the image by GHCR manifest digest with the tag kept as
  metadata, the install-tree label, the four checkpoints with the SparkLing pin
  file that checks each (and LingSante Spark's drafter donor), and
  `prepareTool`: the sha256 of the six SparkLing install files `prepare.sh`
  runs (`check_files.py`, `prepare_sante_draft.py` and the pin files
  `checkpoint.json`, `checkpoint-sante-air-vl.json`,
  `checkpoint-sante-nvfp4.json`, `checkpoint-sante-draft.json`).
- `verify-pins.mjs`: fail-closed pin gate. Exits non-zero while the manifest is
  not `final`, any identity is missing or a DRAFT/TODO placeholder, a revision,
  tree or commit is not a 40-character git object id, the tag is not
  `ghcr.io/enntity/atlas-sparkling:` plus the first 12 characters of the
  install tree, `image.reference` is not a digest reference in that repository,
  an image ID is pinned, a checkpoint leaves its pinned repository, revision or
  pin file, or a `prepareTool` digest is missing.
- `install.sh`: prepares the image. It reuses an already verified local image,
  otherwise pulls the immutable digest; it never pulls the mutable tag and
  never builds. The image must be arm64 with
  `io.enntity.sparkling.install-tree` equal to the pinned tree and must ship
  `/opt/atlas/serve.py`, `/opt/atlas/profiles/default.json` and the pinned
  engine commit in `/opt/atlas/source-manifest.json`. `--check-only` verifies
  without pulling.
- `prepare.sh --manifest <pins> --model-root <dir> --model ling-3.2-air|sante-air-vl --weights strict|spark`:
  fetches `install/check_files.py` and the model's pin file from
  `Enntity/SparkLing` at the pinned revision, refuses any whose sha256 differs
  from `prepareTool`, and runs `check_files.py <weights> <checkpoint> --manifest <pin file>`
  in the pinned image with no network, as the calling user, with the model
  root mounted at its own path. Every inference file is checked against its
  pinned size and hash. Ling needs nothing more: its MTP drafter is the
  checkpoint's own predictor. For LingSante Spark it also fetches
  `prepare_sante_draft.py` (with `checkpoint.json` and
  `checkpoint-sante-draft.json`, which it reads) and runs it as `start.sh`
  does for `DRAFTER=ling-mtp`: it checks the four donor files of
  `primitive-ai/Ling-3.2-air-NVFP4A16`, then builds
  `Enntity--LingSante-3.1-air-VL-NVFP4-ling-mtp-3a78e5850631`, the
  checkpoint's files hard-linked with Ling's predictor added, and checks that
  view against `checkpoint-sante-draft.json`. A view built from the same files
  is left as it is. The tool requires the donor directory to be named by its
  revision, so `prepare.sh` points `.sparkling-donor/<revision>` in the model
  root at LLooM's `primitive-ai--Ling-3.2-air-NVFP4A16`.

## Weights

| Recipe        | `--weights`       | Checkpoint                                                 | Download | Engine settings                                                     |
| ------------- | ----------------- | ---------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| Ling-3.2-air  | `spark` (default) | `primitive-ai/Ling-3.2-air-NVFP4A16` @ `3a78e585`           | ~78 GB   | NVFP4 prefill and decode, BF16 vocabulary head, MTP drafter         |
| Ling-3.2-air  | `strict`          | `inclusionAI/Ling-3.2-air` @ `ff099487` (dynamic FP8)       | ~129 GB  | checkpoint precision, published sampling and template, no drafting  |
| LingSante     | `spark` (default) | `Enntity/LingSante-3.1-air-VL-NVFP4` @ `27029357`           | ~76 GB + 5.6 GB donor | NVFP4 prefill and decode, Ling's borrowed MTP drafter (`ling-mtp`), `SPARKLING_QUANT=nvfp4` |
| LingSante     | `strict`          | `inclusionAI/LingSante-3.1-air-VL` @ `1f398c93` (BF16)      | ~250 GB  | checkpoint precision, no drafting                                   |

Strict pages experts from the checkpoint on disk to fit one Spark and is much
slower than Spark. SparkLing's optional NVFP4 MLP and vocabulary-head decode
paths and the publisher MXFP4 LingSante (`--quant publisher`) are not offered
here.

`primitive-ai--Ling-3.2-air-NVFP4A16` is both Ling's Spark checkpoint and
LingSante Spark's drafter donor (four of its files). Ling's download lists
every pinned file's size, so it completes a directory in which LingSante left
only those four.

## Modes

| Mode                | Profile   | Requests x tokens (Ling / LingSante) | GPU memory utilization | Reserved |
| ------------------- | --------- | ------------------------------------ | ---------------------- | -------- |
| `saver`             | `saver`   | 1 x 8,192                            | 0.70                   | 92 GB    |
| `default` (default) | `default` | 8 x 131,072                          | 0.80                   | 104 GB   |
| `max`               | `max`     | 16 x 262,144 / 16 x 131,072          | 0.88                   | 114 GB   |

The profiles in the image own the utilization and window (the engine caps
LingSante at its native 131,072 tokens); the KV pool is shared, so requests it
cannot hold yet wait. At Ling's 262,144 tokens the KV pool and the weights do
not fit together and experts page from disk: one stream decoded 6.2 tok/s at
0.88 against 54.9 at 131,072 (Enntity/SparkLing `results/2026-11-25`). The
reservations are estimates: peak host memory per mode was not measured.

## Release measurement

SparkLing 0.1.0 on one GB10, Spark weights, default profile and drafting
(Enntity/SparkLing `results/2026-11-25/README.md`); the image build ran 8,827
engine tests with 0 failures:

|                                              | Ling-3.2-air               | LingSante-3.1-air-VL       |
| -------------------------------------------- | -------------------------- | -------------------------- |
| Single stream, mean of eight prompts, tok/s  | 55.2                       | 53.9                       |
| Drafted text equal to plain decode           | 8 of 8                     | 8 of 8                     |
| Aggregate, 1 / 2 / 4 / 8 clients, tok/s      | 54.6 / 61.1 / 77.3 / 104.0 | 48.0 / 62.3 / 79.0 / 105.2 |
| Video clips, invoice and grid                | all read correctly         | all read correctly         |

## Installation

```sh
lloom setup --recipe linux-nvidia-dgx-spark-ling32-air-atlas --additive --apply --yes
lloom setup --recipe linux-nvidia-dgx-spark-ling32-air-atlas --weights strict --mode saver --additive --apply --yes
lloom setup --recipe linux-nvidia-dgx-spark-lingsante-air-vl-atlas --additive --apply --yes
```

The recipes are additive: they set no default model and add no aliases. Setup
steps, in order: `check-docker`, `verify-atlas-pins`, `download-atlas-model`
(the selected checkpoint at its pinned revision), `download-atlas-drafter-donor`
(LingSante spark only: the four donor files, sha256-checked), `pull-atlas-image`
(`install.sh`), `prepare-atlas-model` (`prepare.sh`) and
`prepare-atlas-cuda-cache` (`${installRoot}/atlas-sparkling-cuda-cache`,
mounted at `/atlas-cuda-cache`, shared by both recipes).

The GHCR package is public; the digest pulls without `docker login`.

## Container contract

LLooM mirrors SparkLing's `start.sh`: host network and IPC, `--memory 114g`
(a GB10 that runs out of shared memory hangs instead of killing a process),
`--gpus device=0`, `no-new-privileges`, and the checkpoint mounted read-only at
`/model` (for LingSante Spark, the borrowed-drafter view). LLooM adds `--restart no`, a 60 s stop timeout and the persistent
CUDA cache (the image's profiles set `CUDA_CACHE_PATH=/atlas-cuda-cache`;
`start.sh` leaves it inside the container). It does not add `start.sh`'s
`io.enntity.owner=SparkLing` label: LLooM owns the container. Environment:
`MODEL_PATH=/model`, `SERVED_MODEL_NAME` (`ling-3.2-air-atlas` or
`lingsante-air-vl`), `SPARKLING_MODEL` (`ling-3.2-air` or `sante-air-vl`),
`SPARKLING_MODE` (`spark` or `strict`), `SPARKLING_QUANT`,
`SPARKLING_DRAFTER`, `SPARKLING_PREFILL_PRECISION` and
`SPARKLING_DECODE_PRECISION` (the values in the weights table),
`SPARKLING_PROFILE` (the mode's profile), the tool-call guard
(`SPARKLING_TOOL_GUARD=stream`, `_MAX_BYTES=1048576`, empty allow and deny
lists) and `CUDA_CACHE_MAXSIZE`. The engine serves `127.0.0.1:8897`, fixed by
the image, with `/health`. The disk tier for evicted prefix-cache KV
(`PREFIX_CACHE_DIR` in `start.sh`) and the `GPU_MEMORY_UTILIZATION` override
are not used by these recipes.

Video input: `video_url` parts; animated GIF is decoded in-process, MP4 and
WebM through the image's ffmpeg (the profiles pass `--video-allow-ffmpeg`).

## Credits and licenses

LLooM's files in this directory and the recipes are MIT. What they start is not
part of LLooM:

- **Engine.** [Atlas](https://github.com/Atlas-Inf/atlas) on the
  [Enntity/atlas](https://github.com/Enntity/atlas) fork (upstream PR
  Atlas-Inf/atlas#411), and SparkLing's install tools, licensed
  **AGPL-3.0-only**. They run from a separate container image alongside LLooM
  (an aggregate); `prepare.sh` fetches the tools at a pinned, digest-checked
  revision and runs them in that image. No engine source or binary is included
  in LLooM. Corresponding source: `Enntity/SparkLing` at the pinned revision
  plus the engine commit recorded in the image's
  `/opt/atlas/source-manifest.json`.
- **Weights.** Downloaded from their publishers, not distributed by LLooM.
  `inclusionAI/Ling-3.2-air`, `inclusionAI/LingSante-3.1-air-VL`,
  `primitive-ai/Ling-3.2-air-NVFP4A16` and
  `Enntity/LingSante-3.1-air-VL-NVFP4` are MIT per their model cards.
