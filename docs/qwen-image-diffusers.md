# Qwen Image 2.1 generation and editing with Diffusers

This recipe runs the official Qwen Image 2.1 pipeline in a separate NVIDIA Docker
runtime. Generation and editing reuse the same loaded pipeline. It uses BF16 transformer and encoder weights with the original FP32 VAE.
It does not require ComfyUI. Installing it additively preserves existing image
models and defaults.

```sh
lloom setup --recipe linux-nvidia-qwen-image-2-1-diffusers --additive --json
lloom setup --recipe linux-nvidia-qwen-image-2-1-diffusers --additive --apply --yes --start
```

The gateway model ID is `Qwen/Qwen-Image-2.1-Diffusers`. Generation accepts JSON
at `/v1/images/generations`. Include `image` as one PNG/JPEG data URI or an
ordered list of up to ten data URIs to edit with references. Standard multipart
`/v1/images/edits` accepts repeated `image` or `image[]` file uploads, plus
`model` and `prompt`. Masks are rejected; mask-like reference images can guide
the model, but this is not pixel-exact inpainting. Responses contain a PNG at
`data[0].b64_json`, plus the effective seed, steps, size, resolution and quality.
The same provenance is embedded in PNG text chunks.

| Parameter | Behavior |
| --- | --- |
| `quality` | `high` or `auto`: 40 steps; `medium`: 25; `low`: 12. Default: high. |
| `steps` | Explicit integer 1–60 overrides the preset. |
| `seed` | Omit for a fresh seed. Explicit integers from 0 to 2^53−1 are preserved. |
| `resolution` | Reference pixel budget, 256–2048 in multiples of 32; default 1024. |
| `size` | Optional `WIDTHxHEIGHT` for either operation, multiples of 32, axes 256–3072, at most 4.5 Mi pixels. |
| `cfg`, `n` | Fixed at 1. |
| `response_format` | `b64_json`. |

Generation defaults to a square at `resolution`; edits without `size` follow
the first reference's aspect ratio at approximately `resolution²` pixels.
Explicit output size is passed to the pipeline unchanged. RGB, RGBA and EXIF
orientation are preserved during reference decoding. Requests are limited to
64 MiB total, each input to 8 MiB and 16 MP, and prompts to 8192 characters.
Remote URLs, filesystem paths, unknown fields and duplicate scalar form fields
are rejected.

Avoid reusing a generated image's seed when editing it at the same dimensions.
That can replay the original noise and cause severe speckling and sharpening.
Fresh default seeds prevent the automatic collision; explicit seeds are never
silently changed. The 53-bit range survives JavaScript gateway round trips
without rounding. [Upstream reproduction and correction](https://github.com/huggingface/diffusers/issues/14824#issuecomment-5770745487).

The runtime reserves 70 GiB in LLooM's admission configuration and runs one edit
at a time. A busy backend returns 429. Client cancellation is checked between
sampling steps; encoding and decoding are not immediately interruptible. The
backend holds its slot until the worker has actually exited.

A September 27 controlled generate/edit test reproduced the severe artifact
with a reused seed and removed it by changing only the edit seed. This corrects
the earlier suspicion that the observed generated-reference failure required a
VAE precision change. The original FP32 VAE remains the native quality baseline.
This does not guarantee that every instruction will preserve every image detail.

Prefix KV caching remains enabled. `LLOOM_QWEN_ATTENTION=flex` selects the
upstream flex-attention processor and compiles the transformer; the default is
SDPA. Compile startup, warmed latency and quality must be measured separately
on the target hardware before selecting flex for a recipe. Unknown attention
modes fail startup rather than silently choosing another implementation.
[Upstream attention guidance](https://huggingface.co/docs/diffusers/main/api/pipelines/qwenimage21).

The image build pins Diffusers, Transformers, PyTorch and the other direct
requirements and records the resolved Python environment. The recipe pins the
original model revision and weight-file hashes. A small pipeline subclass casts
reference pixels to the VAE's FP32 dtype, then returns normalized conditioning
in BF16; upstream decoding already uses the VAE dtype.

Run CPU validation with a Python environment containing pytest, Pillow, FastAPI,
httpx, and python-multipart:

```sh
python -m pytest -q backends/qwen-image-diffusers/tests
node test/qwen-image-diffusers.test.mjs
```
