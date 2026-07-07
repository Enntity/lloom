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

`/v1/responses` is implemented as a bridge over chat-completions backends. It normalizes `input`, `instructions`, `max_output_tokens`, `output_text`, and usage fields, and translates chat SSE into Responses-style streaming events.

## Runtime Policy

Runtime definitions include command, args, cwd, env, health URL, timeout, port, and warmup request. Model requests automatically ensure the bound runtime only when that runtime is `enabled`; manual admin `start` can force-start any configured runtime for setup and diagnostics.

`keepWarm` runtime IDs are started in the background after the gateway begins listening, but only when those runtimes are also `enabled`. This keeps the default config safe while allowing a completed recipe to opt into real prewarming.

Memory admission and eviction policies should be added as independent modules so they can be tested without the HTTP server.

## Recipe Policy

Recipes describe how a backend/model lane becomes runnable: prerequisites, downloads, tuning, runtime mapping, and benchmark evidence. The planner is pure and read-only. The eventual installer should consume the same plan, write durable state, and never invent model IDs outside the registry.

Recipes should reference backend IDs from `backends/catalog.json`. That keeps model-specific recipes small while preserving a common adapter vocabulary for MTPLX, MLX, llama.cpp, Ollama, OptiQ, image backends, and CUDA-first servers such as vLLM.

Backend install state and recipe install state share `data/install-state.json`, but use separate namespaces. Backend setup handles runtime-family prerequisites such as checks, command shims, and manual install notes; recipe setup handles model artifacts, tuning, and gateway model/runtime mappings.

## Bootstrap Policy

Bootstrap composes backend setup, recipe setup, generated clients, and client integration writes into one audited plan. It does not bypass the lower-level safety gates: dry-run is the default, and real execution requires explicit `--apply --yes`.
