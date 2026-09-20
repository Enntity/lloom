# Qwen-Image 2.1 on the Spark 3 media lane

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

The repeat at the same figure is the useful part: the lane is stable, not a warm
first-call artifact. Against the previously advertised high-quality route
(`Qwen/Qwen-Image-2512` at 50 steps) 2.1 is about eight times faster at
comparable output quality, and it lands within about 5 s of the four-step
Lightning lane while running five times the steps. That is the basis for making
it the leader's default image endpoint rather than leaving 2512 in that slot.

The 1536x1024 case is 1.5 megapixels. The graph caps generation at 2 megapixels
(`image_geometry`), which is below 2.1's native 2K, so a true 2048x2048 request
is rejected by the shared geometry rule rather than by the model.

## Why 2.1 editing is not advertised: the engine drops the reference image

The first version of this record blamed the model, because 2.1 returned a new,
tighter composition of a similar house instead of the requested edit. That was
wrong. The conditioning node never received the reference image.

`TextEncodeQwenImage21` takes its reference set through an autogrow input; the
graph supplies exactly the shape the pinned official template uses
(`inputs["images"] = {"image_1": ["5", 0]}`). Instrumenting the node inside the
engine shows what it actually receives on a request that travels the normal
bridge path:

```
[TRACE-NODE] 4 keys= ['clip', 'images', 'negative_prompt', 'prompt', 'resolution', 'vae']
             images_raw= {'image_1': ['5', 0]}          <- as submitted
[TRACE21]    images= []                                 <- as delivered to execute()
```

An empty mapping means the node encodes the prompt with no image slots and no
reference latents, and the model then does what a text-to-image model does with
a prompt about a roof and a door: it paints a roof and a door. Every 2.1 "edit"
so far has been a text-to-image generation, which is why the results were fast,
plausible and scene-free. The same run with the reference swapped for a
completely different picture produced the same composition, and a same-graph
submission with an empty `images` mapping produced the same bytes.

What was ruled out before reaching that conclusion:

- The bridge submits the right graph. It logs the node inputs it builds and the
  JSON it posts, and both carry `{"image_1": ["5", 0]}`.
- The input shape is right. ComfyUI's own `get_finalized_class_inputs` followed
  by `build_nested_inputs` returns `{'image_1': ['5', 0]}` for that mapping,
  both in isolation and for the bridge's exact inputs.
- The engine is otherwise healthy. `Qwen/Qwen-Image-Edit-2511` edits the same
  reference through the same bridge and keeps the scene exactly, changing only
  the roof and the door. That run is 165-172 s.

The loss therefore sits in this engine build's dynamic-input handling between
validation and execution, not in the graph, the bridge, or the checkpoint. The
node's other inputs (`clip`, `prompt`, `vae`, `resolution`) all arrive intact,
so the fault is specific to the autogrow mapping.

Until that is fixed, `image-edit` resolves to
`ennspark03/Qwen/Qwen-Image-Edit-2511`, which is measured working on this
engine, and the federated 2.1 route advertises `image-generation` only.
`ennspark03` still exposes 2.1 with `image-editing`, because a direct caller that
does not need a reference image is unaffected.

### Next step for editing

The explicit-image conditioning node (`TextEncodeQwenImageEditPlus`) is the
proven path on this engine, but it has not yet been shown to work with the 2.1
checkpoint: the first attempt to drive it produced a graph the engine rejected,
and that rejection was in the test graph rather than in the node. Getting 2.1
editing working means either establishing that node against the 2.1 checkpoint,
or carrying the autogrow mapping through the engine. Neither is done here.

## Leader configuration

`ennspark01` now carries the proxy model `ennspark03/Qwen/Qwen-Image-2.1` on the
`spark03-premium` remote runtime, and `defaults.imageModel` is the `image-quality`
alias pointing at it. `image-fast` (Qwen-Image-2512-Lightning) and `image-edit`
(Edit-2511) are unchanged, so a caller that wants the cheapest or the most
faithful edit still has a named route.

## Boundaries

The comparison is single-concurrency and text-to-image only, on one machine
class. No 2.1 edit figure is quoted anywhere in this record, because no 2.1 edit
has been produced yet: the runs previously labelled "edit" were generations
without a reference image (see above). Text fidelity, typography and
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
