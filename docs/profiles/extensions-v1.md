# LLooM Extension Policy v1

This policy defines how LLooM-compatible interchange documents can carry vendor, lab, host, or experimental metadata without breaking portability. The canonical policy identifier is:

```text
https://lloom.dev/profiles/extensions/v1
```

## Rules

Public extension fields MUST start with `x-`.

Consumers MUST preserve unknown `x-*` fields when republishing a document unless they intentionally transform or redact the data. Consumers MAY ignore an extension for behavior decisions.

Producers SHOULD place implementation-specific metadata in shallow `x-*` objects instead of scattering many top-level extension fields. For example:

```json
{
  "x-example-lab": {
    "score": 93.4,
    "notes": "internal eval"
  }
}
```

Producers SHOULD NOT put machine-local absolute paths, secrets, bearer tokens, API keys, or private filesystem details in shared interchange documents. Local-only paths belong in local config files or explicitly local `x-*` fields that are stripped before publication.

## Promotion

If an extension becomes broadly useful, producers should propose a registered schema field. Once promoted, the registered field becomes the preferred public location and the older `x-*` field should be treated as compatibility data.

## Compatibility

Unknown unprefixed fields are tolerated by v1 schemas for forward compatibility, but publication-quality validators SHOULD emit warnings. This lets older consumers read newer documents while keeping the public extension namespace disciplined.
