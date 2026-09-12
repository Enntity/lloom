# Avatar authoring through LLooM

`avatar-authoring.json` is a cloud-only gateway example. Configure `security.apiKeys` before use (the example has no usable inference key), and load `REPLICATE_API_KEY` and `OPENROUTER_API_KEY` into the gateway process environment. It has no managed runtimes and does not admit or evict local models. To extend an existing gateway, add only the needed backend/model entries; preserve its server, security, runtimes and other lanes.

The normal `POST /v1/videos/generations` route accepts:

```json
{
  "model": "cloud/replicate/topaz-video-upscale",
  "video": "data:video/mp4;base64,...",
  "target_resolution": "1080p",
  "target_fps": 24
}
```

Topaz resolutions are `720p`, `1080p`, or `4k`; frame rate is an integer from 15 through 120. LLooM validates these inputs before submission, sends only the supported fields, polls inside the gateway, and returns the provider's video bytes. The existing Replicate image/audio talking-head contract remains supported. OpenRouter frame-conditioned generation retains the existing `frame_images` contract.

Responses expose `x-lloom-provider`, `x-lloom-provider-job-id`, and `x-lloom-upstream-model` for provenance. Provider download credentials never reach callers. Only trusted provider output origins are downloaded, without following redirects. `timeoutMs` on the selected backend bounds submission, polling and download. The existing JSON body limit is 64 MiB, including base64 expansion. Do not retry an ambiguous paid submission automatically.

Avatar Studio's upscaler and endpoint bridge helper use `LLOOM_BASE_URL` (including `/v1`) and `LLOOM_API_KEY`. Gateway model overrides are `LLOOM_UPSCALE_MODEL` and `LLOOM_I2V_MODEL`. These authoring clients never load provider keys. Other older generators must be migrated before claiming every Studio model call uses LLooM.

For a prompt-guided repair of an existing clip, use `cloud/replicate/kling-o1-edit`
with `video` as an MP4 data URI, a nonempty `prompt`, and `mode: "pro"` (or `"std"`).
LLooM maps this to Kling O1's `reference_video` with `video_reference_type: "base"`;
callers cannot change it into a motion-reference generation request. Optional
`reference_images` accepts up to four PNG/JPEG data URIs. `keep_original_sound`
defaults to true. The provider currently requires a 3–10 second input clip.
See the [provider input schema](https://replicate.com/kwaivgi/kling-o1/api/schema).
Kling O1 rejects a last-frame image combined with a base video (provider error
1201, verified in a real authoring request). LLooM therefore rejects
`frame_images` on this editing route before any provider submission. Supply the
home image through `reference_images` and describe endpoint preservation in the
prompt; this is soft guidance, so measure the returned start/end pose before
packing. First/last-frame generation remains available on the separate Kling
3 and Vidu routes.

A repair output is a review candidate: inspect identity, motion, endpoint detail,
exposure and duration before rebuilding any pack.

`cloud/replicate/ltx-retake` regenerates an interval of an existing video with
LTX 2.3 Pro. Supply `task: "retake"`, an MP4 `video` data URI, `prompt`,
`retake_start_time`, and `retake_duration` (2–20 seconds, within the input).
It uses `replace_video` at 1080p, with 24 fps by default. Prepare a 16:9 or 9:16
input without stretching the subject. The surrounding video supplies context;
there is no separately pinned end-frame parameter in this mode. See the
[retake contract and example](../../docs/video-providers.md#replace-an-interval-with-ltx-23-pro).

`cloud/replicate/kling-v3.0-standard` exposes Kling 3 first/last-frame generation
through Replicate. Supply a `first_frame` in `frame_images`, optionally followed by a `last_frame`,
a prompt and an integer duration of 3–15 seconds. Omitting the last frame leaves
the ending unconstrained, useful for performance-reel experiments. `mode` defaults to `standard`;
`pro` and `4k` are also accepted. Provider HTTP failures preserve their status.

`cloud/replicate/wan-short-join` is an experimental, pinned Wan first/last-frame
lane for genuinely short joins. Supply two PNG/JPEG `frame_images`, `prompt`,
`duration`, and optional integer `seed`. The upstream version is pinned inside
the adapter; callers cannot override it. Durations must encode 9–121 frames at
16 fps with frame count `4n+1` (for example, 0.5625 seconds is 9 frames). This
avoids silent frame-count correction or acceleration. The upstream square
output is 480px; this lane is not a quality-qualified production source. Inspect
motion and apply source-resolution/detail gates before including any output.
See the [upstream implementation](https://github.com/lucataco/cog-wan-2.2-first-last-frame/blob/main/predict.py).

`cloud/replicate/vidu-join` exposes Vidu Q3 Pro start/end joins with integer
`duration` from 1–16 seconds and `resolution` of `540p`, `720p`, or `1080p`
(default). Supply both frame images and a natural-language prompt. Audio is
always disabled on this avatar join lane. Optional `seed` is a nonnegative
integer. See the [provider input documentation](https://replicate.com/vidu/q3-pro).

The LLooM module's read-only `findRecentVideoJob` helper can recover a recent
Replicate prediction after an ambiguous or unattributed response. It matches
an exact upstream model and prompt and returns only job/status/error metadata;
input media and prompts are never returned. Reconcile terminal status before
changing a request or retrying a generation.
