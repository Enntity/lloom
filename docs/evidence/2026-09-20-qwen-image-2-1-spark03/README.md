# Qwen-Image 2.1 on the Spark 3 media lane

Later rollout: [resident essentials and one shared generation/editing pipeline](../2026-09-20-spark03-residency/README.md) supersedes the generation-default routing described below and records the remaining input-dependent edit artifacts.

Measured September 20, 2026 through the live gateways, not from model cards. The
work added Qwen-Image 2.1 to the shared ComfyUI media backend, installed it on
`ennspark03` with the recipe below, and then federated it from `ennspark01` as
the default image lane.

## What was installed

| Item | Value |
| --- | --- |
| Gateway model ID | `Qwen/Qwen-Image-2.1` (federated as `ennspark03/Qwen/Qwen-Image-2.1`) |
| Upstream artifact | `Comfy-Org/Qwen-Image-2.1` at `7562a343278731b94b18803d7de6d660cb56f841` |
| Quantization | int8 convrot DiT and text encoder, bf16 VAE |
| Engine | Comfy-Org/ComfyUI `5ba116a40f1944f64e2e4a8ace826656e6293bf4` (2.1 nodes from `6bfaacc6`) |
| Runtime | `spark03-premium`, container `lloom/spark03-premium:20260920-qwen21` |
| Recipe | `recipes/linux-nvidia-comfyui-qwen-image-2-1.json` |
| Hardware | DGX Spark / GB10, driver-provided CUDA 13 |

The recipe pins the download revision and per-file SHA-256, so acquisition is
verifiable rather than best-effort. `lloom setup --recipe
linux-nvidia-comfyui-qwen-image-2-1 --additive --apply --yes` downloaded 17.3 GB
and wrote the gateway model entry.

## Measurements

Every timing is one wall-clock request through the authenticated gateway,
covering admission, bridge serialization, text encoding, sampling, VAE decode
and artifact transfer. `results.json` is the raw capture.

| Case | Steps | Size | Wall clock | Artifact |
| --- | --- | --- | --- | --- |
| 2.1, first call | 25 | 1024x1024 | 21.2 s | 2.0 MB PNG |
| 2.1, repeat | 25 | 1024x1024 | 21.2 s | 2.0 MB PNG |
| 2.1 | 8 | 1024x1024 | 10.1 s | 1.9 MB PNG |
| 2.1 | 25 | 1536x1024 | 37.3 s | 2.9 MB PNG |
| 2.1 via the `ennspark01` default alias | 25 | 1024x1024 | 21.3 s | 1.8 MB PNG |
| 2512 fp8 | 50 | 1024x1024 | 173.8 s | 1.6 MB PNG |
| 2512 Lightning | 4 | 1024x1024 | 16.2 s | 1.7 MB PNG |

These single-request timings show lower latency than the previous quality
route (`Qwen/Qwen-Image-2512` at 50 steps). They do not establish comparable
quality or sustained-load stability.

The 1536x1024 case is 1.5 megapixels. The graph caps generation at 2 megapixels
(`image_geometry`), which is below 2.1's native 2K, so a true 2048x2048 request
is rejected by the shared geometry rule rather than by the model.

## Reference-edit graph correction

The bridge originally submitted `inputs["images"] = {"image_1": ["5", 0]}`.
ComfyUI API graphs require the flattened link
`inputs["images.image_1"] = ["5", 0]`. The engine resolves that link before
building the `images` mapping passed to `TextEncodeQwenImage21.execute()`.

The earlier explanation blaming the engine's autogrow handling was incorrect.
Calling the nesting helper directly bypassed the execution stage that drops
unknown inputs. On the installed engine, `execution.get_input_data()` drops the
nested `images` object; the flattened path resolves the image and delivers it to
the node. The previous purported edits were therefore text-only generations.

The bridge now sends the flattened link. The graph test checks that API shape,
and `build/verify_qwen_inputs.py` exercises the real engine input resolver with
a reference sentinel. It also reproduces the old failure as a negative control.
The Docker build runs this CPU-only check without loading weights. The engine
revision and conditioning node remain unchanged.

The corrected gateway cottage edit took 47.3 s at 25 steps on the first run;
a warm 40-step run took 41.3 s (one request each, different warm-up state).
Both preserved composition and changed the roof/door colours, but introduced
severe texture and contrast artifacts. A second reference (a blue teapot changed
to red) reproduced the problem in 29.2 s. Generation through Spark 3's new
model-omitted default completed in 21.1 s and looked clean.

Bounded diagnostics kept the same cottage reference, instruction and seed:

- A VAE encode/decode round trip looked clean.
- Disabling prefix caching produced identical RGB pixels to the cached edit.
- Using the already installed FP8 Qwen3-VL encoder retained the distortion.
- Using the full-precision transformer retained the distortion. Its pinned
  artifact SHA-256 is
  `89f4158d066cc33906a199fca85634f766892dd78f49b6698dabf187ac86c4bc`.
- The engine's latent mean/std match the official VAE configuration. The
  upstream reference-grid parity adjustment is zero for these equal 1024-square
  source/target grids, so it cannot explain these failures.

These checks establish reference delivery and a remaining editing-quality
failure. They do not identify its cause. The working Edit-2511 route remains the
editing default. Experimental weights are retained, but the serving graph still
uses the original pinned int8 weights.

## Leader configuration

`ennspark01` carries `ennspark03/Qwen/Qwen-Image-2.1` on the
`spark03-premium` remote runtime. `image-quality`, `image-fast` and
`image-quality-fast` now resolve to it; `defaults.imageModel` remains
`image-quality`. Spark 3's own `defaults.imageModel` now names
`Qwen/Qwen-Image-2.1`, replacing FLUX. Explicit older model IDs remain available.
`image-edit` still resolves to Edit-2511 because the corrected 2.1 edit path has
not passed visual quality checks. No chat, embedding, audio or video defaults
were changed.

## Boundaries

The original comparison is single-concurrency and text-to-image only, on one
machine class. The runs originally labelled "edit" were generations without a
reference image. Corrected edit checks are recorded separately above. Text fidelity, typography and
transparency were not scored; 2.1 decodes RGBA and the graph saves PNG, but no
transparent-background artifact was generated here. The 2.1 and 2512 figures come from the same host and window but
not from an interleaved A/B run, so treat the ratio as an order-of-magnitude
result rather than a controlled benchmark. The federated timing covers the
Tailscale hop from `ennspark01` to `ennspark03` and one inline base64 payload.

## Reproduce

```sh
lloom setup --recipe linux-nvidia-comfyui-qwen-image-2-1 --additive --apply --yes
lloom runtime-start spark03-premium
curl -sS -X POST "$LLOOM_BASE_URL/v1/images/generations" \
  -H "Authorization: Bearer $LLOOM_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"Qwen/Qwen-Image-2.1","prompt":"a heron at first light","size":"1024x1024","steps":25,"response_format":"b64_json"}'
```

Recipe metadata is MIT licensed; the weights carry the Qwen Research license.
The engine repin also moves the 2512, Lightning, Edit-2511, FLUX.2, Ideogram,
Krea, MiniMax-H3, LTX, ACE-Step and YuE2 lanes onto the same engine build.

## Verification of the reference fix

The 198 offline media tests, 14 standalone/additive recipe checks, full
`npm test`, `npm run check`, interchange checks and package installation smoke
checks pass. The package check also needed its expected recipe count updated
from 38 to 39 after the earlier Qwen 2.1 recipe addition. A Codex review worker
found no must-fix issue in the reference-link correction or build verifier.

`reference-fix-verification.json` records request attribution and artifact
hashes. Generated diagnostic images are retained privately; the evidence
record contains no image payloads or credentials.

## Official Diffusers comparison

A later controlled teapot edit succeeded with the original Qwen checkpoint
`b3179ad355be050328e483a9dfdd9e60cd62adfa` and Diffusers
`80c7ed262aeffbeb43ef13ae04baeb9b84515a69`. It preserved the soft photographic
background and changed the teapot from blue to red. ComfyUI still produced the
severe texture/contrast artifact with BF16 transformer and encoder execution
and FP32 VAE execution. The implementations used the same reference, instruction,
1024-square output, 40 steps, guidance 1, and seed 42. Equal seeds across different
engines do not establish identical starting noise or bitwise numerical parity.

Diffusers loaded the original FP32 VAE; ComfyUI loaded its BF16 VAE repack and
upcast it for computation. The exact cause of the divergence remains unresolved.
The result does establish that the severe failure is avoidable with this model;
it should not be described as a general limitation of Qwen Image 2.1 editing.

Diffusers inference took 63.295 seconds after 196.491 seconds of loading. Peak
PyTorch allocated memory was 49,433,525,248 bytes, reserved 53,320,089,600 bytes.
This is a single quality canary, not a warmed serving-speed comparison.

- Reference PNG SHA-256: `c1f2069e78381b467da84124af7f4855c6e2543612aa62f40da803b146d21c82`
- Diffusers PNG SHA-256: `90b33e75ac07ab2c233584e1fff4a70101590dd2a5f08b8048b24482967c570e`
- ComfyUI explicit-BF16 PNG SHA-256: `dde81619d15ccf74784b1c21e6544c7ad5e2b2d40554b51d16cec8c794ea58e2`

The additive `linux-nvidia-qwen-image-2-1-diffusers` recipe exposes this working
editing path without changing the existing fast ComfyUI generation route. See
[the backend contract](../../qwen-image-diffusers.md).


## Managed Diffusers rollout

The new standalone backend was installed additively on Spark 3 and qualified
through LLooM, using the original BF16 transformer/encoder and FP32 VAE. The
container binds only to `127.0.0.1:8211`; another listener occupied the initially
planned port 8210. The managed model loaded in 160.26 seconds.

The owner gateway produced the teapot edit through the JSON endpoint in 64.015
seconds and the cottage edit through the multipart endpoint in 59.342 seconds.
Both retained the scene and avoided the earlier severe texture/contrast change.
The cottage edit also colored the adjacent window trim green; this is not a
claim of pixel-exact editing.

The fleet `image-edit` alias now resolves to
`ennspark03/Qwen/Qwen-Image-2.1-Diffusers`. A real multipart request through that
alias returned HTTP 200 in 59.725 seconds, attributed to Spark 3 with no failover.
Its image matched the direct teapot canary byte for byte. The three generation
aliases remain on `ennspark03/Qwen/Qwen-Image-2.1`; the existing Edit-2511 model
remains configured for explicit fallback calls. Existing runtime definitions and
other defaults were preserved by the additive setup.

[The verification record](diffusers-live-verification.json) contains exact
revisions, the qualified release and container identity, request attribution,
artifact hashes, checks, and rollout corrections. Generated images remain in
private evidence storage. No image payloads or credentials are committed.
