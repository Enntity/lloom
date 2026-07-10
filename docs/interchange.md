# Interchange Formats

LLooM interchange formats are meant to be portable, implementation-neutral JSON documents. A host, CLI, dashboard, benchmark harness, or third-party model catalog should be able to exchange these files without linking against LLooM internals.

## Core consumer profile (minimal)

Independent local gateways and tooling only need this **core set** to recommend and install models:

| Document | Role |
|----------|------|
| `machine-profile.v1` | Hardware profile of the local machine |
| `recommendation-response.v1` | Hosted (or offline) recipe-pack recommendation |
| `recipe-pack.v1` | Signed bundle of recipes + benchmarks |
| `signing-keys.v1` | Public keys used to verify pack signatures |
| `error-response.v1` / `validation-report.v1` | Portable errors and CI validation |

Everything else in the schema tree remains valid and useful for hosts, dashboards, and advanced automation, but is **not** required to implement a minimal LLooM-compatible client. Prefer growing consumers against the core profile before inventing new document kinds.

## Format Set

The versioned schemas live under `schemas/`:

- `common.v1.schema.json`: shared IDs, links, publisher, license, provenance, capability, and machine definitions.
- `interchange-registry.v1.schema.json`: machine-readable registry of schema IDs, media types, endpoint contracts, and extension policy.
- `backend-catalog.v1.schema.json`: backend runtime-family metadata that recipes can target.
- `client-integrations.v1.schema.json`: local gateway discovery metadata for OMP, OpenCode, Codex-compatible, Claude-compatible, Hermes, Zero, and other clients.
- `machine-profile.v1.schema.json`: hardware profile used to match a machine to local recipes.
- `recommendation-request.v1.schema.json`: hosted request asking for recipe-pack recommendations for a full machine profile.
- `recommendation-response.v1.schema.json`: hosted response recommending recipe packs for a machine profile.
- `recipe.v1.schema.json`: one backend/model setup recipe.
- `recipe-index.v1.schema.json`: a searchable list of recipe entries.
- `benchmark-suite.v1.schema.json`: measured model/backend evidence.
- `benchmark-submission-response.v1.schema.json`: portable receipt returned by LLooM-compatible benchmark submission endpoints.
- `recipe-pack.v1.schema.json`: a bundle containing recipe entries, recipes, benchmark suites, and optional signatures.
- `recipe-pack-submission-response.v1.schema.json`: portable receipt returned by LLooM-compatible recipe-pack submission endpoints.
- `signing-keys.v1.schema.json`: public Ed25519 key discovery document for verifying signed recipe packs and recommendation feeds.
- `error-response.v1.schema.json`: portable non-2xx error body for public LLooM-compatible endpoints.
- `validation-report.v1.schema.json`: portable validator and CI result for LLooM-compatible interchange documents.

Canonical schema IDs:

- `https://lloom.dev/schemas/common.v1.schema.json`
- `https://lloom.dev/schemas/interchange-registry.v1.schema.json`
- `https://lloom.dev/schemas/backend-catalog.v1.schema.json`
- `https://lloom.dev/schemas/client-integrations.v1.schema.json`
- `https://lloom.dev/schemas/machine-profile.v1.schema.json`
- `https://lloom.dev/schemas/recommendation-request.v1.schema.json`
- `https://lloom.dev/schemas/recommendation-response.v1.schema.json`
- `https://lloom.dev/schemas/recipe.v1.schema.json`
- `https://lloom.dev/schemas/recipe-index.v1.schema.json`
- `https://lloom.dev/schemas/benchmark-suite.v1.schema.json`
- `https://lloom.dev/schemas/benchmark-submission-response.v1.schema.json`
- `https://lloom.dev/schemas/recipe-pack.v1.schema.json`
- `https://lloom.dev/schemas/recipe-pack-submission-response.v1.schema.json`
- `https://lloom.dev/schemas/signing-keys.v1.schema.json`
- `https://lloom.dev/schemas/error-response.v1.schema.json`
- `https://lloom.dev/schemas/validation-report.v1.schema.json`

Recommended media types:

- `application/vnd.lloom.recipe+json;version=1`
- `application/vnd.lloom.interchange-registry+json;version=1`
- `application/vnd.lloom.backend-catalog+json;version=1`
- `application/vnd.lloom.client-integrations+json;version=1`
- `application/vnd.lloom.machine-profile+json;version=1`
- `application/vnd.lloom.recommendation-request+json;version=1`
- `application/vnd.lloom.recommendation-response+json;version=1`
- `application/vnd.lloom.recipe-index+json;version=1`
- `application/vnd.lloom.benchmark-suite+json;version=1`
- `application/vnd.lloom.benchmark-submission-response+json;version=1`
- `application/vnd.lloom.recipe-pack+json;version=1`
- `application/vnd.lloom.recipe-pack-submission-response+json;version=1`
- `application/vnd.lloom.signing-keys+json;version=1`
- `application/vnd.lloom.error-response+json;version=1`
- `application/vnd.lloom.validation-report+json;version=1`

Hosts can expose a machine-readable registry at:

- `GET /v1/interchange`
- `GET /.well-known/lloom-interchange`

Those endpoints return `interchange-registry.v1`, which lists the document kinds, schema IDs, media types, lifecycle status, conformance level, endpoint request/response kinds, success status codes, validation-report contract, and error response contract. Standalone exchanged documents should include `$schema` when possible. Recipe packs exported by LLooM always include:

```json
{
  "$schema": "https://lloom.dev/schemas/recipe-pack.v1.schema.json",
  "schemaVersion": 1,
  "profile": "https://lloom.dev/profiles/interchange/v1"
}
```

## Conformance Profile

The public profile is:

```text
https://lloom.dev/profiles/interchange/v1
```

The repository copy is [docs/profiles/interchange-v1.md](profiles/interchange-v1.md). The extension policy advertised by the registry is [docs/profiles/extensions-v1.md](profiles/extensions-v1.md).

Normative words such as MUST, SHOULD, and MAY are used with their ordinary standards meaning: MUST is required for public interoperability, SHOULD is expected unless a producer has a specific compatibility reason, and MAY is optional behavior that consumers cannot assume.

A conforming v1 document MUST:

- Be UTF-8 JSON.
- Include `schemaVersion: 1`.
- Follow the matching schema ID when `$schema` is present.
- Use stable, URL-safe IDs for exchanged documents and recipe entries.
- Keep setup intent separate from execution permission. Importing a document must not run commands by itself.

Consumers MUST treat unknown `x-*` fields as extension fields and preserve them when republishing a document unless they intentionally transform it. Producers SHOULD NOT publish unprefixed custom fields; LLooM warns about them so future schema revisions can add real fields without colliding with vendor data.

Publication-quality documents SHOULD also include `profile`, `license`, `publisher`, `provenance`, and useful `links`. LLooM's validator reports these as `conformanceWarnings` rather than hard errors so older or local-only files remain usable.

The registry advertises three conformance levels:

- `parse`: a client can identify the document kind, `schemaVersion`, profile, and media type.
- `validate`: a client can validate the schema-specific fields, endpoint media types, and safety checks used by LLooM importers.
- `publish`: a producer includes publication metadata, provenance, extension discipline, and signatures where the format supports them.

Validator output SHOULD itself be portable. LLooM emits `validation-report.v1` with `$schema`, `schemaVersion`, `profile`, stable `id`, `validatedAt`, boolean `ok`, detected `kind`, canonical subject `schema`, recommended subject `mediaType`, `conformanceLevel`, `validationErrors`, and `conformanceWarnings`. Hosts and CI systems can store or exchange that report without depending on CLI text.

## Common Fields

The schema family shares these portable fields:

- `profile`: the conformance profile URL.
- `license`: SPDX expression or object describing the metadata license. This describes the recipe/benchmark metadata, not necessarily the model weights.
- `publisher`: string or object with `id`, `name`, optional `url`, and optional `contact`.
- `provenance`: who or what generated the document, optional source information, and optional source commit.
- `links`: typed links such as `model-card`, `benchmark`, `describedby`, `source`, or `download`.
- `capabilities`: vocabulary for machine routing and UI display, including `chat`, `responses`, `anthropic-messages`, `streaming`, `tools`, `reasoning`, `vision`, `image-generation`, `audio-speech`, `tts`, `mtp`, `moe`, `kv-cache-persistence`, and `long-context`.

Recipes should declare capabilities at the recipe level and, when model roles differ, on each `models[]` entry. Benchmark suites should declare `methodology`; individual results should declare `machine.accelerators` and `machine.devices` when hardware-specific backends affect results, and should declare `workload` when the result depends on prompt depth, generated token count, or concurrency.

Benchmark submission endpoints accept either one `benchmark-suite.v1` document or an envelope shaped as `{ "suites": [ ... ] }`. They SHOULD respond with `application/vnd.lloom.benchmark-submission-response+json;version=1` and a `benchmark-submission-response.v1` body with explicit `accepted`, `persisted`, `validationErrors`, `host.endpoint`, and per-suite `submissions[]` status fields. Public hosts should treat acceptance as intake for moderation or review, not automatic leaderboard publication.

Recipe-pack submission endpoints accept one `recipe-pack.v1` document. They SHOULD require `Content-Type: application/vnd.lloom.recipe-pack+json;version=1` for strict public APIs, SHOULD respond with `application/vnd.lloom.recipe-pack-submission-response+json;version=1`, and SHOULD return a `recipe-pack-submission-response.v1` body with explicit `accepted`, `persisted`, `validationErrors`, `host.endpoint`, and per-pack `submissions[]` status fields. Public hosts should treat acceptance as intake for signing, moderation, or review; published recommendation feeds should still serve signed recipe-pack URLs or inline signed packs.

Backend catalogs should declare one stable backend ID per runtime family, the supported platform IDs, user-facing setup steps, expected commands, and the server protocol paths LLooM should use for health checks and proxying. Consumers should expose setup audit metadata for every planned step, including risk, effects, network use, filesystem writes, and system-package changes. Recipes should reference those backend IDs rather than embedding backend-family metadata directly.

Client integration manifests should declare the local provider ID, gateway origin, OpenAI-compatible `/v1` base URL, Anthropic-compatible origin, auth style, supported protocols, provider feature booleans such as `streaming`, `usage`, `streamingUsage`, `tools`, and `reasoning`, concrete endpoint URLs, exact advertised model IDs, model modalities, and client artifact hints. Tools should prefer the manifest's exact model IDs over LLooM's route aliases.

Machine profiles should describe portable hardware traits only: platform, architecture, memory, CPU class, accelerator hints, structured compute devices, and platform ID. Use `devices[]` for GPU/NPU facts such as vendor, backend, name, memory, and compute capability; keep the top-level `accelerators[]` list as the compatibility-friendly routing vocabulary. Local absolute paths belong in `x-*` extension fields and should not be used by hosted recommendation services.

Recommendation request documents should include one full `machineProfile`, optional `request.filters` for workload, capability, and tag intent, and optional `limit`. Public hosts SHOULD accept `POST /v1/recipe-packs/recommended` with `application/vnd.lloom.recommendation-request+json;version=1` and SHOULD respond with `application/vnd.lloom.recommendation-response+json;version=1`.

Recommendation responses should echo the machine profile used for matching, include a deterministic `recommendationCount`, and provide either inline signed recipe packs or URLs to signed recipe packs. Hosts SHOULD include the request intent as workload, capability, and tag filters at top-level `request` and per recommendation when filters affect ranking. The response explains why a recipe was selected through `recommendations[].evaluation` and should expose the best machine-matched evidence through `recommendations[].benchmark`; `benchmark.machineMatch` should explain platform, accelerator, and memory similarity so raw tok/s from unrelated hardware does not dominate recommendations. Local LLooM still validates the pack before import.

Signing-key documents publish public Ed25519 keys used to verify recipe-pack signatures. Public hosts SHOULD serve `signing-keys.v1` at `GET /v1/keys` with `application/vnd.lloom.signing-keys+json;version=1`, stable `keyId` values, key status, and rotation metadata when available. Dev or package-local hosts MAY mark generated process-local keys with `ephemeral: true`; clients should treat those as current-process integrity keys, not public trust roots.

Public endpoints SHOULD return `error-response.v1` for non-2xx responses and SHOULD use `application/vnd.lloom.error-response+json;version=1`. The body keeps an OpenAI-like `error.message` field for simple clients, while also including `schemaVersion`, `profile`, `id`, `error.code`, `error.status`, optional `error.validationErrors`, and `host.endpoint` for generic interchange clients.

Validation endpoints, CLIs, and CI harnesses SHOULD return `validation-report.v1` and SHOULD use `application/vnd.lloom.validation-report+json;version=1` when the report is served over HTTP. A failed validation is represented by `ok: false` with non-empty `validationErrors`; it does not require a non-2xx transport response unless the validation service itself failed.

## Compatibility Rules

- `schemaVersion` is an integer wire-format version. Version `1` means the document follows the v1 schema family.
- Additive fields in a v1 schema are minor-compatible. Removing a field, changing a field's meaning, or changing required behavior requires a new major schema family.
- Registered documents include a lifecycle `status`: `draft`, `draft-stable`, `stable`, or `deprecated`. `draft-stable` means the LLooM project intends to preserve wire compatibility inside the current `schemaVersion`.
- Unknown properties are allowed for forward compatibility. Consumers MUST preserve unknown properties when republishing a document unless they intentionally transform it.
- Vendor or experimental fields MUST use the `x-` prefix for public interchange, for example `x-my-lab-score`.
- Producers SHOULD use stable IDs and avoid embedding machine-local absolute paths in shared documents.
- Consumers SHOULD reject documents with unsafe relative paths such as `../` traversal in recipe-pack index entries.
- Recipes and recipe packs are portable setup intent. They SHOULD NOT assume the consumer already has the referenced local runtime or model aliases configured.

## Conformance

Use LLooM's conformance checker before publishing a file:

```zsh
lloom interchange registry
lloom interchange validate pack.json
lloom validate pack.json
```

For signed feeds:

```zsh
lloom interchange validate pack.json \
  --trusted-key publisher=@publisher.pub \
  --require-signature
```

The checker emits `validation-report.v1` and reports the detected document kind, canonical schema ID, recommended media type, signature status for recipe packs, and validation errors. Recipe conformance intentionally checks the portable wire contract; local installability is checked later by `lloom plan`, `lloom install`, and `lloom setup`.

The checker separates:

- `validationErrors`: hard failures that make the document unsafe or internally inconsistent.
- `conformanceWarnings`: publication-quality issues such as missing provenance, missing profile URL, unsigned recipe packs, or non-`x-*` custom fields.

## Examples

Copyable examples live under `examples/interchange/`:

```zsh
lloom interchange validate examples/interchange/interchange-registry.v1.json
lloom interchange validate examples/interchange/recipe.v1.json
lloom interchange validate examples/interchange/recipe-index.v1.json
lloom interchange validate examples/interchange/backend-catalog.v1.json
lloom interchange validate examples/interchange/client-integrations.v1.json
lloom interchange validate examples/interchange/machine-profile.v1.json
lloom interchange validate examples/interchange/recommendation-request.v1.json
lloom interchange validate examples/interchange/recommendation-response.v1.json
lloom interchange validate examples/interchange/benchmark-suite.v1.json
lloom interchange validate examples/interchange/benchmark-submission-response.v1.json
lloom interchange validate examples/interchange/recipe-pack.v1.json
lloom interchange validate examples/interchange/recipe-pack-submission-response.v1.json
lloom interchange validate examples/interchange/signing-keys.v1.json
lloom interchange validate examples/interchange/error-response.v1.json
lloom interchange validate examples/interchange/validation-report.v1.json
```

The recipe-pack example is intentionally unsigned. Hosted public feeds should sign packs and make trusted publisher keys available separately.

## Signing

Recipe-pack signatures use Ed25519 over a canonical JSON payload:

1. Start with the recipe-pack document.
2. Remove `signatures` and non-wire runtime fields.
3. Recursively sort object keys lexicographically.
4. Omit properties whose value is `undefined`.
5. UTF-8 encode the resulting canonical JSON string.
6. Sign with Ed25519 and store base64 in `signatures[].signature`.

Generated signatures include:

```json
{
  "algorithm": "ed25519",
  "canonicalization": "lloom-canonical-json-v1"
}
```

LLooM accepts embedded `publicKey` values for self-contained development packs, but production feeds should distribute trusted public keys separately through `lloom-host` or local config.

## Recommended Flow

Contributor:

```zsh
lloom recipe-export apple-silicon-qwen36 --output pack.json
lloom recipe-export apple-silicon-qwen36 --output pack.json --apply --yes
lloom recipe-submit pack.json --host https://community.example
lloom recipe-submit pack.json --host https://community.example --apply --yes
lloom benchmark-submit benchmarks/community/apple-silicon-qwen36-m2max.json --host https://community.example
lloom benchmark-submit benchmarks/community/apple-silicon-qwen36-m2max.json --host https://community.example --apply --yes
```

Publisher:

```zsh
lloom recipe-export apple-silicon-qwen36 \
  --output pack.json \
  --key-id publisher \
  --private-key publisher.key \
  --public-key publisher.pub \
  --apply --yes
```

Consumer:

```zsh
lloom recipe-import pack.json --require-signature
lloom community --host https://community.example
lloom community-import --host https://community.example --apply --yes
```

Hosts should expose the full backend setup vocabulary as a `backend-catalog.v1` document:

```zsh
curl -H 'accept: application/vnd.lloom.backend-catalog+json;version=1' \
  https://community.example/v1/backends/catalog
```

## Boundary

Interchange formats describe setup intent and benchmark evidence. They do not grant permission to execute commands. Local LLooM still presents an audited setup plan and requires explicit apply confirmation before writing config, installing backends, downloading models, or starting runtimes.
