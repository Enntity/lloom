# Provider capabilities for Enntity Runtime

LLooM owns upstream credentials; each Runtime needs only a gateway URL and its own normal inference key. Models, embeddings, image, audio, and video keep their existing gateway routes and backend configuration. Search and page extraction use authenticated web-function routes.

Add the provider section to the gateway configuration:

```json
{
  "web": {
    "search": {
      "endpoint": "https://www.googleapis.com/customsearch/v1",
      "apiKey": "${GOOGLE_CSE_KEY}",
      "cx": "${GOOGLE_CSE_CX}",
      "timeoutMs": 30000
    },
    "read": {
      "endpoint": "https://r.jina.ai",
      "apiKey": "${JINA_API_KEY}",
      "timeoutMs": 30000
    }
  }
}
```

The endpoints and timeouts shown are defaults and can be omitted. Provider keys may be literal local config values or existing `${ENV_VAR}` references. Environment values belong to the running gateway; rotating its parent shell's environment does not change that process. Atomic config edits are hot loaded by the existing watcher. New requests use the updated provider connection and active requests keep their captured connection. Setting a service's `enabled` to false disables it.

- `POST /v1/web/search`: JSON `q`, optional `num` (1–10), `dateRestrict`, `siteSearch`, `siteSearchFilter`, and `safe`. Returns titles, URLs, snippets, and estimated result count in a SearchResponse envelope.
- `POST /v1/web/read`: JSON `url` with an absolute HTTP(S) target. Returns extracted page content in the same envelope, capped at 40,000 characters with an explicit truncation flag.
- `GET /v1/capabilities`: versioned model/endpoint defaults, model alias configuration status, and web provider configuration status. It never returns upstream keys or private provider endpoints. Status is configuration readiness, not a live health assertion.

All three routes use normal inference authentication, including the existing policy for loopback and inference-disabled nodes. Clients cannot override upstream credentials or the configured search engine. Provider redirects are rejected, bodies are bounded, deadlines include body reads, and provider errors are sanitized while preserving numeric HTTP status and Retry-After. No local model admission is required for web requests.

## Shared defaults

`src/runtime-capabilities.json` is the versioned client contract, mirrored in Runtime for offline startup. Update both copies together; Runtime's `scripts/eval-lloom-config.mjs` checks exact parity and the real gateway HTTP path.

Explicit aliases always win. When the target exists, configuration loading supplies:

- `enntity-presence` from `defaults.presenceModel`, otherwise `defaults.chatModel`.
- `chat-capable` from `defaults.chatCapableModel`, otherwise an existing `cloud/openrouter/chat-capable` route. There is no inferred local fallback.
- `embedding` from `defaults.embeddingModel`.

These names are routing contracts, not assumptions that a particular model has been installed. Missing targets remain absent and are reported by capability discovery. Provider/model metadata and keys for OpenRouter and Replicate stay in their existing backend definitions; they are not duplicated in Runtime or in this web-provider section.

The shared `multimodal` perception alias uses `defaults.multimodalModel`, or the installed `google/gemini-3.1-flash-lite` route. An explicit alias is preserved. Runtime `InspectContent` forwards actual audio, video, images, and PDF using chat-completions content parts through this route; no new provider keys are needed in Runtime.
