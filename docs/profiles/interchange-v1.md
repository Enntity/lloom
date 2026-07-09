# LLooM Interchange Profile v1

This profile defines the wire-level rules for LLooM-compatible JSON interchange documents. The canonical profile identifier is:

```text
https://lloom.dev/profiles/interchange/v1
```

Normative words such as MUST, SHOULD, and MAY are used with their ordinary standards meaning.

## Scope

The profile covers portable setup metadata, backend catalogs, client discovery manifests, machine profiles, recipe recommendations, recipe packs, benchmark evidence, validation reports, and public error responses. It does not grant permission to execute commands or start runtimes.

### Core vs extended

**Core (required for a minimal local consumer):**

- `machine-profile.v1`
- `recommendation-response.v1` (and optionally `recommendation-request.v1` when talking to a host)
- `recipe-pack.v1`
- `signing-keys.v1`
- `error-response.v1`, `validation-report.v1` when validating or handling HTTP errors

**Extended (hosts, catalogs, dashboards, advanced tooling):** backend catalogs, client-integrations manifests, recipe indexes, benchmark submission receipts, interchange-registry discovery, and submission-response documents.

## Document Requirements

A conforming v1 document MUST:

- Be encoded as UTF-8 JSON.
- Include `schemaVersion: 1`.
- Use the matching canonical schema ID when `$schema` is present.
- Use URL-safe stable IDs for documents, recipes, backends, clients, and benchmark suites.
- Treat unrecognized `x-*` fields as extension fields.
- Preserve unknown extension fields when republishing unless intentionally transforming the document.
- Keep setup intent separate from execution permission.

A public producer SHOULD:

- Include `profile: "https://lloom.dev/profiles/interchange/v1"`.
- Include license, publisher, provenance, and useful typed links.
- Use registered `application/vnd.lloom.*+json;version=1` media types.
- Publish a validation report before accepting or recommending submitted content.
- Sign recipe packs before publication.

## Versioning

`schemaVersion` is the major wire-format version. Additive fields in v1 documents are minor-compatible. Removing a field, changing a field's meaning, changing required behavior, or changing signature/canonicalization semantics requires a new major schema family.

The registry advertises document lifecycle status:

- `draft`: active exploration; shape can still move.
- `draft-stable`: expected to preserve v1 wire compatibility.
- `stable`: public compatibility commitment.
- `deprecated`: supported for reading, not recommended for new publication.

## Extension Policy

Public custom fields MUST use the `x-` prefix. Unprefixed custom fields are allowed by the schemas for local forward compatibility, but publication-quality validators SHOULD warn on them so future official fields can be added without collisions.

The detailed extension policy is described by:

```text
https://lloom.dev/profiles/extensions/v1
```

## Canonical JSON

`lloom-canonical-json-v1` means:

1. Recursively sort object keys lexicographically.
2. Omit properties whose value is `undefined`.
3. Preserve array order.
4. Serialize using JSON without insignificant whitespace.
5. UTF-8 encode the resulting string before hashing or signing.

Recipe-pack signatures use Ed25519 over this canonical payload after removing the `signatures` array.

## Conformance Levels

- `parse`: identify kind, schemaVersion, profile, and media type.
- `validate`: run schema-specific checks and LLooM safety checks.
- `publish`: include publication metadata, provenance, extension discipline, and signatures where supported.

Validators SHOULD emit a `validation-report.v1` document so automated consumers can rely on a stable `ok`, `kind`, `schema`, `mediaType`, `validationErrors`, and `conformanceWarnings` contract.
