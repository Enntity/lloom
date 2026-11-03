# External workloads

Accord can attach Docker containers and dedicated systemd user services to an
existing `managed-http` or `posix-process-group` resource. The resource keeps its
existing authority and queue. The resource's provider owns preparation and restoration;
Accord owns the lease, attachment journal and stop-before-regrant gate. No particular
GPU vendor, model or launcher is required.

## Install the host connectors

Install the same qualified Accord package on the resource authority and each
workload host. The helper is `src/workload-host.mjs`, requiring Node 22.16 or newer.
It accepts one JSON request on stdin and returns one JSON response. It supports
only inspect, start and stop for the two installed plugins; it accepts no arbitrary
command from an agent. The existing host daemon need not restart to use the helper.

An operator installs a resource allowlist with:

```sh
accord workload policy --data /path/to/accord-data --file workload-policy.json
```

Example (paths and resource IDs must match the actual installation):

```json
{
  "schema": 1,
  "hosts": {
    "head": {"transport": "local"},
    "worker": {
      "transport": "ssh", "host": "worker.example",
      "node": "/usr/bin/node", "helper": "/opt/accord/src/workload-host.mjs",
      "identityFile": "/private/accord-workload-key",
      "knownHostsFile": "/private/accord-known-hosts"
    }
  },
  "resources": {
    "compute-slot": {
      "hosts": ["head", "worker"],
      "plugins": ["docker-container", "systemd-user-unit"]
    }
  }
}
```

SSH verifies existing pinned host keys and never enables agent forwarding. Prefer
a dedicated key whose `authorized_keys` entry uses `restrict` and a forced command
running this helper. Provision that public key using an existing trusted admin
connection; keep the private key on the authority. Such a key controls workloads
on that host, so protect it like a resource-manager credential. It does not grant
an interactive shell, arbitrary commands, forwarding, or a PTY. A `socket` option
can select an absolute Docker socket path, including a rootless engine.

Policy updates affect new registrations. Existing attachments retain their exact
connector, machine/engine identity and target. Do not remove an old helper or key
until all attachments using it have stopped. Changes to active drivers require an
empty admission window; restarting a driver revokes its active generation.

## Agent workflow

1. Reserve the discovered resource and wait for `running`. Keep its reservation
   ID, host authority, `claimId`, and `generation`; renew normally.
2. Create stopped containers with `--restart=no`, labelled `accord.authority`,
   `accord.claim`, and `accord.generation` using those returned values. Capture the
   full immutable 64-character container ID. Do not use `docker run` or start yet.
3. Register all objects and supervisors before launching:

```json
{"targets":[{"host":"worker","plugin":"docker-container","id":"FULL_CONTAINER_ID"}]}
```

```sh
accord workload register --id RESERVATION --host AUTHORITY --file targets.json --key register-1
accord workload launch --id RESERVATION --host AUTHORITY --workload BINDING_ID --key launch-1
accord workload list --id RESERVATION --host AUTHORITY
```

`BINDING_ID` comes from registration, not Docker. MCP exposes the same actions
through `accord_workload` with `action: register|launch|list`, `targets` or
`workload`. Retry an ambiguous operation with the identical key and payload.
Each attachment launches once. To run another stage, create and register another
fresh object. Accord retains stopped containers for the owner to inspect or remove.

For a watcher that can recreate or restart work, put it in a dedicated, never-started
systemd user service with `KillMode=control-group`, no activation triggers or enabled
dependencies, and no escape from the service cgroup. Its name must begin with the reservation’s returned `workloadUnitPrefix` and end
with `.service`. That prefix is derived from the authority, claim and generation. Register it as `systemd-user-unit`, then launch through Accord.
The definition is pinned. All such supervisors stop before any containers.
A loose SSH/background loop is not a registered supervisor: move it under the
service before starting work. [systemd documents the control-group stop behavior](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html).

Finally release and wait for `released`. Accord first fences launches, stops every
registered supervisor and container, verifies their identities and stopped state,
then invokes the resource's stop/restore provider. Only after restoration succeeds
can the next agent receive a new generation. Unknown SSH, changed identity,
partial adoption, ambiguous launch or failed restoration keeps the resource held.

## An already-running workload

Coordinate with the actual holder first. Inventory exact container IDs **and all
watchers that can recreate them**. Do not infer ownership from process names or GPU
utilization. An operator can attach those objects without stopping them:

```json
{
  "authority": "AUTHORITY", "claimId": "HELD_CLAIM", "generation": 12,
  "key": "coordinated-adoption",
  "targets": [{"host":"worker","plugin":"docker-container","id":"FULL_CONTAINER_ID"}]
}
```

```sh
accord workload adopt --data /path/to/accord-data --file adoption.json
```

Running/unlabelled adoption is unavailable to ordinary agents. It requires the
exact held generation and never transfers or renews ownership. A partial adoption
persists its intent and blocks recovery until an operator reconciles the same
identities. Docker automatic restart must be disabled; register external supervisors
separately. [Docker explains its restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/).
If an existing supervisor cannot be identified or contained safely, wait for its
holder to finish. Never restart a live resource driver just to install this feature.

## Guarantee and boundary

The journal is separate from the provider's driver database, with its identity
pinned there by checksummed driver migration 3. A missing or replaced journal
blocks startup/recovery; restore the original journal rather than treating it as
empty. Keep both databases in backups. Older binaries cannot read migration 3;
upgrade in an empty admission window and prefer a forward fix to a database rollback. Its fence and launch
intent survive coordinator and driver crashes. Late calls from the old generation
are rejected. Lost launch replies never cause an automatic second start, and an
unresolved launch intent cannot be waved through by a timeout. Stop acknowledgments
must match the pinned Docker engine/container or machine/service definition.

This controls **registered objects and cooperating launchers**. It does not fence
an unrelated privileged Docker/SSH user, discover arbitrary detached work, prevent
an unregistered watcher from recreating it, or isolate GPU device access. GPU
telemetry is an observation, never stop proof. OS/device isolation can be another
plugin without changing reservation semantics.

## Verify

`npm run verify` includes external registration, ownership checks, coordinator and
driver death, changed host identities, failed stops, partial adoption, ambiguous
launches, release retries and supervisor ordering.

The opt-in real SSH demo uses two agents, two CPU-only Docker containers and one
systemd supervisor. It kills both local controllers, makes one fixture helper
unreachable, proves the second agent stays queued, then checks stopped identities
before provider restoration and next grant. It leaves installed reservations,
model routes and GPUs alone. Use an already-cached image containing `/bin/sh`:

```sh
node demo/external-recovery-ssh.mjs --hosts worker-a,worker-b \
  --node /usr/bin/node --image CACHED_IMAGE --output /tmp/external-recovery.json
```
