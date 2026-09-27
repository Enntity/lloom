# Native LTX-2.5 video backend

`backends/ltx-pipelines` runs the **Lightricks LTX-2 pipelines natively**
(no ComfyUI graph in the loop) and exposes them through LLooM's existing video
endpoint. It is additive: nothing else in the repository changes behavior, and
the backend only activates when a recipe/config points at it.

- Upstream: <https://github.com/Lightricks/LTX-2>, version **1.3.0**, pinned
  commit `598ab41247a77dbfe29b5186e915bcf4f9040ec7`. A2V is a locally maintained copy of that revision with an explicit sampler selector. Other CLI flags come from that revision's argparse surface
  (`packages/ltx-pipelines/src/ltx_pipelines/utils/args.py` and the per-pipeline
  `main()` parsers).
- Two public gateway model IDs, `Lightricks/LTX-2.5-Full` and
  `Lightricks/LTX-2.5-Distilled`, select a fixed native module set. The
  `workflow` field chooses the pipeline; requests cannot name a module, script,
  or filesystem path.

## Gateway model IDs -> upstream pipeline

| Gateway model ID                | Workflow         | Upstream entry point                   | Notes                                              |
| ------------------------------- | ---------------- | -------------------------------------- | -------------------------------------------------- |
| `Lightricks/LTX-2.5-Full`       | `generate`       | `ltx_pipelines.ti2vid_two_stages`      | Guided two-stage, dev transformer + distilled LoRA (default) |
| `Lightricks/LTX-2.5-Full`       | `generate-hq`    | `ltx_pipelines.ti2vid_two_stages_hq`   | `res_2s` schedule, stage-1/stage-2 LoRA strengths  |
| `Lightricks/LTX-2.5-Full`       | `audio-to-video` | `a2v` (LLooM adaptation)               | Euler ancestral A2V; source audio unchanged        |
| `Lightricks/LTX-2.5-Full`       | `keyframes`      | `ltx_pipelines.keyframe_interpolation` | Native keyframe interpolation                      |
| `Lightricks/LTX-2.5-Distilled`  | `generate`       | `ltx_pipelines.distilled`              | Native BF16 fast schedule (no guidance/steps, default) |
| `Lightricks/LTX-2.5-Distilled`  | `retake`         | `ltx_pipelines.retake`                 | Regenerate a source-video interval                 |
| `Lightricks/LTX-2.5-Distilled`  | `refine`         | `ltx_pipelines.dfr_pipeline`           | Production detailing with the pixel-spatial IC-LoRA |

Both models share **one managed runtime** and generate **sequentially** (single
flight). This is intentional: a Dev run holds a 22B transformer plus the Gemma
text encoder resident, so two at once would not fit and would risk the host.

## Cost model: lazy, not keep-warm

`/health` reports `"lazy_load": true` and `"keep_warm": false`. Every request
spawns one CLI subprocess that loads weights, generates, writes the MP4, and
exits. That is more expensive per call than a resident server, but the process
exit is what guarantees unified memory is actually released before the next
request is admitted. There is no warm pool and no residency claim.

## Endpoints

- `GET /health` — status, upstream version/commit, single-flight busy flag.
- `GET /v1/models` — the two model IDs above.
- `POST /v1/videos/generations` — **request body ceiling 64 MiB**. Success
  response matches the existing LLooM contract:

  ```json
  { "created": 1700000000, "model": "Lightricks/LTX-2.5-Full", "workflow": "audio-to-video", "data": [{ "b64_json": "<base64 mp4>", "mime_type": "video/mp4" }] }
  ```

  Errors use `{"error": {"message", "type", "code"}}` with a matching HTTP
  status (400 validation, 404 unknown model, 409 runtime busy, 413 over a
  ceiling, 502 upstream failure, 504 timeout, 499 client disconnect).

## Request schema

| Field                                                             | Meaning                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                                                           | Required; one of the two public gateway IDs.                                                                                                                                                                                |
| `workflow`                                                        | Optional selector: `Lightricks/LTX-2.5-Full` accepts `generate` (default), `generate-hq`, `audio-to-video`, `keyframes`; `Lightricks/LTX-2.5-Distilled` accepts `generate` (default), `retake`, `refine`. Must be a supported non-empty string: `null`, arrays, and other-family names are rejected. Never inferred from `audio`/`video`. |
| `prompt`                                                          | Required text or structured object; see [video workflows](video-workflows.md).                                                                                                                                              |
| `video`, `start_time`, `end_time`                                 | Distilled `retake` only; inline MP4 and edit interval in seconds. Source timing/geometry are preserved.                                                                                                                     |
| `negative_prompt`                                                 | All Full workflows; rejected by Distilled workflows.                                                                                                                                                               |
| `image`                                                           | Inline PNG/JPEG data URI; conditioned at **frame 0**.                                                                                                                                                                       |
| `image_strength`                                                  | Optional first-frame strength from 0 to 1; `audio-to-video` defaults to 0.7, other workflows to 1. Requires `image`; does not alter last-frame or interior keyframe strengths. Unsupported on `retake`. |
| `last_frame`                                                      | Inline PNG/JPEG data URI; conditioned at **frame `num_frames - 1`**.                                                                                                                                                        |
| `keyframes`                                                       | Optional list of `{image, frame, strength}` at interior indices; supported by all workflows except `retake`.                                                                                                                                 |
| `audio`                                                           | Inline WAV/FLAC data URI; **`audio-to-video` only**. `audio_start_time` shifts the read offset by 0–20 seconds.                                                                                                             |
| `width` / `height` / `size`                                       | `size` is `"WIDTHxHEIGHT"`. Defaults **832x512** for GB10.                                                                                                                                                                  |
| `duration` / `num_frames`                                         | See "frame count" below.                                                                                                                                                                                                    |
| `frame_rate` / `fps`                                              | `fps` aliases `frame_rate`; default 24.                                                                                                                                                                                     |
| `seed`, `steps`                                                   | `steps` only on guided video pipelines; Distilled `generate` and `refine` use a fixed schedule, and `retake` rejects `steps`.                                                                                               |
| `response_format`                                                 | `b64_json` (the only accepted value).                                                                                                                                                                                       |
| `sampler` | `audio-to-video` only: `euler_ancestral` (default) or `euler` for controlled comparisons. Applies to both stages; eta and noise strength are 1. |
| guidance (video)                                                  | `guidance_scale`, `stg_scale`, `rescale_scale`, `a2v_guidance_scale`, `video_skip_step` — all Full workflows. |
| guidance (audio)                                                  | `audio_guidance_scale`, `audio_stg_scale`, `audio_rescale_scale`, `v2a_guidance_scale`, `audio_skip_step` — Full `generate`, `generate-hq`, and `keyframes`; rejected by `audio-to-video` because supplied audio is frozen. |
| `generated_keyframes`                                             | Full `generate`, `generate-hq`, and Distilled `generate` only.                                                                                                                                                                                                      |
| `temporal_upscalings` / `spatial_upscalings`                      | Distilled `refine` only.                                                                                                                                                                                                    |
| `offload` (`none`/`cpu`/`disk`), `quantization`, `max_batch_size` | Runtime knobs passed through.                                                                                                                                                                                               |

Unknown fields are rejected rather than ignored, so a typo in a field name is
visible instead of silently changing the result.

### Frame count

`num_frames` must satisfy `num_frames = 8 * k + 1` (the temporal grid the model
was trained on). `duration` is converted to the nearest such count at the
requested frame rate. Supplying both `duration` and `num_frames` is an error, as
is supplying both `size` and `width`/`height`, or both `fps` and `frame_rate`.

### audio-to-video duration rule

The backend always emits an explicit `--num-frames`, including for requests
using `duration`. This keeps endpoint guides and returned frames on the same
8k+1 grid. `audio-to-video` duplicates mono into stereo and preserves the supplied speech samples; if they are shorter than
the requested frame grid, the adapter appends silence before inference. This
also supports a silent return-to-idle tail. Upstream trims the audio to the
requested duration and muxes it into MP4, so the compressed output is not
byte-identical to the input. No voice synthesis or replacement occurs in `audio-to-video`.

## Geometry ceilings

Explicit and modest by design for GB10 (128 GiB unified memory); callers cannot
widen them:

- `width`/`height`: 64–2048, multiples of 64.
- `width * height <= 1920 * 1088` (2,088,960 px, ~1080p-class two-stage canvas).
  An arbitrary 4096x4096 canvas is **not** admitted.
- `num_frames`: 9–481 (~20 s at 24 fps).
- `frame_rate`: 1–60; `duration`: 0.25–20 s.
- Inline image pixels `<= 4096 * 4096`; body `<= 64 MiB`.

Inline media is fully decoded with Pillow and libsndfile after bounded header
checks. Truncated images/audio, oversized images and excessive audio durations
are rejected.
A base64 blob that decodes but is not a real image/audio is rejected before any
process starts.

## Configuration

| Env var                     | Meaning                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `LLOOM_LTX_MODEL_ROOT`      | Root directory holding the split BF16 components (required at request time).                      |
| `LLOOM_LTX_RUNNER`          | Optional argv override for the pipeline launcher (used by tests). Default: `python3 -m <module>`. |
| `LLOOM_LTX_TIMEOUT_SECONDS` | Per-request wall clock; default 1800 s.                                                           |

Inference is offline (`HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`). The packed
Gemma BF16 text encoder carries its embedded tokenizer and sidecars
(`gemma_assets.py`), so **no tokenizer is downloaded at run time**.

## Component filenames (under `MODEL_ROOT`)

Required for the corresponding lane:

- `diffusion_models/ltx-2.5-22b-dev-transformer-bf16.safetensors` (Full `generate`, `generate-hq`, `audio-to-video`, `keyframes`)
- `diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors` (Distilled `generate`, `retake`, `refine`)
- `text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors`
- `vae/ltx-2.5-video-vae-bf16.safetensors`
- `vae/ltx-2.5-audio-vae-bf16.safetensors`
- `latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors`
- `latent_upscale_models/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors` (Distilled `refine` with `temporal_upscalings > 0`)
- `loras/ltx-2.5-22b-distilled-lora-450-bf16.safetensors`
- `loras/ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors` (Distilled `refine` detailing; repo `Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler` revision `380e63e764cad353c47a8e7c9c7ad6095d25e814`)

Optional (served if present, never required):

- `model_patches/ltx-2.5-duration-head-bf16.safetensors`
- `vae/ltx-2.5-video-vae-conv-bf16.safetensors`

## Build / image

`backends/ltx-pipelines/Dockerfile` uses the pinned Ubuntu base digest shared
with `backends/comfyui-media`, fetches the pinned LTX-2 commit, installs its CUDA 13.2 dependencies with the
checked-in `upstream-uv.lock` using `uv sync --frozen`, and then the pinned HTTP layer
from `requirements.txt`. `install.py` computes a SHA-256 over
the backend source files and pinned dependency lock, tags the image
`lloom/ltx-pipelines:source-<sha>`, and reuses an existing image **only** when its
`dev.lloom.source-sha256` label matches. A mismatched image is refused.

## Known limitations

- Distilled `generate` and `refine` do **not** accept `steps`, `negative_prompt`,
  or guidance — that is upstream's parser surface, not an omission here.
  `audio-to-video`, `keyframes`, `retake`, and `refine` reject `generated_keyframes`; `retake`
  rejects `steps` and guidance.
- `refine`'s detailing-LoRA strength is hardcoded to 0.5 upstream.
- The image build and real GPU generation are verified by the parent, not by the
  CPU contract tests in `test/ltx-pipelines.test.mjs`.

## Installation and model IDs

Use `lloom setup --recipe linux-nvidia-ltx-2-5-native --additive --model-root /path/to/models`
to review the plan, then repeat with `--apply --yes`. No aliases or defaults are
changed. Both IDs share one serialized runtime with no chat warmup.
The existing ComfyUI `Lightricks/LTX-2.5` recipe remains separate.

Hugging Face access is required for both LTX-2.5 and the separately gated
`Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler` repository used by
`refine`. Component directories follow LLooM's `Lightricks--LTX-2.5` layout; the
adapter for `refine` has its own repository directory. `/health` lists available and
unavailable variants. Missing components fail the affected request with 503.

Defaults are 832x512, 121 frames, 24 fps, seed 0, and upstream's per-pipeline
step/guidance defaults. Distilled `refine` with two spatial upscalings needs
dimensions divisible by 128. `audio-to-video` rejects audio-generation guidance
because its audio is frozen.

Run CPU tests with `pip install -r backends/ltx-pipelines/requirements-test.txt`
and `npm run test:ltx-native` using that Python environment on PATH. They require
loopback binding. GPU output quality is a separate live acceptance check.

The Distilled `retake` workflow accepts a bounded MP4 with 8k+1 frames and constant integer fps. It converts source audio to stereo if needed. The video and audio outside the edited interval still pass through the model VAEs, so preservation is not bit-identical. See [request examples](video-workflows.md).


## Native audio-to-video sampling repair

The full BF16 checkpoint's `audio-to-video` workflow requires a suitable sampling
pipeline. In the local
512x512 speech comparison, deterministic Euler produced blinking and head motion
but no mouth articulation. Holding the image, audio, prompt, seed, guidance and
schedule fixed, switching both stages to native Euler ancestral restored visible
articulation and a quiet closed-mouth tail. The implementation uses Lightricks'
`EulerAncestralDiffusionStep` and `euler_ancestral_denoising_loop`; it does not import
ComfyUI or invoke its server. Stage 2 still uses the distilled refinement LoRA.

`audio-to-video` defaults are sampler `euler_ancestral`, 30 steps, video CFG 3, STG 0,
rescale 0, audio-to-video guidance 1, and first-image strength 0.7. Explicit
request overrides remain available. Endpoint strength stays 1.0. Other native
workflow defaults are unchanged. Source revision and modifications are recorded
in `backends/ltx-pipelines/a2v.py`, which is included in the image source digest.

The actual native sampler regression check covers frozen audio preservation at
every step despite ancestral noise injection. A real federated render is needed
to assess articulation; successful API responses alone are not lip-sync evidence.

The final default-only federated request produced 193 frames at 512x512/24fps
in 274.481 seconds. The supplied 4.96-second speech waveform correlated 0.99994
with the encoded output, and inspected frames showed articulation followed by
a closed-mouth tail. This is a single-reference functional check, not a
phoneme-level synchronization score. See the [acceptance record](evidence/2026-09-27-video-workflows/native-a2v-repair.json).
