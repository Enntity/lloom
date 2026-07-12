# Architecture

LLooM keeps these local contracts separate:

1. Backend catalog: runtime-family metadata, setup checks, protocol paths, and feature flags.
2. Registry: model IDs, aliases, capability metadata, context limits, and backend bindings.
3. Runtime manager: local process lifecycle, health checks, warmup, keep-warm bootstrapping, and stop requests.
4. API bridge: OpenAI-compatible and Anthropic-compatible HTTP surfaces.

The hosted LLooM service is not part of that local request path. It is a separate recipe/benchmark/community service that publishes signed recipe packs and leaderboard metadata. The local gateway may fetch and import those packs, but it never sends model requests through the host and the host never starts local backends or manages local memory.

The gateway never guesses a stale model ID. If a client asks for an unknown model, it receives a 404. If a client needs to discover models, it should read `GET /v1/models` or generated client configuration.

## Request Flow

1. Authorize the route (`src/security.mjs`):
   - `/health`, `/`, and `/gateway/dashboard` are public.
   - Loopback binds may allow missing auth when `security.allowMissingAuth` is true (default for local DX).
   - Non-loopback binds always require a configured API key for inference and admin reads.
   - Admin writes (`POST /gateway/*`) on non-loopback binds are denied unless `security.allowRemoteAdmin` is explicitly true **and** a valid API key is present.
2. Resolve `body.model` through the registry.
3. Acquire a concurrency slot for the model's runtime if the model has one.
4. Start or verify the configured runtime if the model has one.
5. Forward the request to the backend using the model's `upstreamModel`.
6. Return the upstream stream or response body with gateway-safe headers.

OpenAI Responses and Anthropic Messages bridges live in pure modules under `src/protocol/` so request/response transforms can be unit-tested without the HTTP server.

## Security Defaults

| Setting | Default | Meaning |
|---------|---------|---------|
| `security.allowMissingAuth` | `true` | On loopback only, inference may omit the API key |
| `security.allowRemoteAdmin` | `false` | Block `POST /gateway/*` when bound off loopback |
| `security.allowNonLoopbackBind` | `false` | Refuse `listen()` on non-loopback hosts unless true |
| `security.allowWildcardCors` | `false` | Non-loopback CORS origin is `null` unless enabled |
| `security.apiKeys` | `["sk-lloom-local"]` in default config | Inference Bearer / `x-api-key` values |
| `security.adminApiKeys` | `[]` | When non-empty, admin routes require these keys even on loopback |
| `logging.requestLog` | `false` | Append NDJSON request lines to `~/.lloom/logs/requests.ndjson` (or `LLOOM_REQUEST_LOG=1`) |

Prefer binding `server.host` to `127.0.0.1`. If you expose the gateway on a LAN or public interface, set `allowNonLoopbackBind`, strong API keys, keep `allowRemoteAdmin` false unless you intentionally operate remote admin, and treat install/start endpoints as privileged. `GET /gateway/security` returns public auth metadata (no secrets) for dashboards.

## API Surface

LLooM currently fronts these local contracts:

- `GET /v1/models`
- `GET /v1/integrations`
- `GET /gateway/status`
- `GET /gateway/profile`
- `GET /gateway/integrations`
- `GET /gateway/runtimes/plan`
- `GET /gateway/metrics`
- `GET /gateway/metrics?model=<model-id>`
- `GET /gateway/metrics/models/:model-id`
- `POST /gateway/runtimes/:id/start`
- `POST /gateway/runtimes/:id/admit`
- `POST /gateway/runtimes/:id/warmup`
- `POST /gateway/runtimes/:id/stop`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`
- `POST /v1/messages`
- `POST /v1/images/generations`
- `POST /v1/audio/speech`
- `POST /v1/audio/transcriptions`
- `GET /gateway/onboarding/plan`
- `POST /gateway/onboarding/apply`
- `GET /gateway/setup/status`
- `GET /gateway/doctor`
- `GET /gateway/community/recommendations`
- `POST /gateway/community/import`
- `POST /gateway/recipe-packs/plan`
- `POST /gateway/recipe-packs/import`

`/v1/chat/completions` is an OpenAI-compatible chat bridge. LLooM rewrites the request model to the selected backend `upstreamModel`, but non-streaming JSON responses and streaming chat chunks expose the originally requested gateway model ID back to the client. That keeps local aliases and community recipe IDs stable for tools while still letting recipes target backend-specific model names. Upstream usage fields are preserved for responses and parsed from streaming usage chunks for metrics.

`/v1/responses` is implemented as a bridge over chat-completions backends. It normalizes `input`, `instructions`, `max_output_tokens`, `output_text`, `tools`, `tool_choice`, function-call outputs, reasoning hints, and usage fields, and translates chat SSE into Responses-style streaming events with ordered `sequence_number` fields, reasoning text deltas, function-call argument deltas, and `response.incomplete` events for output-cap truncation.

`/v1/messages` is implemented as an Anthropic Messages bridge over OpenAI-compatible chat-completions backends. It converts Anthropic text, image, `thinking`, `redacted_thinking`, `tools`, `tool_choice`, assistant `tool_use`, and user `tool_result` blocks into the matching OpenAI chat shapes, then maps OpenAI reasoning, text, and function-call responses back into Anthropic `thinking`, `text`, and `tool_use` content blocks. Streaming reasoning chunks are emitted as Anthropic `thinking_delta` events, streaming function-call chunks are emitted as Anthropic `input_json_delta` events, and usage is normalized from either chat-completions token names or Responses-style `input_tokens` / `output_tokens` fields.

`/v1/embeddings` proxies OpenAI-compatible embedding requests to models with `kind: "embedding"`, rewrites the selected gateway model to the upstream model ID, and preserves upstream usage fields.

`/v1/audio/speech` proxies OpenAI-compatible speech-generation requests to models with `kind: "audio_speech"`. Raw upstream responses are forwarded as bytes so audio containers are not coerced through text decoding. JSON bodies accept OpenAI fields plus Qwen extensions (`instructions`/`instruct`, `ref_audio`, `ref_text`, `language`/`lang_code`); `instructions` is mirrored to `instruct` for mlx-audio. Multipart form-data is also accepted so clients can upload `ref_audio` for voice cloning.

Speech discovery (no inference required):

- `GET /v1/audio/speech/models` — catalog of speech models with mode/family/capability summary
- `GET /v1/audio/voices?model=` — voices + OpenAI voice aliases for CustomVoice models
- `GET /v1/audio/speech/schema?model=` — parameter schema, examples, and content types for a model
- `GET /v1/models` metadata includes `tts` / `stt` / `speech` / `transcription` discovery blocks

`/v1/audio/transcriptions` proxies OpenAI-compatible transcription requests to models with `kind: "audio_transcription"`. Multipart form-data bodies are forwarded as bytes while the `model` part is rewritten to the selected upstream model ID, including when the gateway default transcription model is used. `GET /v1/audio/transcriptions/schema?model=` exposes STT parameters.

Qwen3-TTS is modeled as three advertised model IDs (CustomVoice, VoiceDesign, Base/clone). Clients pick a model from the catalog, then call the same OpenAI speech endpoint with the params that model's schema advertises.

### Named voice profiles

Installed under `~/.lloom/voices/<id>/` (`profile.json` + `reference.wav`). These are first-class OpenAI `voice` values for ICL clone recipes:

```bash
lloom voice-install jinx --ref ./clip.wav --ref-text "exact transcript" --apply --yes
lloom voices
# Client:
curl -X POST http://127.0.0.1:8100/v1/audio/speech \
  -d '{"voice":"jinx","input":"Hello"}'
```

The gateway expands `voice: "jinx"` into the profile model, on-disk `ref_audio`, `ref_text`, and default sampling knobs. `GET /v1/audio/voices` lists model speakers and installed profiles together.

`/gateway/onboarding/plan` is the first-run product surface. It composes setup planning and doctor verification into one install-from-zero report with stages for machine inspection, config, backend, model artifacts, agent clients, optional keep-warm runtime startup, and verification. `lloom onboard` and `lloom up` return the same contract.

`/gateway/setup/status` reports first-run and resume readiness for dashboards and automation. It joins recipe/backend plans with installer state, model directories, client integration file matches, and optional keep-warm runtime health.

`/gateway/doctor` wraps setup status into a product-readiness report. It separates hard `blockers` from non-fatal `warnings`, groups install state into registry, recipe, backend, models, client, runtime, and benchmark phases, and returns ordered next actions that a UI can show directly.

`/gateway/metrics` is an in-memory operational feed for dashboards, local tuning, and recipe evidence gathering. Model-facing routes record requested model ID, resolved model ID, upstream model ID, kind, backend, runtime, status, stream flag, duration, first-content latency, last-content latency, response bytes, and normalized usage when the upstream reports it. Each streaming decode measurement follows the Spark Arena / `llama-benchy` timing convention: `(generated tokens - 1) / (last content token time - first content token time)`. The displayed idle rate is the arithmetic mean of the latest ten completed measurements. LLooM uses reported output tokens when available and otherwise estimates them from observed output characters; `estimatedDecodeSamples` makes that fallback explicit. Non-streaming responses and zero-output operations are excluded because LLooM cannot observe their token-by-token decode interval; their tokens and end-to-end duration remain available in the other aggregate fields. Client disconnects before completion are recorded as status `499` so local timeouts do not look like backend crashes. The endpoint aggregates totals by model and route while retaining a bounded recent-request window; it is intentionally process-local so fresh benchmark submissions still come from explicit recipe/benchmark artifacts.

## CLI Surface

Primary commands (`lloom help`): `up`, `doctor`, `serve`, `models`, `integrate`, `add-model`.  
Advanced commands (`lloom help advanced`) cover backends, runtimes, recipes, community, and interchange.

Command dispatch lives in `bin/lloom.mjs` as a `handlers` map keyed by canonical command name (aliases resolve through `COMMAND_REGISTRY` then point at the same handler).

The CLI exposes the same runtime controls without requiring an already-running gateway:

- `lloom runtimes [runtime-id|all]`
- `lloom runtime-plan [runtime-id]`
- `lloom runtime-admit <runtime-id>`
- `lloom runtime-start <runtime-id>`
- `lloom runtime-warmup <runtime-id>`
- `lloom runtime-stop <runtime-id>`
- `lloom keep-warm`

## Runtime Policy

Runtime definitions include command, args, cwd, env, health URL, timeout, port, warmup request, `maxConcurrency`, and optional backend features such as `sessionCache`. Model-facing routes acquire a runtime slot before contacting upstream. This lets MTPLX and other optimized text lanes run high concurrency while image, audio, or memory-heavy runtimes serialize with `maxConcurrency: 1`.

Runtime policy is deliberately separate from process lifecycle. Runtime definitions can declare `memoryGb`, `policy.priority`, and `policy.evictable`; `runtimePolicy` config sets the memory budget and protection rules. `lloom runtime-plan <runtime-id>` and `GET /gateway/runtimes/plan?runtime=<runtime-id>` return a dry-run admission plan with projected memory, start actions, safe stop candidates, protected active runtimes, and warnings. `lloom runtime-admit <runtime-id> --apply --yes` and `POST /gateway/runtimes/:id/admit` apply that plan through explicit guarded stop/start calls. Applied admissions run under a gateway-local admission lock, so concurrent requests re-plan after earlier evictions and starts complete. Model requests only invoke runtime admission automatically when `runtimePolicy.autoEvict` is true.

`sessionCache` is a generic LLooM policy block, but cache implementation is backend-specific. The runtime manager expands the policy into launch arguments for adapters that support it. MTPLX runtimes use `kind: "mtplx-ssd-session"` and are launched with `--ssd-session-cache`, `--ssd-session-cache-dir`, `--ssd-session-cache-max-size`, and `--ssd-session-cache-min-prefix-tokens` when configured. Unsupported adapters fail fast instead of silently ignoring a cache policy.

`/gateway/status` reports the configured `args`, computed `effectiveArgs`, `sessionCache`, `maxConcurrency`, `activeRequests`, and `queuedRequests` for each runtime so dashboards can distinguish a slow backend from local gateway queueing and verify the exact process launch recipe.

Model requests automatically ensure the bound runtime only when that runtime is `enabled`; manual admin `start` can force-start any configured runtime for setup and diagnostics.

`keepWarm` runtime IDs are started in the background after the gateway begins listening, but only when those runtimes are also `enabled`. This keeps the default config safe while allowing a completed recipe to opt into real prewarming.

Memory admission and eviction planning lives in `src/runtime-policy.mjs` so it can be tested without the HTTP server. Enforcement is guarded by `--apply --yes` or request-body `yes: true`, except for model-request auto-eviction when the user explicitly enables `runtimePolicy.autoEvict`.

## Recipe Policy

Recipes describe how a backend/model lane becomes runnable: prerequisites, downloads, tuning, runtime mapping, and benchmark evidence. The planner is pure and read-only. The guarded installer consumes the same plan, writes durable state, and never invents model IDs outside the registry.

Recipes should reference backend IDs from `backends/catalog.json`. That keeps model-specific recipes small while preserving a common adapter vocabulary for MTPLX, MLX, llama.cpp, Ollama, LM Studio, generic OpenAI-compatible servers, OptiQ, image backends, and CUDA-first servers such as vLLM.

Backend install state and recipe install state share `~/.lloom/install-state.json` by default, but use separate namespaces. Backend setup handles runtime-family prerequisites such as command checks, Python environments, package installs, source clones, CMake builds, platform-specific package managers, and command shims; recipe setup handles model artifacts, tuning, and gateway model/runtime mappings.

The recipe index is LLooM's local community library. `lloom library` joins that index with hardware profiling, backend readiness, benchmark evidence, and setup commands so a first-run user can accept the recommendation without learning the backend details.

Ad hoc model intake is separate from recipes. `lloom add-model` accepts a Hugging Face URL, Hugging Face repo ID, local model path, Ollama tag, LM Studio model ID, or explicit OpenAI-compatible endpoint, infers the backend family, allocates a backend port when LLooM manages the runtime, and returns a dry-run JSON plan plus the config diff. It is intentionally a developer CLI primitive: product UI can automate it, but the CLI remains the source of truth for setup actions.

The gateway exposes read-only planning endpoints for that same automation layer:

- `GET /gateway/library` returns the machine profile, ranked recipe candidates, benchmark-backed recipe index report, and selected compatible recipe.
- `GET /gateway/integrations` returns the versioned `client-integrations.v1` manifest for local tool discovery. `GET /v1/integrations` returns the same document for clients that only probe OpenAI-style roots.
- `GET /gateway/backends` and `GET /gateway/backends/:id/plan` return backend readiness and setup plans.
- `GET /gateway/community/recommendations` asks the configured or supplied `lloom-host` for a `recommendation-response.v1` document matched to the local `machine-profile.v1`, then returns local recipe-pack dry-run plans for the selected recommendations.
- `GET /gateway/doctor` returns the composed readiness report with phase status, blockers, warnings, and next actions.
- `GET /gateway/setup/plan` returns the composed setup dry-run, including generated config, backend setup, recipe install, client integration, port retargeting, and next commands.
- `POST /gateway/models/import-plan` returns the ad hoc model import dry-run for a Hugging Face URL, repo ID, local path, or Ollama tag.
- `POST /gateway/recipe-packs/plan` returns the dry-run import plan for a local pack file or HTTP(S) pack URL, including signature status and file actions.

These endpoints never write config, install backends, download models, or start runtimes. They are a UI-facing mirror of the guarded CLI plan contracts.

The write endpoints mirror the CLI guard as well. `POST /gateway/backends/:id/install`, `POST /gateway/onboarding/apply`, `POST /gateway/setup/apply`, `POST /gateway/models/import`, `POST /gateway/community/import`, and `POST /gateway/recipe-packs/import` refuse unless the JSON body contains `yes: true`. Backend install writes backend setup state and command shims; onboarding and setup apply may install backends, download models, write client integrations, verify readiness, and optionally start keep-warm runtimes; model import apply only writes the configured LLooM config; community import and recipe-pack import write recipes, the recipe index, and attached benchmark suites.

The built-in dashboard at `/` and `/gateway/dashboard` is intentionally static and dependency-free. It calls the planning endpoints for library/backend/setup/model intake, the guarded apply endpoints for explicit writes, the status endpoints for model/runtime state, and the runtime control endpoints for start/warmup/stop. It does not maintain a separate product model from the CLI.

## Host Boundary

`lloom-host` should be designed and deployed as a separate service. It owns:

- recipe database storage and search
- recipe-pack submission intake, signing workflow, and release moderation
- benchmark submission intake, normalization, deduplication, and leaderboard calculation
- `interchange-registry.v1` discovery of public schema IDs, media types, endpoint contracts, validation reports, error responses, and extension policy
- community publisher records, trust metadata, signing keys, and moderation
- hosted recipe-pack generation for `machine-profile.v1` hardware profiles and workload tags

It must not own local model routing, OpenAI/Anthropic API proxying, runtime process control, memory/KV-cache policy, or per-user model registries. Its portable output is a signed recipe pack URL or inline signed pack that the local gateway can preview with `lloom community` or `GET /gateway/community/recommendations`, then import through the same guarded recipe-pack path used for local files.

The current repository includes a static `lloom-host` development server that serves the initial host API directly from recipe, recipe-pack, and benchmark JSON files. It exposes `GET /v1/interchange` and `GET /.well-known/lloom-interchange` so independent tools can discover the public schemas and vendor media types programmatically. Benchmark intake returns `benchmark-submission-response.v1` receipts, recipe-pack intake returns `recipe-pack-submission-response.v1` receipts, and validators emit `validation-report.v1` so independent harnesses can distinguish validation, persistence, queueing, warnings, and rejection without depending on LLooM internals. A production host can replace the storage layer without changing the local gateway contract.

## Setup Policy

Setup composes initialization, backend setup, recipe setup, generated clients, and client integration writes into one audited plan. It does not bypass the lower-level safety gates: dry-run is the default, and real execution requires explicit `--apply --yes`. Bootstrap remains the lower-level backend/model/client phase for an existing config.

The default generated gateway port is `8100`; selected backend runtimes occupy the default backend range beginning at `8201`. `setup --port` and `setup --backend-port-range` retarget the generated provider URL, backend base URLs, runtime ports, health URLs, and warmup URLs together so custom port layouts remain internally consistent.
