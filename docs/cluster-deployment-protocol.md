# Cluster deployment coordinator protocol

`src/cluster-deployment.mjs` coordinates a reviewed artifact across a small
gateway fleet. It is deliberately transport-neutral. A later node agent or SSH
implementation must satisfy the adapter below; the coordinator never opens
SSH, restarts a service, rebuilds an image, or sends inference requests itself.

The supported target is a Linux gateway managed by systemd. A deployment plan
must contain all of the following:

```js
{
  scope: { platform: 'linux', serviceManager: 'systemd', mode: 'gateway' },
  gatewayProtocol: 1,
  reviewedArtifact: {
    id: 'release-2026-10-10',
    sha256: '<64 lowercase hex>',
    manifestSha256: '<64 lowercase hex>',
    reviewed: true
  },
  targetNodes: [
    { id: 'worker-1', role: 'worker', order: 10 },
    { id: 'leader', role: 'leader', order: 20 }
  ],
  expectedOldIdentity: {
    releaseId: 'release-previous',
    artifactSha256: '<64 lowercase hex>',
    manifestSha256: '<64 lowercase hex>'
  },
  // Optional when nodes do not share one old release identity:
  // expectedOldIdentityByNode: { 'worker-1': { ... }, leader: { ... } },
  canary: { gatewayModelId: 'atlas/local', runtimeId: 'atlas-runtime' }
}
```

The coordinator normalizes and hashes this plan before creating a journal.
The plan hash is immutable. `operationId` stays fixed for the life of the
operation; `generation` starts at one and increments only when a caller
resumes or explicitly rolls back. A caller may provide the expected generation
to reject stale operators.

## Adapter API

The adapter is an object with these methods:

```js
const adapter = {
  preflight(nodeId, context),
  stage(nodeId, context),
  prepare(nodeId, context),
  swap(nodeId, context),
  restart(nodeId, context),
  verify(nodeId, context),
  canary(nodeId, context),
  promote(nodeId, context),
  release(nodeId, context),
  reprepare(nodeId, context),
  rollback(nodeId, context),
  discardStage(nodeId, context)
};
```

Every method returns a promise for a receipt with exactly these common fields:

```js
{
  operationId,       // exact coordinator operation id
  generation,         // exact context generation
  nodeId,             // exact requested node id
  phase,              // exact method phase
  status: 'ok',
  observedAt          // ISO timestamp
}
```

The coordinator rejects missing, mismatched, or extra receipt fields. The
adapter must return only public-safe identifiers, digests, booleans, and
timestamps. Never return credentials, request bodies, prompts, model output,
raw command lines, or unredacted transport errors.

Phase-specific evidence is required:

- `preflight`: `platform: 'linux'`, `serviceManager: 'systemd'`, the exact
  `gatewayProtocol`, `atomicLayout: 'atomic'` (or `true`), and
  `currentIdentity`. The current identity must match the plan's expected old
  identity.
- `stage`: `staged: true`, and the exact artifact and manifest digests.
- `prepare` and `reprepare`: `fenced: true`, `drained: true`, and both
  `{ id, sha256 }` `backup` and `snapshot` evidence.
- `swap`, `restart`, `verify`, and `promote`: the exact new artifact and
  manifest identity, `configSha256`, `dependencyDigest`,
  `runtimeContractDigest`, and snapshot evidence. `restart` also returns
  `serviceRestarted: true, healthy: true`; `verify` returns `verified: true`;
  `promote` returns `promoted: true`.
- `canary`: `healthy: true`, the exact reviewed gateway model and runtime,
  `fenced: true`, `privileged: true`, `source: 'local'`, `aliasUsed: false`,
  and `cloudFallback: false`.
- `release`: `released: true, fenced: false`.
- `rollback`: `restored: true, fenced: true`, and the exact expected old
  identity.
- `discardStage`: `stageDiscarded: true`.

An adapter must treat a timeout, disconnect, or lost response after a possible
mutation as unknown. It must not report that the node was untouched. The
coordinator will retain fences and backups and attempt rollback for every node
that could have changed.

## Ordering and recovery

The coordinator preflights every node, then stages and verifies every node,
before it prepares any node. It prepares all nodes fenced and drained. Workers
are swapped and restarted before the leader. All nodes are verified before the
leader canary runs. Promotion completes for every node before any public
release. Public release is compensating bookkeeping, not a distributed atomic
transaction.

The journal is atomically replaced and fsynced before every possible mutation.
It records a pending action before calling the adapter and a public-safe
receipt afterward. A process that resumes with a pending action treats its
outcome as uncertain and rolls back; it never repeats the swap or restart.
Rollback reverses the recorded mutation order. If any node was released or
promoted, rollback first performs a fresh `reprepare` fence and drain. Every
rollback attempt continues even when another node fails. `rollback-failed` and
`manual-intervention` are durable outcomes; they are never represented as
successful completion.

The local journal lock is held for `deploy`, `resume`, and `rollback`. `status`
is read-only. A concrete transport must additionally refuse an old gateway
protocol or a non-atomic layout during `preflight`; the coordinator never
silently downgrades those checks.

## Local node agent and SSH transport

`src/node-release-agent.mjs` is the gateway-side implementation for the
adapter. It owns only a reviewed archive, its reviewed manifest, the atomic
`current` symlink and `current.manifest.json`, the configured gateway config
snapshot, the immutable package/dependency tree, and the Linux user systemd
unit. It does not rebuild an artifact, change model processes, change runtime
contracts, or issue an inference request. The injected command runner may
execute only the configured unit's `systemctl --user is-active` and
`systemctl --user restart` operations, plus the fixed safe tar listing and
extraction arguments. The gateway fence adapter must implement:

```js
gateway.inspect(context); // protocol, fence protocol, layout, loaded identity
gateway.prepare(context); // { fenced: true, drained: true }
gateway.reprepare(context);
gateway.release(context); // { fenced: false }
gateway.canary(context); // exact local model/runtime result while fenced
```

The reviewed archive must contain `package.json`, a complete regular-file
inventory in `manifest.files`, `manifest.treeSha256`, an exact
`dependencyClosure` and matching `dependencyDigest`, a supported Node engine,
and a runtime-contract digest. Symlinks, special files, path traversal,
unlisted bytes, missing dependency packages, and digest drift are rejected
before `stage` acknowledges success. The installed gateway must expose a
complete `loadedIdentity` and `runtimeSnapshot`; a disk manifest alone is not
proof that the running process loaded that release.

The archive layout is the reviewed gateway layout itself: `package.json` and
the listed `node_modules` entries are at the archive root. A standard
`npm pack` tarball with a leading `package/` directory is rejected; it must be
rebuilt by the reviewed release builder into this layout. The closure must
match every declared runtime dependency exactly (optional and peer
dependencies are unsupported), with each installed package version and every
regular file covered by the manifest inventory.

The agent journals under `operations/<operation-token>/<node-id>/journal.json`
and fsyncs the journal before an action and after its receipt. It copies and
hashes the old release tree, manifest, config, unit/drop-ins/environment, and
runtime snapshot before reporting `prepare`. A pending action is
unknown after interruption; only `reprepare` or `rollback` may supersede that
pending action, and they retain the fence when the old identity cannot be
proven. The agent refuses unsupported platforms, missing fence protocol,
non-atomic layouts, unsafe release targets, or digest mismatches.

This is a migration boundary, not an automatic upgrade path for an older
gateway. The gateway must already expose fence protocol 1, the atomic
`releases/<id>` plus `current` layout, a boot-time loaded release identity, and
the persistent deployment-fence sidecar. A legacy gateway is refused until a
separately reviewed migration installs those prerequisites; the node agent
does not rebuild or bootstrap them during a rollout.

`src/node-gateway-adapter.mjs` is the concrete same-node fence adapter. It
accepts only an authenticated loopback HTTP URL and requires fence protocol 1,
complete matching disk/loaded identities, and explicit prepared/drained and
released receipts. It uses `/gateway/deployment-fence/{status,prepare,canary,release}`
and never serializes the admin key into a journal or receipt. The installed
node-agent entry point reads `LLOOM_NODE_ID`, `LLOOM_NODE_RELEASE_ROOT`,
`LLOOM_NODE_CONFIG_PATH`, `LLOOM_NODE_UNIT_PATH`,
`LLOOM_NODE_DROP_IN_PATHS`, `LLOOM_NODE_ENVIRONMENT_PATHS`,
`LLOOM_GATEWAY_URL`, and `LLOOM_ADMIN_API_KEY` from the service environment.
The unit path and the two metadata path lists are explicit verified
configuration; omitted metadata is refused rather than silently producing an
incomplete rollback snapshot. It accepts only bounded JSON on stdin and emits
public-safe JSON receipts.

`src/ssh-deployment-transport.mjs` sends the public-safe context as JSON over
an already-installed `lloom node-agent <phase> --json` command. Host, user,
port, host-key alias, and command tokens are validated without shell
interpolation; strict host-key checking and batch mode are always enabled.
An optional `upload(node, context)` callback may place the already-reviewed
archive and manifest and must return their remote paths. The transport never
stores credentials or forwards unknown context fields. A nonzero SSH exit,
disconnect, timeout, or non-JSON response is an operation failure; the
coordinator decides whether rollback is required.

The reviewable CLI is:

```text
lloom deployment plan --plan PLAN.json [--json]
lloom deployment apply --plan PLAN.json --nodes NODES.json --apply --yes [--journal PATH]
lloom deployment status --operation-id ID [--journal PATH]
lloom deployment resume --plan PLAN.json --nodes NODES.json --operation-id ID --apply --yes
lloom deployment rollback --plan PLAN.json --nodes NODES.json --operation-id ID --apply --yes
```

`lloom cluster rollout` is an equivalent namespace when an installed LLooM
configuration is already present. `plan` and `status` are read-only. The
mutating commands require both `--apply` and `--yes`, and every plan remains
bound to its immutable reviewed artifact, manifest, old identity, target
nodes, gateway model, and runtime id.

The `--nodes` file is an endpoint map, for example
`{ "worker-1": { "host": "worker-1.internal" }, "leader": { "host":
"leader.internal", "user": "deploy", "port": 22 } }`. It contains no
credentials; SSH authentication remains the host's configured mechanism.
