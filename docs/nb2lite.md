# Nano Banana 2 Lite through OpenRouter

Use `nb2lite` or `cloud/openrouter/nb2lite` with LLooM's image-generation endpoint.
Both aliases select `google/gemini-3.1-flash-lite-image` on OpenRouter.

Merge [the config fragment](../examples/nb2lite-openrouter.json) into an existing
file-backed LLooM config: add its backend and aliases to the corresponding maps,
and append its model entry to the `models` array. The gateway service must have
`OPENROUTER_API_KEY` in its environment. Config hot reload makes the external
model callable without loading local weights or changing existing defaults.

Send an authenticated request to `POST /v1/images/generations`:

```json
{
  "model": "nb2lite",
  "prompt": "A small yellow banana on a solid blue background, flat illustration",
  "n": 1,
  "size": "1024x1024",
  "response_format": "b64_json"
}
```

The image is returned in `data[0].b64_json`. This model supports one image per
request at 1K resolution, with several aspect ratios. The example declares
text-to-image generation; LLooM multipart image editing is not qualified here.

OpenRouter accepts the existing `/api/v1/images/generations` compatibility path,
so LLooM's standard image proxy handles this provider without an adapter.
Its dedicated documented endpoint is `POST /api/v1/images`.

Sources: [provider capabilities](https://openrouter.ai/google/gemini-3.1-flash-lite-image/providers),
[OpenRouter image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation).
