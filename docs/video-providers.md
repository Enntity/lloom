# Provider video jobs through LLooM

`POST /v1/videos/generations` keeps the existing proxy contract for compatible backends. A backend with `videoProvider: "replicate"` or `videoProvider: "openrouter"` instead runs submission, bounded polling, and media download inside LLooM and returns the completed video bytes. Configure credentials on the backend using `apiKeyEnv`. Clients send only the LLooM credential.

Example additive configuration (credential values do not belong in config or source):

```json
{
  "backends": {
    "replicate-video": { "baseUrl": "https://api.replicate.com/v1", "videoProvider": "replicate", "apiKeyEnv": "REPLICATE_API_KEY" },
    "openrouter-video": { "baseUrl": "https://openrouter.ai/api/v1", "videoProvider": "openrouter", "apiKeyEnv": "OPENROUTER_API_KEY" }
  },
  "models": [
    { "id": "bytedance/omni-human-1.5", "backend": "replicate-video", "upstreamModel": "bytedance/omni-human-1.5", "kind": "video", "input": ["text", "image", "audio"], "output": ["video"] },
    { "id": "kwaivgi/kling-v3.0-std", "backend": "openrouter-video", "upstreamModel": "kwaivgi/kling-v3.0-std", "kind": "video", "input": ["text", "image"], "output": ["video"] }
  ]
}
```

Replicate requests take `image` and `audio` data URIs, optional `prompt`, and `fast_mode`. OpenRouter requests take `frame_images` containing first/last frame data URIs, `prompt`, `duration`, `resolution`, and `aspect_ratio`. Audio generation is disabled for the latter. Local filesystem paths and arbitrary input URLs are not accepted by these adapters. Existing gateway body-size limits still apply.

Provider API origins are fixed. Redirects are rejected. Download hosts are restricted to the provider API and provider-owned delivery domains; bearer credentials are attached only to the API origin. Unknown CDN hosts fail closed and require a reviewed adapter update. Jobs stop polling after ten minutes or client cancellation; already-submitted provider work may still complete and incur charges. Submission is not retried automatically.

This lane requires a real provider canary before production use. Tests with mocked providers establish request translation, polling, and credential boundaries, not video quality or production availability.

### Replace an interval with LTX 2.3 Pro

An additive `kind: "video"` model with `upstreamModel: "lightricks/ltx-2.3-pro"`
supports `task: "retake"`. Send `video` as an MP4 data URI, `prompt`,
`retake_start_time` (seconds, at least zero), and `retake_duration` (2–20 seconds).
The adapter fixes `retake_mode` to `replace_video` and resolution to `1080p`.
`aspect_ratio` accepts `16:9` (default) or `9:16`; `fps` accepts 24 (default), 25,
48, or 50. Prepare the input with the correct aspect ratio and ensure the edited
interval fits within its duration.

Retake regenerates a section with the surrounding video as context. It is not an
extension API with a separately pinned end frame. This route rejects image/frame
inputs and `task: "extend"` rather than silently forwarding unsupported controls.
The caller must inspect the returned duration, context preservation, and joins.

```json
{
  "model": "cloud/replicate/ltx-retake",
  "task": "retake",
  "video": "data:video/mp4;base64,...",
  "prompt": "She returns naturally to her relaxed standing pose.",
  "retake_start_time": 2,
  "retake_duration": 2,
  "aspect_ratio": "16:9",
  "fps": 24
}
```

Contract: [Replicate LTX 2.3 Pro](https://replicate.com/lightricks/ltx-2.3-pro/readme).

Upstream contracts: https://replicate.com/bytedance/omni-human-1.5 and https://openrouter.ai/docs/guides/overview/multimodal/video-generation
