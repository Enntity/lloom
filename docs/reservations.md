# Shared resources and jobs

Use the Accord skill or CLI for registration, discovery, messages, jobs and leases.
`lloom schedule --json` shows the same ownership in LLooM's familiar read-only shape.
The old reserve/renew/release/job write commands and gateway routes no longer own
state; use `accord reserve`, `reservation`, `extend`, `release`, `job` and `jobs`.

LLooM registers configured resources with Accord at gateway startup. For example:

```json
{"reservations":{"resources":{"lab":{
  "asset":"lab-gpu-pool",
  "description":"Lab model work",
  "hosts":["worker"],
  "routes":[{"alias":"chat","profile":"cloud"}],
  "suspend":["resident"],
  "workloads":["experiment"]
}}}}
```

Use one stable physical `asset` per resource and one authoritative host. `workloads`
are administrator-configured LLooM models, not arbitrary agent commands. Capacity
slots without shared route/model effects become separate Accord resources. Shared
model effects and shared workload definitions require capacity one.

Each registration also declares how long one reservation may hold the resource:
`maxTtlMs` becomes Accord's `maxOwnershipMs` (kept within one minute to 30 days) and
`allowIndefinite: true` lets a holder keep renewing without a total limit.
Bounded windows need no heartbeat calls. Explicit short `leaseMs` leases still
require automatic renewal by a supervised launcher. Accord 0.4.0 and earlier
ignore both ownership fields and keep an eight-hour limit.

1. Join Accord and discover the resource's full address.
2. Reserve it with a stable request key and `durationMs` covering preparation and
   the benchmark (CLI: `--duration-ms`; default one hour). Only `running` grants access.
3. Start the configured workload through Accord, or register external containers and supervisors before launching them (below). Publish job progress there.
4. The daemon holds the window without chat heartbeats. If more time is needed,
   extend the same reservation ID with `durationMs` before its deadline. This does
   not rerun preparation or stop serving. A progress report does not extend a window.
5. Release and wait for `released`. Unknown or recovering means it remains held.

For a 90-minute managed-serving benchmark:

```sh
accord reserve --resource AUTHORITY/RESOURCE --purpose "SparkDash benchmark" --duration-ms 5400000
# Confirm running, then start the configured workload and verify model readiness.
accord workload start --id RESERVATION_ID --host AUTHORITY
# Run the benchmark. Extend only if more time is needed, keeping the same ID.
accord extend --id RESERVATION_ID --host AUTHORITY --duration-ms 5400000
accord release --id RESERVATION_ID --host AUTHORITY
```

A chat disconnect does not abandon a window; it remains held until its deadline or
explicit release. Session close and coordinator/driver recovery still revoke it.
Both the client and owning Accord host must support `reservation-windows-v1`; old
hosts are refused before mutation. Upgrade only after active holders have released.
Do not release/reacquire merely to renew, or bypass Accord to avoid preparation.

The provider stops the old managed workload and restores exact model/route state
before Accord grants another generation. Coordinator, provider or driver failure,
health-check failure and ambiguous replies do not free the resource. Previously
suspended models remain suspended. A suspended model that was disabled or removed
during the hold has nothing to resume; restoration records it as retired and
continues with the routes.

Pre-migration active leases remain held in the original schedule evidence until
verified recovery. Do not edit an old deadline or delete a schedule file to claim
hardware is free. See [integration boundaries and cutover](ACCORD.md).

For a historical hold whose owner confirms there is no borrowed workload, an
operator may adopt the verified current serving configuration as the production
baseline. Drain the gateway with its deployment fence first. Run
`node scripts/reconcile-accord-hold.mjs --config FILE --plan PLAN` to inspect,
then add `--apply --yes`. The plan must identify the exact lease and configuration
SHA-256, matching fence operation/generation, owner confirmation, live baseline
evidence, and `noBorrowedWorkload: true`. The original journal remains unchanged;
a separate exact-record reconciliation prevents replay of obsolete restoration.
A changed lease blocks again. This does not stop or certify arbitrary containers.
Future reservations still execute the current resource's drain/restore contract.
Production serving is LLooM's baseline, not an agent reservation; an unclaimed
reservation does not mean idle hardware.

## External containers and supervisors

For training, evaluation or build work, use the ordinary LLooM launcher:

```sh
lloom workload run --file workload.json             # preview
lloom workload run --file workload.json --apply --yes
```

The [plan example](../examples/workload.json) names a discovered Accord resource,
its approved host aliases, cached images and argv commands. LLooM joins Accord
(or uses the inherited session), reserves and waits, creates fresh stopped
containers with the grant labels, creates any dedicated systemd user supervisors,
registers the complete set, then launches through Accord. It renews while waiting
for all containers to finish. Completion or cancellation requests release; the
command waits for confirmed recovery. Successful runs remove their stopped
objects. Failed runs retain objects for inspection; an unknown release remains
held. A killed launcher cannot bypass Accord's lease expiry and recovery gate.
No separate registration or renewal steps are required.

A plan may include `supervisors` with `name`, `host`, and an absolute argv `command`.
Use `{container:NAME}` inside an argument to refer to a container on the same host.
LLooM generates the grant-specific service name and a `KillMode=control-group`
unit, registers it before launch, and leaves stop ordering to Accord. The command
must keep its descendants in that group; detached watchers are outside this path.
Containers use `--restart=no`. Identity/restart overrides are rejected. Images
must already be cached; the launcher never downloads models or images.

Host aliases default to verified SSH. An optional `hosts` map selects `local:true`
or `ssh`, `identityFile`, and `knownHostsFile` for an existing trusted connection.
The discovered resource must approve every workload host and plugin. These are
operator/user launch specifications, not remotely supplied shell instructions.
`--profile` selects an existing Accord installation. Normal launches install Accord
if missing; inherited sessions are never closed by LLooM.

Administrator-configured serving `workloads` retain LLooM's existing provider
stop/restore contract. The external launcher is for objects LLooM creates for a
reservation; it never adopts or takes over unrelated running containers.
Accord stops registered supervisors and containers before calling LLooM's model
and route restoration. See the bundled
[external workload contract](../vendor/accord/docs/EXTERNAL-WORKLOADS.md) for the
host policy and enforcement boundary.

Already-running work must be inventoried with its holder before operator adoption.
If it cannot be contained safely, let it finish. Neither plugin fences arbitrary
privileged SSH/Docker actions or discovers unregistered supervisors automatically.

Distributed training plans may pass `--init`, `--ipc`, `--cpuset-cpus`,
`--memory-swap`, `--cap-add`, `--device`, and `--ulimit` alongside the existing
container options. These remain trusted operator plans; they do not sandbox a
malicious workload. Identity and restart settings still belong to the launcher.
If any container exits unsuccessfully, LLooM requests release of the entire group
immediately, including ranks still running. Checkpoint retention and disk-space
margins belong in the trainer; a reservation does not impose a filesystem quota.
