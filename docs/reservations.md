# Reservations and jobs

Several agents (or people) sharing a few machines need two things from
LLooM. The first is a way to take hardware without colliding with each other or
with production serving. The second is a single place that answers "how is it
going?" without anyone having to ask each agent.

The schedule-owning gateway provides both. This is normally the cluster head.

- A **reservation** is a lease on a named resource. Taking it runs that
  resource's actions: route aliases away, then drain and suspend models.
  Releasing it undoes them in reverse. A release only reports success once the
  resumed models pass their health check, and only then is traffic routed back.
  Leases expire unless they are renewed, so an agent that vanishes cannot hold a
  machine forever.
- A **job** is a status record that an agent posts and keeps current: notes,
  progress, metrics, a receipt path and an implicit heartbeat. A job that stops
  reporting is marked stalled. A job attached to a reservation keeps that lease
  alive while it reports.

Both appear on one board: `lloom schedule`, `GET /gateway/schedule`, and
Tessera's Fleet band.

## Configure resources

Resources live in the owning gateway's config:

```json
{
  "reservations": {
    "resources": {
      "pair": {
        "description": "two-node Atlas pair",
        "hosts": ["gpu-box-1", "gpu-box-2"],
        "routes": [{ "alias": "omp", "profile": "cloud", "node": "gpu-box-1" }],
        "suspend": [{ "model": "pair-model", "node": "gpu-box-1" }]
      },
      "builds": { "description": "build slots on gpu-box-3", "capacity": 2 },
      "drafter": { "hosts": ["gpu-box-3", "gpu-box-4"], "allowIndefinite": true }
    }
  }
}
```

| Field | Meaning |
|-------|---------|
| `description` | Shown on the board. |
| `hosts` | Exact host IDs reserved by this resource. A held lease blocks differently named resources sharing any host. Use the same canonical IDs in every resource; aliases are not resolved. |
| `capacity` | Number of concurrent holders. The default is 1. Resources with actions must have capacity 1. |
| `routes` | Route-profile switches applied on take, in order (`lloom route <alias> <profile>`). The profile active at take time is recorded and restored on release. |
| `suspend` | Models to drain and unload on take (`lloom suspend`) and resume on release (`lloom resume`). |
| `node` | The cluster node whose gateway owns the route or model. Omit it for the local gateway. Remote steps use that node's admin API with its `cluster.nodes.<id>` credential, so the node needs `security.allowRemoteAdmin`. |
| `ttlMs`, `maxTtlMs` | Default lease length (30 min) and longest requestable lease (8 h). |
| `allowIndefinite` | Permit `--ttl none`, for standing reservations such as "these hosts belong to the drafter project". |
| `onExpiry` | `release` (the default) restores on expiry. `keep` only flags the lease as overdue. |

Schedule-wide settings sit beside `resources`: `warnBeforeMs` (5 min),
`queueTtlMs` (30 min), `staleAfterMs` (15 min), `drainTimeoutMs` (5 min),
`retentionMs` (7 days) and `eventLimit` (500). State is kept in
`schedule.json` beside the config, and the durable history is appended to
`schedule-events.ndjson`. Override these locations with `statePath` and
`eventsPath`.

Routes run before suspends on take, so traffic has already moved when a model
drains. Each step records what it found, so release restores that and nothing
more:

- A route already on the target profile is left alone.
- A model that was already suspended stays suspended.
- A route with no active profile has nothing exact to restore, so the take
  refuses it. Select a profile first with `lloom route <alias> <profile>`.
- Two resources that suspend the same model, or move the same route, would undo
  each other's leases. Both are reported as configuration errors until one of
  them is changed. A step that fails rolls back the steps already done, and the reservation
ends as `failed`. A restore that fails leaves the reservation `stuck`: the
resource stays held and traffic stays away from the unhealthy model until a
`release` succeeds. A gateway restart during an action also leaves the
reservation `stuck`. Releasing it re-runs the undo, which is idempotent.

Host exclusion applies while a lease is acquiring, active, releasing, or stuck.
Same-resource capacity still permits its configured number of holders. A blocked
four-host request can queue and starts only after every overlapping holder has
released. New leases save their host list; config edits cannot shrink hardware
protection beneath an active lease. Legacy leases use their configured resource's
hosts; if that resource disappeared, new host-scoped work is refused until the
legacy lease is released. A resource without `hosts` does not reserve hardware.

Host exclusion alone does not suspend a production model when no lease is held.
For a four-host production lane, use one action-bearing resource covering all
four hosts, with safe fallback routes and the TP4 model in `suspend`. Retire old
pair/drafter resources after settling their existing leases through the CLI;
otherwise taking a no-action subresource could permit work beside production.
The `pair` name may be retained for this expanded four-host resource so old pair
commands remain safe; `drafter-0304` commands then fail as unknown resources.
Never edit recorded lease steps to change their undo. Configure resources in the
head's normal configuration file, under the reviewed configuration/deployment
workflow, and verify `lloom reserve pair` before allowing new GPU jobs.

## Use it from an agent

Point the CLI at the head once. The key is the head's admin key; it is never
taken from argv, and the local gateway's key is never sent to a different
host:

```sh
export LLOOM_HEAD_URL=http://head.tailnet.example:8100   # private network, or https
export LLOOM_HEAD_API_KEY=...        # admin key for the head
export LLOOM_OWNER=buildopt          # who you are on the board
export LLOOM_SESSION=claude:<session-id>   # optional; lets Tessera open your conversation
```

Then:

```sh
lloom schedule                                   # who holds what, queues, jobs
lloom reserve pair --purpose "decode A/B"        # preview the actions
lloom reserve pair --purpose "decode A/B" --wait --apply --yes   # queue if busy
job=$(lloom job start "decode A/B" --on pair --note "building")
lloom job progress $job 2/6 --unit arms "arm 2 of 6"
lloom job metric $job tok_s=58.2 image=f399caa
lloom job done $job "flat vs baseline" --receipt receipts/decode-ab.json
lloom release pair --apply --yes                 # restore and free
```

- `reserve` without `--wait` fails straight away when the resource is busy, and
  names the holder.
- With `--wait` it queues and polls until the lease is active. It renews its
  queue slot while it waits, and an abandoned wait drops out after `queueTtlMs`.
- Taking a resource you already hold renews the lease.
- `renew` and `release` accept the reservation id or the resource name.
  `release --force` frees another owner's lease.
- `--ttl 2h` sets the lease length, and `--ttl none` asks for an indefinite one.
- Every job update (`note`, `progress`, `metric`, `beat`, `done`) is a heartbeat.
  Updates carry `LLOOM_OWNER` when it is set, and the head refuses updates to
  another owner's job.
- A job attaches only to its owner's lease.
- Two agents under the same owner are different holders when both name a session.
- `lloom job start` prints only the id, so scripts can capture it. Add `--json`
  to any command for the full record.

## HTTP API

These are `/gateway` admin routes, so the same rules apply as for other admin
endpoints: once `security.adminApiKeys` is set they need an admin key, and a
non-loopback bind needs `security.allowRemoteAdmin` for writes. They are served
only by a primary gateway with a file-backed config. An unreadable
`schedule.json` makes only these routes answer 503 `schedule_unavailable`; the
gateway still serves inference, and the file is left untouched for inspection.

| Route | Purpose |
|-------|---------|
| `GET /gateway/schedule?since=SEQ` | Board: `resources` (with `holders` and `queue`), `reservations`, `jobs` (with derived `health` and `heartbeatAgeMs`) and `events` after `SEQ`. |
| `POST /gateway/schedule/reservations` | `{resource, owner, purpose?, session?, ttlMs?, wait?}`. Returns a preview unless `apply` and `yes` are both true. |
| `GET /gateway/schedule/reservations/:id` | One reservation, including `position` when queued and `remainingMs` when active. |
| `POST /gateway/schedule/reservations/:id/renew` | `{owner, ttlMs?}` |
| `POST /gateway/schedule/reservations/:id/release` | `{owner, force?, apply, yes}`. Without `apply`, returns the undo plan. |
| `POST /gateway/schedule/jobs` | `{title, owner, session?, resource? or reservationId?, note?, staleAfterMs?}` |
| `GET /gateway/schedule/jobs/:id` | One job. |
| `POST /gateway/schedule/jobs/:id` | `{note?, progress?: {done, total?, unit?}, metrics?, receipt?, state?: done or failed or cancelled}` |

Refusals carry `error.type: "schedule_error"` and a code. For example,
`schedule_busy` (409) includes `details.holders`.

### Events

Event kinds:

- `reservation.acquiring`, `.queued`, `.active`, `.expiring`, `.overdue`, `.expired`, `.released`, `.withdrawn`, `.failed`, `.stuck`
- `job.started`, `.stalled`, `.recovered`, `.done`, `.failed`, `.cancelled`

Each event has a `severity`:

- `info`
- `attention`: expiring or overdue leases, stalled jobs, finished jobs
- `error`: failed jobs, failed takes, stuck restores

Boards poll with `since` to receive only new events. Job notes are written to
the durable log but kept out of the event ring.

## Limits and recovery

- At most 500 jobs run at once, and at most 50 agents wait per resource.
- A running job with no report for 24 hours is failed as abandoned.
- The event log rotates to `schedule-events.ndjson.1` at 16 MB.
- While a deployment fence holds, leases neither expire nor start, and they get
  that time back afterwards.
- When the gateway shuts down, it waits a few seconds for actions in flight.
  Anything still unfinished comes back as `stuck` on the next start.
- `reserve --wait` exits 0 only once the lease is active. It keeps waiting
  through a briefly unreachable head, and on Ctrl-C it gives its place back
  (exit 130).

## Security

Agents on other machines need the head's admin key, and the head needs
`allowRemoteAdmin`. That key opens every admin route, not just the schedule.
There is no narrower schedule-only credential yet. Reach the head over a
private network such as Tailscale, or use HTTPS: never send the key in
cleartext across a network you do not control.

## Scope

LLooM enforces reservations through the actions it performs, by suspending a
model and routing traffic away from it. It does not stop processes it did not
start. A build or container launched outside LLooM honours a reservation only
when its agent checks `lloom schedule` or holds the lease, so standing
reservations such as `drafter` work by being visible.

The schedule belongs to the gateway that keeps it. Moving the head to another
machine (`lloom cluster promote-head`) does not move `schedule.json`. Release
leases first, or copy the file across while both gateways are stopped.
