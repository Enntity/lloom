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

Dry runs omit the credential flags. Apply requires `--include-secrets`, `--expect-destination`, and `--yes`. The hash is the SHA-256 of the exact destination config reviewed in the dry run. The operator-side source command is fixed, validates SSH hostnames, and sends only the URL request over stdin; the source read script resolves one accepted inference key and emits a JSON envelope. No source file is written.

## Envelope

The target consumes:

- `sourceConfig`
- `sourceProfiles`
- `sourceInferenceKey`
- `sourceUrl`
- `sourceNode`

The JSON representation remains private. It is transported over SSH stdin and is not placed in argv. Dry-run reports and planner summaries are secret-free.

## Result

The new proxy node uses the source gateway URL and stores its accepted inference key inline on the node and materialized proxy backend. Existing destination API keys remain. Source runtime-backed model IDs are advertised with their source runtime IDs. Destination-local IDs are not duplicated. Source aliases and defaults are imported only when all dependencies resolve; source prefixed IDs are mapped to an existing local bare ID when possible. Existing conflicting aliases remain reachable and are available through the generated standalone profile, which restores original routes, defaults and local residency without deleting imported aliases.

The destination becomes `cluster.fleetHeadNode` and `cluster.leaderNode`. The source's leader is unchanged. Destination runtime policy stays local and is listed in the summary. A repeat promotion is idempotent and retains the original standalone profile snapshot rather than overwriting it with the promoted state.

## Apply safety

Apply writes private `0600` backups of the config and changed named profile files, checks a combined config/profile review hash and rechecks source bytes before publication, validates the candidate with `loadConfig`, and atomically replaces each changed profile file. If validation or paired-profile publication fails, the destination config remains unchanged and this operation rolls back its own profile writes. The CLI emits JSON with the reviewed hash, counts, errors, and secret-free summary.
