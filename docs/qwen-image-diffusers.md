# Qwen Image 2.1 editing with Diffusers

This recipe runs the official Qwen Image 2.1 pipeline in a separate NVIDIA Docker
runtime. It uses BF16 transformer and encoder weights with the original FP32 VAE.
It does not require ComfyUI. Installing it additively preserves existing image
models and defaults.

```sh
lloom setup --recipe linux-nvidia-qwen-image-2-1-diffusers --additive --json
lloom setup --recipe linux-nvidia-qwen-image-2-1-diffusers --additive --apply --yes --start
```

The gateway model ID is `Qwen/Qwen-Image-2.1-Diffusers`. Send a JSON request to
`/v1/images/generations` containing that model, `prompt`, and one PNG/JPEG `image`
as a base64 data URI. The response contains a PNG at `data[0].b64_json`.
The standard `/v1/images/edits` endpoint also accepts multipart forms with an
`image` (or `image[]`) file upload, `model`, and `prompt`. This backend advertises
editing only and requires one reference image; masks are unsupported.

The output follows the reference aspect ratio at approximately one megapixel,
with a maximum output axis of 2048 pixels. The default is 40 steps, seed 42,
and guidance 1. Steps may be 1–60; guidance and the reference resolution budget
remain fixed. Explicit output size, multiple outputs, URLs, file paths, and
arbitrary pipeline options are rejected. Requests are limited to 16 MiB, decoded
images to 8 MiB and 16 MP, and prompts to 8192 characters.

The runtime reserves 70 GiB in LLooM's admission configuration and runs one edit
at a time. A busy backend returns 429. Client cancellation is checked between
sampling steps; encoding and decoding are not immediately interruptible. The
backend holds its slot until the worker has actually exited.

A September 20, 2026 GB10 comparison produced a clean teapot recoloring with this
pipeline, while the pinned ComfyUI path produced severe contrast and texture
changes even with BF16 transformer/encoder and FP32 VAE computation. This is a
specific quality canary, not broad model qualification or proof of the exact
ComfyUI defect. Diffusers took 63.3 seconds for the edit after 196.5 seconds of
cold loading. Those are separate costs, not a throughput benchmark.

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
