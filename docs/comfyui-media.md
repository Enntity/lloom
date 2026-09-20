# ComfyUI image, video and music recipes

Each `linux-nvidia-comfyui-*` recipe installs one model and the files its workflow
uses. The recipes share a single LLooM-managed `comfyui-media` runtime. The first
installation builds the backend from public source; later installations reuse
that image, container, backend URL and concurrency limit.

## Install

Use Linux on NVIDIA hardware with Docker, NVIDIA Container Toolkit, Python 3
with venv support, and a CUDA 13-compatible driver. The recipes conservatively
reserve 95 GiB of host/model memory for the shared runtime. Consult each recipe's
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
budget instead of an explicit width and height.

If the selected model already has a configured route, setup preserves its backend,
runtime and upstream model ID while refreshing its media capabilities. This also
migrates an existing music model from `audio_speech` to `audio_generation`; the
existing backend must support `/v1/audio/generations`.

## Models

| Recipe suffix | Gateway model | Endpoint |
| --- | --- | --- |
| `flux-2-klein-4b` | `black-forest-labs/FLUX.2-klein-4B` | `/v1/images/generations` |
| `qwen-image-2512` | `Qwen/Qwen-Image-2512` | `/v1/images/generations` |
| `qwen-image-2512-lightning` | `Qwen/Qwen-Image-2512-Lightning` | `/v1/images/generations` |
| `qwen-image-edit-2511` | `Qwen/Qwen-Image-Edit-2511` | `/v1/images/generations` with inline image |
| `qwen-image-2-1` | `Qwen/Qwen-Image-2.1` | `/v1/images/generations`, with inline image to edit |
| `ideogram-4` | `Comfy-Org/Ideogram-4` | `/v1/images/generations` |
| `krea-2-turbo` | `Comfy-Org/Krea-2-Turbo` | `/v1/images/generations` |
| `minimax-h3` | `MiniMaxAI/MiniMax-H3` | `/v1/videos/generations` |
| `minimax-h3-turbo` | `MiniMaxAI/MiniMax-H3-Turbo` | `/v1/videos/generations` |
| `ltx-2-5` | `Lightricks/LTX-2.5` | `/v1/videos/generations` |
| `minimax-music3` | `MiniMaxAI/MiniMax-Music3` | `/v1/audio/generations` |
| `ace-step-1-5-xl-sft` | `ACE-Step/ACE-Step-1.5-XL-SFT` | `/v1/audio/generations` |
| `ace-step-1-5-xl-turbo` | `ACE-Step/ACE-Step-1.5-XL-Turbo` | `/v1/audio/generations` |
| `yue2-3b` | `Comfy-Org/YuE2-3B` | `/v1/audio/generations` |

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
MiniMax-H3 supports first/last frame conditioning; its Turbo variant accepts text
only. LTX supports a first frame and audio conditioning, and rejects `last_frame`.
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
