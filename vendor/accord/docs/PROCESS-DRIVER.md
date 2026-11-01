# Managed processes and resource plugins

Accord now registers multiple named resources per authority and runs a fixed,
administrator-approved workload under a process grant. A resource is identified
by `<authority>/<resource-id>`. Its kind does not depend on the host being a Mac,
a Spark, or a particular GPU vendor.

The built-in `posix-process-group` plugin runs on macOS and Linux. It controls a
process group and confirms that the group has disappeared before releasing its
grant. It does not isolate devices or prevent descendants from deliberately
leaving the group. Workloads using `setsid`, `setpgid`, daemonization, or external
job submission need a stronger plugin. Registering an NVIDIA-looking asset name
does not turn this process plugin into a GPU reservation.

## Install and register

The existing `accord install --start` installs the host service, CLI, skill, and
MCP integration. After upgrading source, restart the service to load the new
modules. Existing artifact state remains compatible; coordinator migration 3 adds
resource bindings without rewriting earlier migrations. Process resources have
separate driver databases and a durable host registry.

```sh
accord plugins
accord resource register --file examples/process-resource.json --key register-build-slot
accord resource list
accord host
```

The example registers `build-slot` with `/usr/bin/printf`. For a real workload,
set an absolute executable, an argument array, and an absolute working directory.
No shell is inserted. Optional environment entries belong in the private manifest;
agent tools cannot replace the command or inject arguments. The plugin starts with
a minimal environment rather than forwarding the coordinator's credentials.

Registration requires local administrator authority. Resource IDs and physical
asset keys are unique within a host. An identical registration is idempotent;
changing its executable, environment, asset, or plugin is refused. There is no
live replacement or unregister shortcut that resets fencing. Use one authority
for each physical asset. The operator must choose its canonical asset identity;
this release cannot detect two different names for the same hardware.

Submit a task with `--resource build-slot`, then claim it through the normal API.
`claim` and `wait` accept an optional resource filter. Automatic selection skips
resources already held. Each resource currently has exclusive capacity one;
capacity pools and atomic multi-resource bundles remain separate work.

For an agent running under `accord run`:

```sh
accord claim --resource build-slot --key build-attempt
accord inspect --claim CLAIM_ID
accord process-start --claim CLAIM_ID --key launch-build
accord process-status --claim CLAIM_ID
accord finish --claim CLAIM_ID --receipt RUN_ID --key finish-build
```

Wait for a running claim before starting. Renew the claim while work continues.
Current leases are 0.5–30 seconds, bounded by a five-minute attempt limit;
long-lived reservation policies are still required for LLooM serving.
MCP exposes the same operations as `accord_resources`, `accord_process_start`,
`accord_process_status`, and the existing claim/renew/finish tools. There is one
workload launch per claim; retry its original key after an ambiguous reply.
A second launch key is refused. Successful exit produces a receipt over at most
8,000 bytes of UTF-8 stdout. Nonzero exits, signals, invalid UTF-8, and excess output
cannot satisfy a task. This bounded output verifier is for the current slice;
a general build or model job will need its own result verification policy.

## Stop proof and crash recovery

The process supervisor is the leader of a new POSIX session and process group.
Its descendants inherit that group. This uses Node's documented
[`detached` process semantics](https://nodejs.org/download/release/v22.19.0/docs/api/child_process.html#optionsdetached).
The supervisor remains alive after the main executable exits, because descendants
may still be working.

Launch has two gates. The driver first commits the run ID, group identity, and
private control address. Only then does it send an arm message. The supervisor
checks the committed claim and run state inside the same SQLite transaction used
to serialize launch against revocation. It cannot start after revocation has
begun. A driver crash before commit or before arm leaves no running workload;
separate fault tests exercise both windows.

Revocation invalidates the grant credential before requesting termination. The
driver asks the original supervisor over its private authenticated Unix socket to
send TERM, waits the registered grace period, then requests KILL. The supervisor
signals its own group. Recovery never blindly kills a saved PID that might have
been reused. The driver polls for group absence; an acknowledgment, parent exit,
lease expiry, or elapsed grace period is insufficient. Only group absence creates
`process.stopped`, followed by `grant.revoked` and the coordinator's release.

If the driver crashes, the detached workload can remain alive. Restart retains the
claim, invalidates its credential, and enters recovery. The coordinator continues
to hold the resource until the driver proves stop. A coordinator crash similarly
revokes unfinished attempts after leadership recovery. The replacement agent gets
a higher generation and can read the previous checkpoint.

If the process supervisor is merely suspended, the hold survives until it responds
and termination is observed. If it is destroyed while descendants survive, this
plugin cannot authenticate a controller for that group. It **stays held** until
an external operator or stronger OS containment mechanism stops the group. This
is a tested fail-closed case, not automatic recovery. Device access by unrelated
same-user processes is outside this plugin's enforcement boundary.

## Plugin boundaries for the fleet

The coordinator owns identity, claims, generations, deadlines, checkpoints,
registration bindings, and steering. It neither imports GPU libraries nor decides
how a model is drained. A plugin owns preparation, execution, stop confirmation,
and restoration receipts for its particular resource.

| Layer | Responsibility | Status |
| --- | --- | --- |
| macOS / Linux host installation | LaunchAgent or systemd user service, local profile, SSH transport | Existing installation path |
| POSIX process group | Fixed workload launch, authenticated stop, confirmed group absence | Implemented and fault-tested |
| Linux cgroup or systemd workload plugin | Kernel-maintained descendant membership, including daemonized children; recovery after supervisor loss | Next enforcement plugin |
| Mac workload plugin | Stronger supported supervisor/container boundary where required; keep portable process-group limits explicit | Extension point |
| Spark host profile | Discover architecture, inventory and supported plugins; no special claim semantics | Planned inventory profile |
| NVIDIA GPU plugin | Canonical GPU/MIG identities, access controls, utilization observation, stop/reset proof where supported | Planned; no device exclusivity claim yet |
| AMD / Strix plugin | Discover devices and implement equivalent supported containment and release proof | Planned |
| LLooM plugin | Drain routes, stop controlled serving, restore prior model state, verify health before reopening traffic | Required before reservation cutover |

A Spark is a host profile, while NVIDIA or AMD describes a device capability. A
Mac can expose build slots and other resources. Keeping these dimensions separate
avoids a Spark-specific scheduler or a driver selected merely from a hostname.

The current plugin catalog is built into the trusted host package. `accord plugins`
reports only installed implementations; unknown IDs are refused. Automatic vendor
probing, third-party package loading, plugin updates, and device provisioning are
not implemented. Future installer packages should use explicit capabilities and
versioned manifests, preserve asset IDs on upgrades, and report unsupported
operations rather than silently falling back to cooperative locking.

The existing HTTP driver boundary remains the integration seam: versioned driver
identity plus authority/epoch/generation/claim on activation and revocation,
idempotent operations, and a release receipt only after the controlled effects
stop and restoration succeeds. `src/driver-host.mjs` dispatches resources to
implementations; `src/plugins/posix-process-group.mjs` owns the OS-specific process
operations. New hardware plugins should fit that boundary, not add hardware logic
to task admission. LLooM should retain its route and model restoration code and
implement this contract before its reservation authority moves to Accord.

## Qualification

```sh
npm run demo:process
npm run verify
```

The process demo uses two deterministic protocol agents and real OS processes.
It kills the owner agent and driver, observes surviving parent/child workloads
while the lease is held, restarts the driver, and asserts the old group is absent
before granting the replacement. The replacement resumes the checkpoint and
completes its task. Both coordinator events and driver audit are saved in
`evidence/process-recovery.json`, alongside workload timestamps.

The process test suite also covers successful completion, duplicate launches,
TERM-resistant descendants, coordinator death, main-workload death, supervisor
suspension and destruction, the two launch crash windows, authenticated stop
control, independent registered resources, and process database replacement while another
driver remains healthy. SSH notices and `doctor` inspect every registered resource.
This suite spends no model tokens
and touches no GPUs or model routes. The final suite has 43 tests and three recovery demos. It was executed on macOS
arm64 and Linux arm64 on `ennspark02`, using Node 22.19.0 and matching source
hashes. The Linux run used a temporary checkout and CPU-only workloads; that
host's installed service was not replaced. Results are in
[`evidence/qualification.json`](../evidence/qualification.json) and
[`evidence/process-linux/qualification.json`](../evidence/process-linux/qualification.json).
The local idle service was upgraded with its authority and peer configuration
preserved; [`process-installation.json`](../evidence/process-installation.json)
records the new plugin catalog. No demonstration process resource was permanently
registered in the user's service. The earlier live Codex/Claude test remains
artifact-only; it is not evidence of model-driven process-tool use.
