# Gateway deployment fence

LLooM exposes a small gateway-local quiesce protocol for a coordinator that
already knows which node it is updating. The protocol is deliberately local;
it does not elect a coordinator, lock several nodes, or deploy files.

The admin endpoints are:

- `GET /gateway/deployment-fence/status`
- `POST /gateway/deployment-fence/prepare` with `{ "opId": "...", "timeoutMs": 300000 }`
- `POST /gateway/deployment-fence/canary` with `{ "opId": "...", "generation": 1, "request": { ... } }`
- `POST /gateway/deployment-fence/release` with `{ "opId": "...", "generation": 1 }`

They require an explicit `security.adminApiKeys` credential. `prepare` first
writes a config-adjacent `config.json.deployment-fence.json` sidecar atomically,
then blocks new POST inference and admin writes. Requests authenticated before
the fence may finish their complete request body and response stream. The
gateway pauses preferred residency and watchdog recovery, rejects new runtime
lifecycle/configuration mutations, and waits for manager admission/lifecycle
queues and active request counters to settle. The sidecar is never cleared
automatically; a restart that finds `draining`, `prepared`, or `canary` remains
fenced until the matching operation is released.

The prepare response is the source of truth for the positive `generation`. The
coordinator must echo both the exact `opId` and generation on every canary and
release call. A second prepare for a different operation is rejected while one
is draining. Releasing an already released matching operation is idempotent and
returns its terminal receipt; a different operation receives the last operation
and generation as conflict evidence.

Status and prepare/release responses carry `protocol: 1` and
`fenceProtocolVersion: 1`. `operation.opId` and `operation.generation` remain
durable in the sidecar, including after restart. A complete `releaseIdentity`
is present only when the boot manifest, exact config bytes, dependency digest,
and runtime-contract digest are all verified; callers must refuse `null` or a
partial identity. `/gateway/status` also reports `gatewayProtocol: 1`,
`serviceActive`, `atomicLayout`, `loadedIdentity`, and an observed
`runtimeSnapshot`. `atomicLayout` is true only when the process can prove that
its package is the target of a real `current` symlink with a matching manifest.

`canary` is an explicitly authorized, matching-operation-and-generation request
through the ordinary chat route while public admission remains closed. It
accepts only one exact configured model mapped to one healthy local runtime; an
alias, provider, remote/distributed target, or multi-target model is rejected.
It never starts, warms, evicts, fails over, or recovers a runtime. The canary
response must finish successfully before the fence returns to `prepared`.
Release writes a terminal receipt before reopening admission. A malformed
sidecar or failed persistence operation fails closed.

The process identity in status includes boot ID, PID, node ID, hostname, boot
time, and optional release-manifest commit/digest. A release manifest is
reported as known only after its complete file inventory matches the installed
package, every entry has a SHA-256 digest, and every listed installed byte has
been read. Symlinks and special files are rejected, as are missing, malformed,
or mismatched manifests; a higher-level deployer must refuse an unknown or
partial identity. A successful canary returns an explicit receipt with the
observed local model, runtime, HTTP status, and `responseFinished: true`; the
gateway never fills attribution from the caller's requested values. This protocol does not
provide multi-node atomicity, rollback, package transfer, model rollout,
consensus, or protection for processes that bypass the gateway and manager.
