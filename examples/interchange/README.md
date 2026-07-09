# LLooM Interchange Examples

These files are small, copyable examples of the LLooM v1 interchange profile:

- `interchange-registry.v1.json`: machine-readable registry of schema IDs, media types, endpoint contracts, and extension policy.
- `recipe.v1.json`: one portable setup recipe.
- `recipe-index.v1.json`: one catalog/index document.
- `benchmark-suite.v1.json`: benchmark evidence with methodology and workload metadata.
- `benchmark-submission-response.v1.json`: typed receipt returned by benchmark submission endpoints.
- `backend-catalog.v1.json`: backend runtime-family metadata that recipes can target.
- `client-integrations.v1.json`: discovery metadata for clients connecting to a local LLooM gateway.
- `machine-profile.v1.json`: portable hardware profile for recommendation matching.
- `recommendation-request.v1.json`: host request for recipe-pack recommendations from a full machine profile.
- `recommendation-response.v1.json`: host response recommending recipe packs for a machine profile.
- `recipe-pack.v1.json`: a self-contained pack with index metadata, recipe content, and benchmark evidence.
- `recipe-pack-submission-response.v1.json`: typed receipt returned by recipe-pack submission endpoints.
- `signing-keys.v1.json`: public Ed25519 key set for verifying signed recipe packs and recommendation feeds.
- `error-response.v1.json`: typed non-2xx public error response.
- `validation-report.v1.json`: typed output from LLooM-compatible validators and CI checks.

Validate any example with:

```zsh
node bin/lloom.mjs interchange validate examples/interchange/recipe-pack.v1.json
```

The pack example is intentionally unsigned. Public feeds should sign recipe packs with Ed25519 and publish trusted keys through a `signing-keys.v1` document, normally served at `/v1/keys`.
