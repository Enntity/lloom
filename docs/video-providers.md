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

Upstream contracts: https://replicate.com/bytedance/omni-human-1.5 and https://openrouter.ai/docs/guides/overview/multimodal/video-generation
