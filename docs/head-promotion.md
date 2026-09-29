# Fleet-head promotion

`cluster promote-head` plans and applies promotion of an already-prepared destination gateway to fleet head. It federates the source owner's runtime-backed models through the source gateway without copying physical runtimes or relocating distributed-runtime ownership. The destination remains the owner of its local models, backends, paths, security keys, listener, runtime policy, and profile residency.

## Commands

Read from a file or stdin and plan against the local destination:

```bash
lloom cluster promote-head --from envelope.json --source-url http://media.example.test:8100 --json
lloom cluster promote-head --from - --source-url http://media.example.test:8100 --json
```

Read a source over SSH and apply through a target over SSH:

```bash
lloom cluster promote-head --from-ssh source-host --target-ssh target-host \
  --source-url http://media.example.test:8100 \
  --include-secrets --expect-destination HASH --apply --yes --json
```

Dry runs omit the credential flags. Apply requires `--include-secrets`, `--expect-destination`, and `--yes`. The hash is the SHA-256 of the exact destination config reviewed in the dry run. The operator-side source command is fixed, validates SSH hostnames, and sends only the URL request over stdin; the source read script resolves one accepted inference key and one source admin key from the source's separate `security.adminApiKeys` and managed environment, and emits a JSON envelope. No source file is written.

## Envelope

The target consumes:

- `sourceConfig`
- `sourceProfiles`
- `sourceInferenceKey`
- `sourceAdminKey`
- `sourceUrl`
- `sourceNode`

The JSON representation remains private. It is transported over SSH stdin and is not placed in argv. Dry-run reports and planner summaries are secret-free.

## Result

The new proxy node uses the source gateway URL. Its materialized proxy backend stores the source inference key, and destination `security.apiKeys` gains only that inference credential. The source cluster node stores the separate source admin key required by `/gateway/node` and telemetry; it is never added to destination inference API keys. Missing source admin access is reported as a conflict, and apply fails closed. A legacy promoted node whose only stored node credential is the source inference key is repaired to the source admin key on apply; an unrelated conflicting node credential is rejected. Existing destination API keys remain. Source runtime-backed model IDs are advertised with their source runtime IDs. Destination-local IDs are not duplicated. Source aliases and defaults are imported only when all dependencies resolve; source prefixed IDs are mapped to an existing local bare ID when possible. Existing conflicting aliases remain reachable and are available through the generated standalone profile, which restores original routes, defaults and local residency without deleting imported aliases.

The destination becomes `cluster.fleetHeadNode` and `cluster.leaderNode`. The source's leader is unchanged. Destination runtime policy stays local and is listed in the summary. A repeat promotion is idempotent and retains the original standalone profile snapshot rather than overwriting it with the promoted state.

## Apply safety

Apply writes private `0600` backups of the config and changed named profile files, checks a combined config/profile review hash and rechecks source bytes before publication, validates the candidate with `loadConfig`, and atomically replaces each changed profile file. If validation or paired-profile publication fails, the destination config remains unchanged and this operation rolls back its own profile writes. The CLI emits JSON with the reviewed hash, counts, errors, and secret-free summary.

Secret-free previews report credential availability without sending credential values. A missing credential is a preview warning; apply requires resolved credentials. When a source has no separate admin-key list, promotion uses its inference key for administration, matching gateway authentication policy. Runtime commands and unrelated source settings are excluded from the transfer snapshot.

For additional peers, `cluster add-node NODE URL --api-key-stdin` reads a credential from a trusted pipe without putting it in command arguments or reports. Review the default dry run, then repeat with `--apply --yes`. The fetched node identity must match, and apply keeps a private copy of the previous configuration. Use `--telemetry-only` for a worker gateway whose inference service should stay disabled.

`service restart --host ADDRESS` changes a managed gateway listener after draining its old endpoint. Review the old and new addresses before applying with `--apply --yes`. Only local interfaces or wildcard addresses are accepted, existing public-bind authentication policy remains enforced, and the restarted process is checked at its new endpoint. Failed listener changes restore the original binding unless an external writer has changed it. Managed model processes and the prior inference-enabled setting are retained.
