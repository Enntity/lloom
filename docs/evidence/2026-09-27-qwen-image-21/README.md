# Qwen Image 2.1 endpoint and NVFP4 qualification

Tests ran on a single DGX Spark (NVIDIA GB10, SM121, 128 GB unified memory).
All inference used local LLooM image endpoints. Fixtures were synthetic photos,
product shots, transparent illustrations, and typography; no entity assets or
cloud image generation were used. Results are a bounded qualification, not a
claim that every prompt or edit is artifact-free.

## Versions and request contract

- BF16: `Qwen/Qwen-Image-2.1-Diffusers`, PyTorch/Diffusers native pipeline,
  image source `8bc87bfee0e1993ab240fcb0720456d76a274643adc48fdbecfe22dce083e76a`.
- INT8: `Qwen/Qwen-Image-2.1`, ComfyUI's convolution-rotation INT8 checkpoints.
- NVFP4: `BennyDaBall/Qwen-Image-2.1-NVFP4`, revision
  `1a38d44a3a2f35cb0b543a25b04da0a963e7b5e6`; all three files verified against
  the recipe's byte counts and SHA-256 values before loading.
- Both quantized lanes: ComfyUI `5ba116a40f1944f64e2e4a8ace826656e6293bf4`,
  PyTorch `2.11.0+cu130`, comfy-kitchen `0.2.35`, comfy-aimdo `0.5.5`.
- Matched quantization comparison and kernel audit used backend source
  `444124258fa2c55e56cf088a4c70f558bb7051d049d026d822d5fe11e75cae68`.
  The final image `dbfd165113ba5bf3062f953f97bfe41bff7dcb6996d0f7cdcbd6ee391f54a6cb`
  adds bridge model filtering; graph, weights, engine and quantized computation
  are unchanged. Final residency and federation checks use that image.

The endpoints now generate a fresh 53-bit seed when omitted and echo the seed.
Reusing the generation seed for an edit reproduced severe texture corruption
in the original BF16 fixture; changing that edit seed removed it. Explicit seeds
remain unchanged for reproducibility. This addresses the demonstrated default
seed failure, not every possible source of generative artifacts.

High/auto quality uses 40 steps, medium 25, low 12. CFG is 1. Unsupported CFG,
negative prompts, masks, unsafe seeds, malformed images and unknown parameters
fail explicitly. The native pipeline supports 1–10 ordered references; ComfyUI
supports one. Both accept multipart edits; inline JSON edits remain supported.
The Comfy graph joins RGB and inverse-alpha mask before image conditioning,
preserving RGBA references through the real execution resolver.

## Endpoint acceptance

| Backend | Successful renders | Invalid requests correctly rejected |
| --- | ---: | ---: |
| BF16 native | 18 | 16 |
| INT8 ComfyUI | 15 | 16 |
| NVFP4 ComfyUI | 15 | 16 |

The matrix covered quality presets, omitted and explicit seeds, generated-image
editing, successive edits, exact replay, portrait edits, RGBA generation/editing,
2048² output, EXIF-oriented JPEG references, and recovery after rejection.
Native also covered two-reference JSON/multipart and the ten-reference limit.
All three reproduced identical image pixels for explicit-seed edit replay.
PNG file hashes can differ when workflow metadata differs.

Visual review found clean edits in these fixtures and no recurrence of the
seed-replay texture corruption with the new defaults. Prompt following remains
imperfect: the astronaut-cat prompt sometimes produced an ordinary costumed cat,
and portrait attributes were not always all followed. No universal quality
parity claim is made for either lossy quantization.

## Matched INT8 versus NVFP4 timing

Normal LLooM requests, one runtime at a time, cache disabled for both so text
conditioning executes on every call. A separate 512² warmup precedes three
1024² generations with seeds 62419, 90817 and 38904. Three edits use the same
768×1024 source portrait, identical eyeglasses instruction, resolution 768,
and seeds 112358, 271828 and 314159. All timed requests use 40 steps.
Medians include bridge/gateway and artifact return; profiler overhead is excluded.
Exact prompts, seeds, sizes, output hashes and individual timings are in
[requests.json](requests.json).

| Workload | INT8 | NVFP4 |
| --- | ---: | ---: |
| 1024² generation, median of 3 | 31.18 s | 30.20 s |
| Portrait reference edit, median of 3 | 21.15 s | 20.17 s |

The gain in this small sample is modest. The initial 2048² acceptance renders
were 183.90 s INT8 and 154.84 s NVFP4, but those runs used different cache
settings and are not an isolated quantization speed comparison. BF16 native
and ComfyUI also differ in scheduling, VAE precision and implementation, so
cross-runtime image differences cannot be attributed only to quantization.

## Cached residency and 2K comparison

Both lanes then used `LLOOM_COMFY_CACHE_MODE=classic` on the final image, with
fresh containers and the same sequence: 1024² generation, portrait edit at
resolution 768, and 2048² generation, all at 40 steps. Only one image runtime ran
at a time; the embedding and speech-cloning services remained running.
`MemAvailable` was sampled every 250 ms. Values below are approximate **additional
host memory relative to the stopped-runtime baseline**, including runtime/context
overhead. They are not checkpoint disk sizes or per-process GPU allocator totals.
The two baseline available-memory readings differed; each lane uses its own
immediately preceding baseline. See [resident-memory.json](resident-memory.json).

| Measurement | INT8 | NVFP4 |
| --- | ---: | ---: |
| Retained memory after sequence | 20.68 GiB | 14.86 GiB |
| Peak additional memory during sequence | 25.53 GiB | 19.68 GiB |
| Cached 2048² render, one request | 180.82 s | 150.85 s |

This sequence supports a conservative 32 GiB admission reservation for the
single-model NVFP4 recipe. It does not establish a worst-case bound for every
supported aspect ratio, prompt or concurrent workload. GB10 shares system/GPU
memory, and ComfyUI uses allocations outside PyTorch's own counters; quoting
only `torch_vram_total` would severely understate this runtime's memory.

Generation and multipart editing also passed through a separate federating
LLooM gateway for BF16, INT8 and NVFP4. An older static INT8 descriptor omitted
image input/editing; updating that descriptor and adding NVFP4 resolved the
initial capability rejection. See [federation.json](federation.json).
The qualified NVFP4 lane is preferred-warm and may be evicted for larger work;
the BF16 and INT8 lanes remain available on demand.

## Native FP4 verification

A temporary, removed-after-use profiler wrapped the Qwen encoder forward and
KSampler separately during a real LLooM reference-edit request. Both stages
executed `cutlass3x_sm120_bstensorop_s16864gemm_block_scaled_ue4m3xe2m1_ue4m3xe2m1`
kernels on GB10 SM121: **252 encoder launches and 7,680 denoiser launches**.
See [native-fp4-kernels.json](native-fp4-kernels.json) for exact names/counts.
This proves native FP4 compute in both stages, not just successful weight loading.
Protected high-precision weights and other operators still use higher precision.

## Offline and packaging checks

The final source passed 305 ComfyUI bridge/graph/model-root tests, 87 native
Qwen server tests, recipe composition tests in both installation orders, the
native recipe check, syntax checks, interchange validation and the package
install smoke test. The actual pinned-engine build also passed the Qwen image
reference execution-resolver check. Model isolation is tested at the HTTP bridge:
a dedicated NVFP4 runtime advertises one model and rejects other registered
models before graph submission. Empty and unknown selectors fail startup.

## Reproduce

Install the relevant pinned recipes and call the exact advertised model IDs
through the authenticated LLooM gateway. Do not use a cloud-backed image alias
for this comparison. Use `quality: "high"`, explicit distinct seeds per edit,
and the request parameters in the receipt file. Serialize the backends and use
the same cache setting when comparing latency or retained memory. A 2K image
is a separate workload from a 1K image; disk checkpoint size is not runtime memory.

## Upstream references

- [Qwen Image 2.1](https://huggingface.co/Qwen/Qwen-Image-2.1)
- [Diffusers QwenImage21 API](https://huggingface.co/docs/diffusers/main/api/pipelines/qwenimage21)
- [Generated-reference seed issue](https://github.com/huggingface/diffusers/issues/14824#issuecomment-5770745487)
- [NVFP4 weights](https://huggingface.co/BennyDaBall/Qwen-Image-2.1-NVFP4)
- [NVFP4 encoder patch and validation scope](https://huggingface.co/BennyDaBall/Qwen-Image-2.1-NVFP4/blob/main/runtime/README.md)

Default-route follow-up: NVFP4 is now the direct image default and the target of all four fleet image aliases. Five real requests verified generation and multipart editing with the model omitted, plus the explicit edit alias. All output PNG graphs identify both NVFP4 checkpoints. Unrelated configuration was unchanged. See [default-routing.json](default-routing.json).
