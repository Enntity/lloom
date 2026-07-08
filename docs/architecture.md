# Architecture

Switchyard keeps three contracts separate:

1. Backend catalog: runtime-family metadata, setup checks, protocol paths, and feature flags.
2. Registry: model IDs, aliases, capability metadata, context limits, and backend bindings.
3. Runtime manager: local process lifecycle, health checks, warmup, keep-warm bootstrapping, and stop requests.
4. API bridge: OpenAI-compatible and Anthropic-compatible HTTP surfaces.

The gateway never guesses a stale model ID. If a client asks for an unknown model, it receives a 404. If a client needs to discover models, it should read `GET /v1/models` or generated client configuration.

## Request Flow

1. Authenticate if local auth is enabled.
2. Resolve `body.model` through the registry.
3. Start or verify the configured runtime if the model has one.
4. Forward the request to the backend using the model's `upstreamModel`.
5. Return the upstream stream or response body with gateway-safe headers.

## API Surface

Switchyard currently fronts these local contracts:

- `GET /v1/models`
- `GET /gateway/status`
- `POST /gateway/runtimes/:id/start`
- `POST /gateway/runtimes/:id/warmup`
- `POST /gateway/runtimes/:id/stop`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1/images/generations`
- `POST /v1/audio/speech`
- `POST /v1/audio/transcriptions`
- `GET /gateway/setup/status`

`/v1/responses` is implemented as a bridge over chat-completions backends. It normalizes `input`, `instructions`, `max_output_tokens`, `output_text`, `tools`, `tool_choice`, function-call outputs, and usage fields, and translates chat SSE into Responses-style streaming events including function-call argument deltas.

`/v1/messages` is implemented as an Anthropic Messages bridge over OpenAI-compatible chat-completions backends. It converts Anthropic text, image, `tools`, `tool_choice`, assistant `tool_use`, and user `tool_result` blocks into the matching OpenAI chat shapes, then maps OpenAI text and function-call responses back into Anthropic `text` and `tool_use` content blocks. Streaming function-call chunks are emitted as Anthropic `input_json_delta` events.

`/v1/audio/speech` proxies OpenAI-compatible speech-generation requests to models with `kind: "audio_speech"`. Raw upstream responses are forwarded as bytes so audio containers are not coerced through text decoding.

`/v1/audio/transcriptions` proxies OpenAI-compatible transcription requests to models with `kind: "audio_transcription"`. Multipart form-data bodies are forwarded as bytes while the `model` part is rewritten to the selected upstream model ID, including when the gateway default transcription model is used.

`/gateway/setup/status` reports first-run and resume readiness for dashboards and automation. It joins recipe/backend plans with installer state, model directories, client integration file matches, and optional keep-warm runtime health.

## CLI Surface

The CLI exposes the same runtime controls without requiring an already-running gateway:

- `switchyard runtimes [runtime-id|all]`
- `switchyard runtime-start <runtime-id>`
- `switchyard runtime-warmup <runtime-id>`
- `switchyard runtime-stop <runtime-id>`
- `switchyard keep-warm`

## Runtime Policy

Runtime definitions include command, args, cwd, env, health URL, timeout, port, and warmup request. Model requests automatically ensure the bound runtime only when that runtime is `enabled`; manual admin `start` can force-start any configured runtime for setup and diagnostics.

`keepWarm` runtime IDs are started in the background after the gateway begins listening, but only when those runtimes are also `enabled`. This keeps the default config safe while allowing a completed recipe to opt into real prewarming.

Memory admission and eviction policies should be added as independent modules so they can be tested without the HTTP server.

## Recipe Policy

Recipes describe how a backend/model lane becomes runnable: prerequisites, downloads, tuning, runtime mapping, and benchmark evidence. The planner is pure and read-only. The guarded installer consumes the same plan, writes durable state, and never invents model IDs outside the registry.

Recipes should reference backend IDs from `backends/catalog.json`. That keeps model-specific recipes small while preserving a common adapter vocabulary for MTPLX, MLX, llama.cpp, Ollama, OptiQ, image backends, and CUDA-first servers such as vLLM.

Backend install state and recipe install state share `data/install-state.json`, but use separate namespaces. Backend setup handles runtime-family prerequisites such as checks, command shims, and manual install notes; recipe setup handles model artifacts, tuning, and gateway model/runtime mappings.

## Setup Policy

Setup composes initialization, backend setup, recipe setup, generated clients, and client integration writes into one audited plan. It does not bypass the lower-level safety gates: dry-run is the default, and real execution requires explicit `--apply --yes`. Bootstrap remains the lower-level backend/model/client phase for an existing config.
