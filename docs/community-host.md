# LLooM Host

`lloom-host` is the community metadata service. It is separate from the local LLooM gateway and should not participate in local model inference.

## Responsibilities

- Store recipe records, recipe-pack releases, benchmark evidence, publisher metadata, signing keys, trust policy, and moderation state.
- Accept benchmark submissions from local LLooM installs or maintainers, normalize them, and expose leaderboard views.
- Build machine-profile recommendations from submitted evidence and publish them as signed recipe-pack URLs.
- Publish recipe runtime intent precise enough for local LLooM to derive command lines, backend base URLs, health checks, warmup requests, session-cache settings, and client-visible model metadata.
- Serve public read APIs that local LLooM, a desktop UI, or docs can query without learning backend-specific setup details.

## Non-Responsibilities

- Proxying `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, image, audio, or embeddings traffic.
- Starting MTPLX, MLX, llama.cpp, Ollama, vLLM, image, or audio runtimes.
- Managing local memory, GPU pressure, KV/session cache, eviction policy, keep-warm state, or per-user model registries.
- Writing local LLooM config directly.

The local gateway owns all of those machine-local decisions.

## Minimal Public API

These paths are the initial contract the local gateway can consume:

- `GET /v1/interchange` and `GET /.well-known/lloom-interchange`: machine-readable interchange registry.
- `GET /v1/recipes`: searchable recipe metadata.
- `GET /v1/backends`: lightweight searchable backend-family index that recipes can reference.
- `GET /v1/backends/catalog`: full `backend-catalog.v1` document with setup actions, platform support, command expectations, and server contracts.
- `GET /v1/leaderboard`: benchmark leaderboard filtered by model family, backend, hardware, context, and workload.
- `POST /v1/recipe-packs`: recipe-pack submission intake.
- `POST /v1/benchmarks`: benchmark submission intake.
- `GET /v1/recipe-packs/recommended`: returns a `recommendation-response.v1` document for query-derived machine-profile hints.
- `POST /v1/recipe-packs/recommended`: accepts a `recommendation-request.v1` document with a full `machine-profile.v1` and returns a `recommendation-response.v1`.
- `GET /v1/recipe-packs/:id`: returns one signed recipe pack JSON document.
- `GET /v1/keys`: returns active public signing keys and key rotation metadata as `signing-keys.v1`.

The interchange registry should conform to `https://lloom.dev/schemas/interchange-registry.v1.schema.json` and use `application/vnd.lloom.interchange-registry+json;version=1`. Backend catalogs should conform to `https://lloom.dev/schemas/backend-catalog.v1.schema.json` and use `application/vnd.lloom.backend-catalog+json;version=1`. Machine profiles should conform to `https://lloom.dev/schemas/machine-profile.v1.schema.json`. Recommendation requests should conform to `https://lloom.dev/schemas/recommendation-request.v1.schema.json` and use `application/vnd.lloom.recommendation-request+json;version=1`. Recommendation responses should conform to `https://lloom.dev/schemas/recommendation-response.v1.schema.json` and include either inline recipe packs or URLs to recipe packs. Recipe-pack responses should conform to `https://lloom.dev/schemas/recipe-pack.v1.schema.json`, use `application/vnd.lloom.recipe-pack+json;version=1`, and declare `https://lloom.dev/profiles/interchange/v1`; recipe-pack submission receipts should conform to `https://lloom.dev/schemas/recipe-pack-submission-response.v1.schema.json` and use `application/vnd.lloom.recipe-pack-submission-response+json;version=1`. Signing key discovery should conform to `https://lloom.dev/schemas/signing-keys.v1.schema.json` and use `application/vnd.lloom.signing-keys+json;version=1`. Benchmark evidence should conform to `https://lloom.dev/schemas/benchmark-suite.v1.schema.json`; benchmark submission receipts should conform to `https://lloom.dev/schemas/benchmark-submission-response.v1.schema.json` and use `application/vnd.lloom.benchmark-submission-response+json;version=1`. Validator and CI output should conform to `https://lloom.dev/schemas/validation-report.v1.schema.json` and use `application/vnd.lloom.validation-report+json;version=1` when served over HTTP. Non-2xx public endpoint responses should conform to `https://lloom.dev/schemas/error-response.v1.schema.json` and use `application/vnd.lloom.error-response+json;version=1`. The full interchange contract, extension policy, examples, and signing rules are in `docs/interchange.md`.

For public publication, the host should reject hard validation errors and either reject or explicitly quarantine documents with `conformanceWarnings`. Local LLooM keeps those warnings non-fatal so developers can test draft packs, but community feeds should be stricter.

## Production MVP

The production MVP is a public, read-only catalog with a small browseable site at
`/`. It serves signed packs and benchmark evidence but does **not** accept public
HTTP contributions. Recipe and benchmark proposals enter through a GitHub pull
request, are reviewed and reproduced in isolation, then are signed into a new
release. See [`../deploy/community/README.md`](../deploy/community/README.md) for
the isolated Hetzner deployment and key-pinning requirements.

Remote clients must use HTTPS and a locally pinned trusted signing key. Keys
fetched from the host itself are useful for development diagnostics only; they are
not a production trust root.

## Static Development Host

The repository includes a small `lloom-host` binary that serves the minimal API from local JSON files. It is useful for local development, demos, and validating the local gateway's community import path before a database-backed hosted service exists. In this checkout it serves seed community data from `community/` by default. Source checkouts can sign generated recipe packs with a local dev key under `community/keys/`; installed packages do not include private keys, so the static host generates a process-local ephemeral Ed25519 key for signed demo packs when no configured private key is present. `recipes/` remains the local import cache used by offline setup and by guarded imports.

```zsh
lloom-host serve --port 8110
```

Useful options:

```zsh
lloom-host serve \
  --backend-catalog backends/catalog.json \
  --index community/recipes/index.json \
  --recipes-root community/recipes \
  --benchmarks-root community/benchmarks \
  --submissions-root data/benchmark-submissions \
  --publisher lloom-host
```

Add `--key-id`, `--private-key`, and optional `--public-key` to override the configured signing key. Without an available private key, the static host uses an ephemeral process-local development key and exposes the matching public key at `GET /v1/keys`; signatures from that mode prove package integrity for the current host process but are not production trust material.

Local LLooM consumes `GET /v1/keys` automatically during community onboarding and imports. When `trustHostKeys` is enabled, keys from that feed are passed as trusted keys while validating the recommended recipe pack, so `signature.trusted` should be true for packs signed by the host's active key. Set `--no-trust-host-keys` or `trustHostKeys: false` to inspect a feed without treating host-published keys as trusted roots.

The static development host can validate recipe-pack submissions at `POST /v1/recipe-packs` and benchmark submissions at `POST /v1/benchmarks` only when `communityHost.submissionsEnabled` is explicitly true. It should never be exposed publicly in that mode. Production always disables those endpoints and uses reviewed GitHub pull requests instead.

It also serves the interchange registry:

```zsh
curl -H 'accept: application/vnd.lloom.interchange-registry+json;version=1' \
  http://127.0.0.1:8110/v1/interchange
```

Local LLooM submits recipe packs through a guarded flow:

```zsh
lloom recipe-export apple-silicon-qwen36 --output pack.json --apply --yes
lloom recipe-submit pack.json --host http://127.0.0.1:8110
lloom recipe-submit pack.json --host http://127.0.0.1:8110 --apply --yes
```

Local LLooM submits benchmark evidence through the same guarded flow used for other write-like operations:

```zsh
lloom benchmark-submit benchmarks/community/apple-silicon-qwen36-m2max.json \
  --host http://127.0.0.1:8110

lloom benchmark-submit benchmarks/community/apple-silicon-qwen36-m2max.json \
  --host http://127.0.0.1:8110 \
  --apply --yes
```

The local gateway can ask the host for machine-specific recommendations:

```zsh
lloom onboard --host https://community.example
lloom community --host https://community.example
lloom community-import --host https://community.example --apply --yes
```

`onboard --host` is the zero-to-running path: the dry-run plan uses the host recommendation and the host backend catalog immediately, and the apply path imports the selected recipe pack before running local setup. `community` and `community-import` remain lower-level tools for inspecting or syncing the recommendation cache separately.

The direct host endpoint accepts simple query parameters derived from a machine profile:

```zsh
curl -H 'accept: application/vnd.lloom.recommendation-response+json;version=1' \
  'http://127.0.0.1:8110/v1/recipe-packs/recommended?platform=darwin-arm64&memory_gb=96&accelerator=apple-gpu&gpu_count=1&gpu_vendor=apple&gpu_backend=metal&limit=1'
```

Hardware query fields are lossy hints derived from `machine-profile.v1`: `platform`, `arch`, `memory_gb`, `cpu`, repeated `accelerator`, plus optional `gpu_count`, `gpu_vendor`, `gpu_backend`, `gpu_name`, and `gpu_memory_gb`. `memory_gb` should be included when known. If it is omitted, the host treats memory as unknown instead of `0 GB`; memory-gated recipes can still be recommended with `evaluation.memorySupported: null` and an explicit reason such as `memory unknown; recipe requires 80 GB`. Known insufficient memory remains non-selectable. The response echoes the normalized `machineProfile` used for matching.

Interoperable clients should prefer the full recommendation request document:

```zsh
curl -sS -X POST http://127.0.0.1:8110/v1/recipe-packs/recommended \
  -H 'content-type: application/vnd.lloom.recommendation-request+json;version=1' \
  -H 'accept: application/vnd.lloom.recommendation-response+json;version=1' \
  --data @examples/interchange/recommendation-request.v1.json
```

`recommendation-request.v1` carries the full `machineProfile`, optional `request.filters` for `workloads`, `capabilities`, and `tags`, and optional `limit`. Public hosts should return `error-response.v1` with status `400` when a canonical request document is invalid.

Recommendation requests may also include repeated or comma-separated `workload`, `capability`, and `tag` filters:

```zsh
curl -H 'accept: application/vnd.lloom.recommendation-response+json;version=1' \
  'http://127.0.0.1:8110/v1/recipe-packs/recommended?platform=darwin-arm64&memory_gb=96&accelerator=apple-gpu&workload=agentic-coding&capability=tools&capability=reasoning&tag=coding-agent&limit=1'
```

The response echoes the normalized `machineProfile`, includes `recommendationCount`, and lists ranked recipe-pack recommendations with `request`, `score`, `evaluation`, and `benchmark` fields. `request` records the filters the host optimized for, `evaluation.selection` explains compatibility, benchmark, and filter matching, while `benchmark` points at the best machine-matched evidence result from the host leaderboard. Hosts rank benchmark evidence by machine similarity first, then raw benchmark score, and expose the decision in `benchmark.machineMatch`.

or over the running gateway:

```zsh
curl -sS 'http://127.0.0.1:8100/gateway/community/recommendations?host=https%3A%2F%2Fcommunity.example'
curl -sS 'http://127.0.0.1:8100/gateway/onboarding/plan?host=https%3A%2F%2Fcommunity.example&require_signature=true'
curl -sS -X POST http://127.0.0.1:8100/gateway/community/import \
  -H 'content-type: application/json' \
  -d '{"host":"https://community.example","requireSignature":true,"yes":true}'
```

It can also consume a specific pack URL through:

```zsh
lloom recipe-import https://community.example/v1/recipe-packs/<id> --require-signature
```

or:

```zsh
curl -sS -X POST http://127.0.0.1:8100/gateway/recipe-packs/plan \
  -H 'content-type: application/json' \
  -d '{"source":"https://community.example/v1/recipe-packs/<id>","requireSignature":true}'
```

## Data Flow

```mermaid
flowchart LR
  Local["Local LLooM"] --> Profile["Machine profile"]
  Profile --> Host["lloom-host"]
  Host --> Pack["Signed recipe pack"]
  Pack --> Import["Local guarded import"]
  Import --> Index["Local recipe index"]
  Index --> Setup["Local setup plan"]
  Setup --> Runtime["Local runtimes"]
```

The hosted service improves the recommendation data. The local gateway remains the authority for what is installed, advertised, started, warmed, evicted, and routed on the user's machine.
