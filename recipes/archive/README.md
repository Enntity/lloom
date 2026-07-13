# Recipe archive

Active recipes keep a stable path at `recipes/<recipe-id>.json`. When an active recipe changes, copy the previous immutable document to:

```text
recipes/archive/<recipe-id>/v<version>.json
```

The active entry in `recipes/index.json` declares `currentVersion` and a `versions` list containing the active path plus every archived path. Archived recipes are validated for matching `id` and `version`, but they are never considered by automatic recipe selection.

The hosted seed catalog mirrors the same structure under `community/recipes/archive/` so exported recommendations remain reproducible.
