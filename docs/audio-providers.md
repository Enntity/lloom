# Cloud music through OpenRouter

LLooM accepts music requests at `POST /v1/audio/generations`. Set an OpenAI-compatible backend's `audioProvider` to `openrouter` to use OpenRouter's streaming chat audio API. Ordinary audio backends keep their existing binary proxy behavior.

```json
{
  "backends": {
    "openrouter-music": {
      "type": "openai",
      "baseUrl": "https://openrouter.ai/api/v1",
      "audioProvider": "openrouter",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "timeoutMs": 600000
    }
  },
  "models": [{
    "id": "google/lyria-3-pro-preview",
    "backend": "openrouter-music",
    "upstreamModel": "google/lyria-3-pro-preview",
    "kind": "audio_generation"
  }],
  "aliases": {"music": {"members": ["google/lyria-3-pro-preview"]}},
  "defaults": {"audioGenerationModel": "music"}
}
```

Send `prompt` or `instructions`, optionally `lyrics`, `input`, and `duration` in seconds. Duration is a prompt instruction, not a guaranteed output length. `response_format` (or `format`) accepts `wav` or `mp3`, defaulting to WAV. One inline PNG/JPEG `image` or `reference_image` is supported. Remote image URLs, seeds, steps and other unsupported controls are rejected. Configured OpenRouter provider restrictions are preserved.

The adapter validates and buffers the provider SSE stream before returning audio bytes. It requires a completion marker or successful stop followed by clean EOF, bounds individual events and total output, and never automatically retries a billable generation. Cancellation and timeout cover both generation and conversion.

Install `ffmpeg` on the gateway host and ensure it is on the managed service's PATH. Some providers return MP3 even when WAV is requested; LLooM detects the actual format and converts it locally when necessary. Conversion takes buffered audio through pipes with network protocols disabled. No music model or GPU runtime is loaded on the gateway for cloud generation. The API responds with the requested audio format and matching Content-Type.

See the [OpenRouter audio documentation](https://openrouter.ai/docs/guides/overview/multimodal/audio) for the upstream contract.
