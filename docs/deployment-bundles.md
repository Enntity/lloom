# Gateway deployment bundles

The multi-node gateway coordinator consumes one reviewed archive and its
sidecar manifest. Build the archive once from a clean, committed checkout,
review the resulting digests, and pass those exact files to deployment. A
node must never rebuild the package while a rollout is in progress.

Install the locked production dependencies before building, then provide the
reviewed runtime-contract digest explicitly:

```sh
npm ci
npm run release:bundle -- \
  --runtime-contract-digest "$RUNTIME_CONTRACT_DIGEST"
```

`RUNTIME_CONTRACT_DIGEST` is a reviewed SHA-256 digest of the gateway runtime
contract used by the deployment plan. The bundle command does
not invent this value from the current checkout; leaving it out or supplying a
non-digest fails closed. `--allow-dirty` is available only for local fixture
work and marks the manifest dirty; a reviewed release must omit it.

The output is under `dist/releases/<full-commit-prefix>/` and consists of a
tar archive plus `<archive>.manifest.json`. The archive root contains
`package.json` directly, followed by `node_modules/`; it does not contain a
`package/` wrapper, model weights, local configuration, credentials, or a
mutable registry reference. The manifest records the full source commit,
archive SHA-256 and size, an ordered per-file byte inventory, a tree digest,
the runtime-contract digest, and a dependency digest.

`dependencyClosure` has exactly the keys in the gateway's
`package.json.dependencies`. Each value is the exact installed version used
in the archive. The builder recursively checks the installed dependency graph
and includes every resolved package at the archive root, while the node agent
uses the direct closure as its stable package contract. The local package-lock
root must match `package.json`; optional, peer, bundled, link, workspace, git,
wildcard, ambiguous, missing, symlinked, and hard-linked dependencies are
rejected. Thus `undici: "^8.11.2"` produces a closure entry of `8.11.2` while
remaining verifiable without a registry.

Before handing the files to the coordinator, verify the archive and manifest
round trip locally:

```sh
node test/deployment-bundle.test.mjs
```

Keep the archive and sidecar together. Their paths and digests are deployment
inputs, not values to regenerate on a target node. Repeating a build for the
same commit is create-or-verify: existing bytes must match exactly, and a
conflicting archive or sidecar is refused rather than overwritten.
