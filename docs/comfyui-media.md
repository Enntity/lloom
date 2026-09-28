# ComfyUI image, video and music recipes

Each `linux-nvidia-comfyui-*` recipe installs one model and the files its workflow
uses. Most recipes share a single LLooM-managed `comfyui-media` runtime. The NVFP4
Qwen recipe uses a dedicated runtime with a smaller memory reservation. The first
installation builds the backend from public source; later installations reuse
the image. Shared-media installations also reuse their container, backend URL
and concurrency limit.

## Install

Use Linux on NVIDIA hardware with Docker, NVIDIA Container Toolkit, Python 3
with venv support, and a CUDA 13-compatible driver. Shared media recipes reserve
95 GiB; the dedicated NVFP4 Qwen recipe reserves 32 GiB. Consult each recipe's
`diskGb` estimate before downloading. Model repositories can require separately
accepted access terms and Hugging Face authentication; credentials stay in your
local Hugging Face environment and are never included in recipes or images.
LTX-2.5 is gated: accept its repository's access terms and authenticate `hf`
before running that recipe.

Preview the complete plan, then apply and start:

```sh
lloom setup --recipe linux-nvidia-comfyui-ace-step-1-5-xl-turbo --additive --json
lloom setup --recipe linux-nvidia-comfyui-ace-step-1-5-xl-turbo --additive --apply --yes --start
```

The backend installer builds ComfyUI at commit
[`5ba116a40f1944f64e2e4a8ace826656e6293bf4`](https://github.com/Comfy-Org/ComfyUI/commit/5ba116a40f1944f64e2e4a8ace826656e6293bf4)
with PyTorch 2.11.0/CUDA 13.0 and the bundled bridge. The image tag identifies the
bundled build inputs by SHA-256. It is built locally, never pulled from a private
registry. Reapplying setup checks its source label and reuses a matching image.
ComfyUI's dependencies come from that pinned revision; the image records the
resolved Python environment in `/opt/package-lock.txt`. These are source-pinned
builds, not a claim of bit-for-bit reproducibility across dependency indexes.

Add another model with the same command and its recipe ID. Use `--additive` to
preserve the rest of your catalog. The backend mounts `${modelRoot}` read-only;
its extra model paths cover repository roots, `split_files`, and root-level
LoRAs. Paths for all bundled models are registered when it starts, so subsequent
model installations become visible without changing its launch configuration.
Run setup while the media lane is idle: acquisition can temporarily stage a
shared model directory while verifying newly requested files.

The shared engine has one generation slot across all modalities. LLooM queues
requests through that runtime, so adding models does not start duplicate GPU
engines. This reuse applies to the managed runtime created by these recipes;
an unrelated ComfyUI installation is not silently adopted. Docker backend ports
remain bound to loopback. Clients use the authenticated LLooM gateway.

Qwen-Image 2.1 is the one image family here that generates and edits from a
single checkpoint. It samples at its own shift with classifier-free guidance off,
so unlike `qwen-image-2512` it is not patched with an aura-flow shift and it needs
no Lightning LoRA. Its own VAE decodes RGBA, so a prompt asking for a transparent
background returns a PNG with a real alpha channel. Edits accept one reference
image and follow that image's geometry; `resolution` sets the reference pixel
budget instead of an explicit width and height. Both multipart
`POST /v1/images/edits` (one `image` or `image[]` file) and JSON
`POST /v1/images/generations` with an inline `image` data URI support editing.
Use the Diffusers recipe for up to ten reference images.

Qwen 2.1 uses a fresh seed when omitted and returns the actual seed in the
response. Reusing the generation seed for an edit can produce severe texture
artifacts. Explicit seeds remain reproducible; use a different seed for each
successive edit. Seeds are integers from zero through `2^53-1`, so JSON clients
can replay them exactly. Other model families retain their existing defaults.

The default is `quality: "high"` (40 steps). `medium` uses 25 and `low` uses
12; explicit `steps` overrides a valid preset. `cfg` must be 1 and nonempty
negative prompts are rejected because this workflow does not use them.
Generation supports 32-pixel-aligned sizes up to 3072 per axis and 4.5 MiPixels,
including 2048x2048 and 2752x1536. Without `size`, `resolution` supplies the square
output size (default 1024; range 256–2048). Edits use `resolution` to resize their
reference while preserving its aspect ratio. The graph preserves reference
alpha through `JoinImageWithAlpha` before Qwen encoding.

The separate `linux-nvidia-comfyui-qwen-image-2-1-nvfp4` recipe creates
`qwen-image-21-nvfp4`, with its own container, port, data volume and model filter.
This keeps its smaller admission budget separate from the shared 95 GiB media
runtime, regardless of installation order. Both use the same backend image. It uses
[BennyDaBall's NVFP4 checkpoints](https://huggingface.co/BennyDaBall/Qwen-Image-2.1-NVFP4)
for the transformer and Qwen3-VL encoder. The VAE, vision tower, embeddings and
selected sensitive weights retain higher precision. The download is 12.42 GB
(decimal), including the shared 0.68 GB VAE. The recipe pins every file's
revision, size and SHA-256. It uses the same generation/edit API and quality
presets as INT8; clients select the exact advertised NVFP4 model ID.

See the [GB10 endpoint and quantization qualification](evidence/2026-09-27-qwen-image-21/README.md)
for measured timings, test scope and kernel evidence.

Native FP4 computation requires supported Blackwell hardware. The bundled,
attributed upstream patch enables quantized encoder matrix multiplication and
BF16 multimodal conditioning on supported devices; INT8/BF16 retain their
existing paths. Without that patch, loading NVFP4 weights alone does not prove
native encoder acceleration. The Docker build checks the patch against the
pinned engine before applying it. NVFP4 is lossy and is a separate quality
choice, not a numerically equivalent replacement for BF16 or INT8.

If the selected model already has a configured route, setup preserves its backend,
runtime and upstream model ID while refreshing its media capabilities. This also
migrates an existing music model from `audio_speech` to `audio_generation`; the
existing backend must support `/v1/audio/generations`.

## Models

| Recipe suffix               | Gateway model                       | Endpoint                                            |
| --------------------------- | ----------------------------------- | --------------------------------------------------- |
| `flux-2-klein-4b`           | `black-forest-labs/FLUX.2-klein-4B` | `/v1/images/generations`                            |
| `qwen-image-2512`           | `Qwen/Qwen-Image-2512`              | `/v1/images/generations`                            |
| `qwen-image-2512-lightning` | `Qwen/Qwen-Image-2512-Lightning`    | `/v1/images/generations`                            |
| `qwen-image-edit-2511`      | `Qwen/Qwen-Image-Edit-2511`         | `/v1/images/generations` with inline image          |
| `qwen-image-2-1`            | `Qwen/Qwen-Image-2.1`               | `/v1/images/generations` and `/v1/images/edits` |
| `qwen-image-2-1-nvfp4` | `BennyDaBall/Qwen-Image-2.1-NVFP4` | `/v1/images/generations` and `/v1/images/edits` |
| `ideogram-4`                | `Comfy-Org/Ideogram-4`              | `/v1/images/generations`                            |
| `krea-2-turbo`              | `Comfy-Org/Krea-2-Turbo`            | `/v1/images/generations`                            |
| `minimax-h3`                | `MiniMaxAI/MiniMax-H3`              | `/v1/videos/generations`                            |
| `minimax-h3-turbo`          | `MiniMaxAI/MiniMax-H3-Turbo`        | `/v1/videos/generations`                            |
| `ltx-2-5`                   | `Lightricks/LTX-2.5`                | `/v1/videos/generations`                            |
| `minimax-music3`            | `MiniMaxAI/MiniMax-Music3`          | `/v1/audio/generations`                             |
| `ace-step-1-5-xl-sft`       | `ACE-Step/ACE-Step-1.5-XL-SFT`      | `/v1/audio/generations`                             |
| `ace-step-1-5-xl-turbo`     | `ACE-Step/ACE-Step-1.5-XL-Turbo`    | `/v1/audio/generations`                             |
| `yue2-3b`                   | `Comfy-Org/YuE2-3B`                 | `/v1/audio/generations`                             |

Prefix each suffix with `linux-nvidia-comfyui-` for the recipe ID. Recipe metadata
is MIT licensed; model weights retain their own licenses. Each recipe links its
model source and identifies exact download repositories, revisions, sizes and
SHA-256 hashes. Review the upstream terms for the chosen model. Installation does
not imply commercial permission or redistribute weights under LLooM's license.

## Generate music

```sh
curl --fail-with-body --retry 30 --retry-delay 15 "$LLOOM_BASE_URL/v1/audio/generations" \
  -H "Authorization: Bearer $LLOOM_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"ACE-Step/ACE-Step-1.5-XL-Turbo","instructions":"Gentle instrumental piano","lyrics":"","duration":30,"seed":42,"response_format":"wav"}' \
  --output music.wav
```

`LLOOM_BASE_URL` is the gateway origin, without `/v1`. Use the exact advertised
model ID for a federated gateway. `GET /v1/audio/generations/models` discovers the
music catalog. `defaults.audioGenerationModel` is the optional default. Both the
gateway and media bridge refuse music calls through `/v1/audio/speech`; that
endpoint remains for speech synthesis.

A cold runtime may first return `429` with `RUNTIME_STARTING` and `Retry-After`.
Retry after that interval; the example above handles this startup response.

Audio responses are WAV bytes. The gateway forwards bytes as the upstream emits
them; ComfyUI workflows themselves finish an artifact before returning it.
Disconnecting the client closes the upstream request. The bridge retains its
single slot until the ComfyUI job reaches a proven terminal state, preventing an
abandoned job from overlapping the next request.

The image and video routes return JSON containing `data[].b64_json`. Fixed
workflows accept bounded generation parameters and inline conditioning images;
they do not accept arbitrary ComfyUI graphs, filesystem paths or remote URLs.
MiniMax-H3 and its FL2VA Turbo variant support first/last-frame conditioning.
Full H3 also accepts image, audio and video references. See
[video workflows](video-workflows.md) for structured prompts, transcripts,
controls and limits.

LTX supports a first frame, a final-frame guide and supplied audio. Its graph
pins and crops the final-frame guide in both sampling stages. Supplied audio
is trimmed or padded with silence to the video frame grid, and mono is duplicated
into stereo. The graph holds that encoded audio latent fixed and muxes the
prepared waveform into the result. At 24 fps, 193 frames produce about 8.04
seconds. Audio conditioning does not guarantee precise lip synchronization.
Unsupported parameters receive field-specific errors.

## Offline tests

```sh
python3 -m venv /tmp/lloom-media-tests
/tmp/lloom-media-tests/bin/pip install -r backends/comfyui-media/requirements-test.txt
/tmp/lloom-media-tests/bin/python scripts/test-comfyui-media.py
node test/comfyui-media.test.mjs
node --test test/audio-generations.test.mjs test/model-acquisition.test.mjs
```

The Python tests use an in-process ComfyUI fake. They test request validation,
graph construction, cancellation, single-flight execution, model path mapping
and output cleanup. The gateway tests use real loopback HTTP servers. GPU
artifact generation and a clean Docker build require separate host validation.

## Workflow cache configuration

Set `LLOOM_COMFY_CACHE_MODE=classic` in the managed runtime's Docker environment
to retain ComfyUI's last-workflow node cache, including reusable model loaders.
Dedicated music or video runtimes can reuse that cache across requests.
The default, `none`, preserves the previous uncached behavior. Unsupported values
fail startup. This setting does not pin a runtime or override LLooM admission;
allow headroom for retained workflow tensors in its `memoryGb` estimate.

Each request uses a unique output-save prefix so cached graphs cannot reuse an
artifact already deleted by bridge cleanup. Model-loader inputs remain stable.
