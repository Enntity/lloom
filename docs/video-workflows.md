# Calling local video models

Use the authenticated LLooM owner gateway for discovery and generation:

```text
GET  /v1/videos/generations/models
POST /v1/videos/generations
```

Discovery returns each configured video ID, accepted fields, reference inputs,
frame grid, and workflow notes. It describes the API contract; it does not imply
that every checkpoint has been downloaded. Model loading and eviction happen
through LLooM. Clients do not need ComfyUI graphs, backend ports, or model paths.

All examples below run inference locally. References are inline data URIs.
URLs and remote file paths are rejected. Responses contain an MP4 in
`data[0].b64_json`. A cold runtime can return HTTP 429 with code
`RUNTIME_STARTING`; wait and retry that response. Do not blindly retry a timed-out
generation, since the first request may still be running.

| Gateway model                       | Workflow         | Image inputs                  | Audio input               | Video input              | Use                                            |
| ----------------------------------- | ---------------- | ----------------------------- | ------------------------- | ------------------------ | ---------------------------------------------- |
| `MiniMaxAI/MiniMax-H3`              | frames/reference | First/last frames or identity | Voice/timbre reference    | Motion/content reference | Speech and motion with an optional endpoint guide |
| `MiniMaxAI/MiniMax-H3-Turbo`        | turbo            | First/last frames             | None                      | None                     | Eight-step FL2VA generation                    |
| `Lightricks/LTX-2.5`                | distilled        | First/last frames             | Driving waveform          | None                     | Quantized Comfy two-stage generation           |
| `Lightricks/LTX-2.5-Comfy-Full`     | full             | First/last frames             | Driving waveform          | None                     | Guided Comfy two-stage generation              |
| `Lightricks/LTX-2.5-Full`           | `generate`       | First/last/interior keyframes | None                      | None                     | BF16 guided two-stage generation (former Dev)  |
| `Lightricks/LTX-2.5-Full`           | `generate-hq`    | First/last/interior keyframes | None                      | None                     | BF16 HQ pipeline (former Dev-HQ)               |
| `Lightricks/LTX-2.5-Full`           | `audio-to-video` | First/last/interior keyframes | Required driving waveform | None                     | Animate supplied speech (former A2V)           |
| `Lightricks/LTX-2.5-Full`           | `keyframes`      | First/last/interior keyframes | None                      | None                     | Interpolate image guides (former Keyframes)    |
| `Lightricks/LTX-2.5-Distilled`      | `generate`       | First/last/interior keyframes | None                      | None                     | BF16 fixed-schedule generation (former Distilled) |
| `Lightricks/LTX-2.5-Distilled`      | `retake`         | None                          | From source video         | Required source video    | Regenerate a selected time interval (former Retake) |
| `Lightricks/LTX-2.5-Distilled`      | `refine`         | First/last frames             | None                      | None                     | Detail refinement via pixel-spatial IC-LoRA (former DFR) |
| `Wan-AI/Wan2.2-TI2V-5B-Diffusers`   | —                | One opening image             | None                      | None                     | Text/image-to-video                            |

Native LTX has exactly two public model IDs, `Lightricks/LTX-2.5-Full` and
`Lightricks/LTX-2.5-Distilled`. The earlier per-workflow IDs (`-Dev`, `-Dev-HQ`,
`-A2V`, `-Keyframes`, `-Retake`, `-DFR`) were removed with no compatibility
aliases. Select a pipeline with the explicit `workflow` field; omitting it
selects `generate`. The workflow is never inferred from the presence of `audio`
or `video`: supplying `audio` without `workflow: "audio-to-video"` is rejected.
`workflow` must be a supported, non-empty string; `null`, arrays, and numbers
are errors, as is a workflow that belongs to the other model family. The
existing Comfy LTX IDs are unchanged.

## Prompts and reference meaning

Every listed route accepts a text prompt or a structured object. For native LTX,
Comfy LTX and Wan, supported keys are `description`, `subject`, `action`,
`camera`, `lighting`, `environment`, `style`, `dialogue`, `motion`, `audio`, and
`timeline`. Values become labeled text paragraphs; nested objects/lists remain
JSON. H3 receives the structured prompt as JSON text. These are prompt
instructions, not a deterministic animation timeline.

H3's `audio` supplies a voice reference. Supply `transcript` for the requested
words; H3 synthesizes the output speech, so audition pronunciation and wording.
The native LTX `audio-to-video` workflow and Comfy LTX use the supplied waveform to drive the video and mux that
waveform into the result. They trim or append silence to the requested frame
count and duplicate mono into stereo. Lip synchronization quality still depends
on the model. H3 reference audio and LTX driving audio are different operations.

H3 selects `workflow: "reference"` automatically when `audio` or `video` is
present. Set it explicitly for an image used as an identity reference. With
`workflow: "frames"`, `image` is the opening frame and `last_frame` is the
ending guide. Reference prompts can name `<Picture 1>`, `<Audio 1>`, and
`<Video 1>`. `video_audio: true` also uses the reference video's soundtrack;
otherwise only its frames are supplied. When both `video_audio` and standalone
`audio` are provided, the video soundtrack is `<Audio 1>` and the standalone
voice is `<Audio 2>`. The transcript instruction chooses that standalone voice. `ref_image_size` defaults to `match`,
which bounds reference processing to the target canvas. The `max` alternative
can consume considerably more memory.

A `last_frame` is a conditioning guide. It does not promise pixel-identical
output or a natural transition. Describe the motion, blink, pause, and mouth
closure you want as well as supplying the guide.

## H3 image, voice, transcript and endpoint in one call

This Python example reads local assets and calls only LLooM. Set `LLOOM_URL` to
your owner gateway and `LLOOM_API_KEY` to its inference credential.

```python
import base64, json, os, time, urllib.error, urllib.request
from pathlib import Path

def inline(filename, mime):
    return 'data:' + mime + ';base64,' + base64.b64encode(Path(filename).read_bytes()).decode()

body = {
    'model': 'MiniMaxAI/MiniMax-H3',
    'prompt': {
        'description': 'The person in <Picture 1> addresses the camera in a quiet room.',
        'motion': 'She blinks naturally, speaks, closes her mouth, then settles toward the final pose.',
        'camera': 'A steady medium close-up.'
    },
    'image': inline('portrait.png', 'image/png'),
    'last_frame': inline('home.png', 'image/png'),
    'audio': inline('voice.wav', 'audio/wav'),
    'transcript': 'Hello. I have something to show you.',
    'width': 768, 'height': 768, 'num_frames': 192, 'seed': 42
}
# Optional motion reference:
# body['video'] = inline('motion.mp4', 'video/mp4')

for attempt in range(40):
    request = urllib.request.Request(
        os.environ['LLOOM_URL'].rstrip('/') + '/v1/videos/generations',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json',
                 'Authorization': 'Bearer ' + os.environ['LLOOM_API_KEY']})
    try:
        with urllib.request.urlopen(request, timeout=3300) as response:
            result = json.load(response)
        break
    except urllib.error.HTTPError as error:
        detail = json.loads(error.read())
        if error.code != 429 or detail.get('error', {}).get('code') != 'RUNTIME_STARTING':
            raise RuntimeError(detail) from error
        time.sleep(15)
else:
    raise RuntimeError('Video runtime did not become ready')
Path('result.mp4').write_bytes(base64.b64decode(result['data'][0]['b64_json']))
```

For native audio-to-video, set `model: "Lightricks/LTX-2.5-Full"` and `workflow: "audio-to-video"`,
remove `transcript`, and use `num_frames: 193`. The audio is required. Choose
enough frames for the whole utterance plus the intended silent tail. For
`generate`, `generate-hq`, `keyframes`, or the Distilled `generate` workflow,
omit `audio` too. Interior guides use
`keyframes: [{"image": "data:image/png;base64,...", "frame": 48, "strength": 1.0}]`
with explicit frame indices.

Retake uses a separate request shape:

```json
{
  "model": "Lightricks/LTX-2.5-Distilled",
  "workflow": "retake",
  "prompt": "The person turns gently toward the window.",
  "video": "data:video/mp4;base64,...",
  "start_time": 1.0,
  "end_time": 3.0,
  "seed": 42
}
```

Retake inherits source geometry and timing. Its source must use a constant
integer frame rate, dimensions divisible by 32, and an `8k+1` frame count, within
20 seconds and the native pixel limit. Mono/multichannel source audio is
converted to stereo. Retake edits audio and video latents and reconstructs the
whole clip through the VAEs; it does not preserve the original encoded bytes.

## Settings that differ by model

| Route / workflow          | Output frame count             | Defaults / useful controls                                             |
| ------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| H3 / Turbo                | `17k+5`, 124–362, fixed 24 fps | 124 frames; full H3 20 steps, Turbo exactly 8                          |
| LTX Full `generate`       | `8k+1`, 9–481                  | 832×512, 121 frames, 24 fps; omit steps/guidance for upstream defaults |
| LTX Full `generate-hq`    | `8k+1`, 9–481                  | `res_2s` HQ schedule; guided steps and guidance                        |
| LTX Full `audio-to-video` | `8k+1`, 9–481                  | Frozen driving audio required; sampler `euler_ancestral` by default    |
| LTX Full `keyframes`      | `8k+1`, 9–481                  | Interior image guides; no generated_keyframes                          |
| LTX Distilled `generate`  | `8k+1`, 9–481                  | Fast fixed schedule; no steps or guidance                              |
| LTX Distilled `retake`    | source `8k+1`                  | Source video geometry/timing preserved; interval edit                  |
| LTX Distilled `refine`    | `8k+1`, 9–481                  | Pixel-spatial IC-LoRA detailing; no steps/guidance/generated_keyframes           |
| Comfy LTX                 | `8k+1`, 25–241, fixed 24 fps   | 832×512, 121 frames; exactly 8 first-stage steps                       |
| Wan                       | `4k+1`, 9–121                  | `size: "832x480"`, 49 frames, 24 fps, 30 steps                         |

Native LTX dimensions are multiples of 64. Distilled `refine` with two spatial
upscalings requires multiples of 128. Comfy LTX uses multiples of 64; H3 and Wan use 32.
Wan accepts `size`, not separate width/height fields. Native LTX's output canvas
is limited to 2,088,960 pixels; Comfy H3/LTX to 1,032,192 and Wan to 921,600.
Higher resolution and longer clips cost substantially more memory and time.
Small smoke-test clips verify transport, not production visual quality.

Video generation can take longer than five minutes. Set the caller's HTTP
response-header timeout as well as its overall request deadline. In Node with
Undici, use a request dispatcher such as
`new Agent({ headersTimeout: 1800000, bodyTimeout: 1800000 })` and pass it as
`dispatcher` to `fetch`; an `AbortSignal.timeout(...)` alone does not override
the HTTP client's header timeout. A disconnected caller cancels native LTX
inference. LLooM's upstream media dispatcher already allows 30 minutes.

Native `retake` and `refine` reject custom steps/guidance. `audio-to-video`,
`keyframes`, `retake`, and `refine` reject `generated_keyframes`. `audio-to-video` rejects controls for generating
audio, since its audio is fixed. Comfy LTX's
`voice_identity`, `voice_start`, and `voice_end` require supplied audio and
`voice_reference` enabled. H3 rejects LTX-style negative prompts and guidance
fields. Unsupported fields and conflicting aliases return HTTP 400 rather than
being silently dropped.

Native LTX also accepts `image_strength` with `image` (0–1, default 0.7 for `audio-to-video` and 1 for other workflows).
This adjusts the first-frame guide only; `last_frame` remains at strength 1.
Comfy LTX defaults its first-stage image strength to 0.7. Specify strength
explicitly when comparing image-conditioned workflows; equal images do not
imply equal conditioning strength. `retake` has no first-frame strength control.

Comfy request bodies are limited to 48 MiB; native LTX and the gateway use
64 MiB. Comfy references allow 8 MiB per image and 16 MiB per audio/video file;
H3 reference video must be 24 fps and 5–360 frames. Native references allow
16 MiB per image, 48 MiB audio, and 32 MiB source video. Keep the combined base64
JSON body below the smaller limit of the gateway and selected backend.

See [native LTX installation and controls](ltx-pipelines.md) and
[Comfy recipe installation](comfyui-media.md). Workflow choices follow the
[pinned LTX pipeline package](https://github.com/Lightricks/LTX-2/tree/v1.3.0/packages/ltx-pipelines)
and [H3 Turbo's published FL2VA workflows](https://github.com/ModelTC/Minimax-H3-Turbo#model-specs).

### Full LTX through ComfyUI

`Lightricks/LTX-2.5-Comfy-Full` uses the BF16 dev transformer with the same
ComfyUI reference handling as `Lightricks/LTX-2.5`. Its first pass uses
`LTXVScheduler` with 30 steps by default (10–60 accepted) and video
`guidance_scale` 3 (1–20 accepted). Supplied audio remains frozen, with audio
CFG 1. The second pass uses the 2.5 distilled refinement LoRA at strength 1
and three refinement steps. This is an adaptation of the official full-model
sampling approach, not an official 2.5 full A2V template. The distilled route
retains its fixed eight-step schedule. Neither route guarantees lip sync;
audition generated articulation against the driving audio.


### Native LTX audio-to-video defaults

`Lightricks/LTX-2.5-Full` with `workflow: "audio-to-video"` runs directly in the
native backend. Its validated speech workflow uses Euler ancestral sampling in
both stages, CFG 3, STG 0, rescale 0, audio-to-video guidance 1, and
opening-image strength 0.7. Pass `sampler: "euler"` only when comparing the
deterministic path; other native workflows reject this selector. Supplied speech
stays frozen and is preserved in the output audio.
See [the native backend](ltx-pipelines.md#native-audio-to-video-sampling-repair).
