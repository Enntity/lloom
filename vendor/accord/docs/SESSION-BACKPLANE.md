# Session backplane

Accord owns shared observations, bounded activity history, search, summaries,
messages, jobs, questions, reservations and monitor incidents. A session record
is evidence about work, not a resource grant. The host's authenticated principal
and the native conversation ID are separate identities.

## Agent methods

| Purpose | MCP | CLI |
| --- | --- | --- |
| Join / describe work | `accord_bootstrap`, `accord_announce` | `session open`, `announce` |
| Search collaborators | `accord_find` | `find --query ...` |
| Search session content | `accord_sessions` | `sessions --query ...` |
| Read recent activity | `accord_session_read` | `session-read --id ...` |
| Report progress, wait, finish | `accord_report` | `report --input report.json` |
| Message / acknowledge | `accord_send`, `accord_inbox`, `accord_read` | `send`, `inbox`, `read` |
| Ask the operator | `accord_ask`, `accord_question` | `ask --input question.json`, `question --id ...` |
| Track a job | `accord_job`, `accord_jobs` | `job --input job.json`, `jobs` |
| Inspect / snooze monitoring | `accord_overseer`, `accord_snooze` | `overseer`, `snooze --input snooze.json` |
| Reserve / renew / release | `accord_reserve`, `accord_extend`, `accord_release` | `reserve`, `extend`, `release` |

Session search includes directly linked hosts that share with you and reports the rest
as unknown. A host shares session activity, jobs and monitoring with a link only after
`accord share-sessions --host AUTHORITY` on that host, and `--off` stops it. Read a remote
result with its `id` and the authority from its `address`
as `host`. Jobs and monitor inspection support an explicit `host`. Questions are
private to their owner and the operator; they are not federated.

A report accepts `title`, `state`, `detail`, `location`, `expectedAt` (Unix ms),
`private`, and up to 50 `{key,kind,text}` events. States are `starting`, `working`,
`idle`, `waiting`, `blocked`, `done`, `failed`, `exited`, `cancelled`, `unknown`.
Use meaningful transitions. Transport heartbeat updates presence, not progress.
Activity retains 500 events per session; full-text search indexes the latest 100.
This is a coordination view, not a complete transcript archive.

Bootstrap is limited to 4 KiB at the HTTP boundary, including for existing MCP
connections. It previews up to five recent participants, eight local resources,
and one abbreviated inbox message. HTTP `find` is compact and bounded to 8 KiB;
`args.detail: true` returns full records. The complete board and per-host copies of
the directory are omitted. Search includes older/offline participants; read full
messages through the inbox API before acknowledging them. Preview counts reflect
the bounded results observed, not a census of every linked host.

## Discovery and summaries

Install writes `awareness.json` beside the coordinator database, with local Codex
and Claude transcript roots, so transcript scanning is on by default and stays on this
host. The daemon scans every ten seconds, reads bounded
head/tail windows, skips symlinks and old files, and imports stable native IDs.
Current automatic parsers cover Codex and Claude. Any other harness can report through
MCP or HTTP.
A scan is bounded to 2,000 candidate files per root and a 36-hour lookback by
default; configure `lookbackMs` on a root for another horizon.

Codex's internal guardian sessions are excluded using `session_meta` provenance,
not title matching. Previously imported records are hidden from discovery, search,
summaries and monitoring on rescan, including known records outside the normal
lookback. Source transcripts and durable identities are preserved. Ordinary
reviewers and delegated workers remain discoverable.
Native transcript presence uses the source's last activity, not rescan time.
Completed sessions are offline and unknown or old activity remains unknown;
authenticated agent heartbeats continue to describe live transport presence.

The launcher can bind `CODEX_THREAD_ID`, `CLAUDE_SESSION_ID`, or `TESSERA_TILE_ID`
to the authenticated Accord session using the local administrator credential.
A host adapter must establish this binding; an agent cannot claim another native
identity through its tools. Bound agents receive the stable native inbox, even
when their Accord session changes. The installed Claude/Codex context hook can
also bind the harness-supplied native ID to the authenticated bootstrap or
announcement response. If neither mechanism establishes a binding, the
observation remains unbound. Do not infer identity from a label or working
directory. Bound conversation mail survives reconnects; leases do not transfer.

Extractive summaries work without a model. Optional configuration:

```json
{
  "schema": 1,
  "roots": [{"source":"codex","path":"/home/example/.codex/sessions"}],
  "summary": {
    "url":"http://127.0.0.1:8000/v1",
    "model":"summary-model",
    "keyFile":"/home/example/.config/accord/summary.key"
  },
  "products": [],
  "private": false
}
```

Adapter settings reload without restarting ownership services. Invalid settings
show `adapter-error` in `/v1/awareness`; lease recovery continues. Model summaries
are opt-in, bounded to two concurrent requests, settle before refresh, retry after
failure and cannot overwrite a newer or private session. No model output controls
ownership or authoritative state.

Redaction runs before persistence, indexing or summarization, but is not a promise
to recognize every secret format. `accord privacy --source codex --on` stops that
source's scans and purges its indexed content. `--off` permits fresh publication;
it does not restore deleted history. Privacy is per source; independently configured
roots have their own gates. Global `private:true` stops adapters and purges known sources;
reopening source gates is explicit.

## Overseer

The built-in `quiet-work` rule checks working sessions after 15 minutes without
meaningful progress. Waiting, completed, private and snoozed sessions are excluded.
An expected wait also suppresses quiet-work checks. Every incident records its
observations, attempts and resolution. Cooldown defaults to 15 minutes, at most
three check-ins per episode. A restarted monitor does not resend the same attempt.

Configure an operator rule with `accord policy --input rule.json`:

```json
{
  "id":"idle-accelerator",
  "kind":"idle-resource",
  "resource":"gpu-pair",
  "telemetryHosts":["PINNED-HOST-AUTHORITY-ONE","PINNED-HOST-AUTHORITY-TWO"],
  "quietMs":900000,
  "cooldownMs":900000,
  "maxPings":3,
  "threshold":5,
  "maxAgeMs":30000
}
```

Omit `telemetryHosts` for this host. A rule needs consecutive fresh samples from
all configured hosts and the same confirmed holder. Multi-host idleness uses the
highest utilization. Missing sensors, unreachable hosts, uncertain ownership and
multiple un-attributable holders do not trigger a ping. Existing manager leases
without an exact Accord ownership record remain visible but are not guessed into
an agent identity.

For other detectors, configure `kind:external` with a `source`, then publish
`{rule,source,subject,session,stuck,reason,observedAt}` using
`accord signal --input signal.json`. These are administrator operations.
Disable a rule by reapplying its configuration with `enabled:false`.

The overseer sends a durable check-in. It never releases, kills, renews or steals
a resource. Delivery, native wakeup, agent reading and agent action are separate
facts. Installed context hooks deliver new messages at
tool/turn boundaries, with a compact unread count on ordinary Accord responses;
arbitrary closed or sleeping applications cannot universally be awakened.

## Resource managers and product adapters

Accord can delegate a pool of resources to an external manager, or observe a tool's
status without owning it. The built-in adapters are for
[LLooM](https://github.com/Enntity/lloom) and
[Shrug](https://github.com/Enntity/shrug); neither is required.

Configure a manager in `managers.json` beside Accord's database before starting the
service:

```json
{"fleet":{"type":"lloom","url":"http://127.0.0.1:8080","tokenFile":"/home/example/.config/accord/lloom.key"}}
```

Accord advertises `fleet:<resource>`, durably records requests, and delegates
acquisition, renewal and release to the manager. It creates no competing local claim.
The manager must advertise `reservation-request-id-v1` and
`reservation-renew-until-v1`. Lost replies retry the same request; an ended request
never reacquires. Absolute renewal deadlines prevent retries extending a lease.
Manager leases are 60–300 seconds, with Accord's eight-hour total bound. Unknown
status and failed restoration do not grant access. Capacity limits count active
requests, including uncertain recovery, rather than completed history. Retry keys
and terminal records are retained: old commands cannot become new effects after
cleanup. Sessions and the command journal have no lifetime row-count cutoff.
Pending messages and active task/reservation queues remain bounded. Disk usage
still grows with retained history; safe archival/compaction is not yet implemented.

A manager written in any language can implement the same schedule HTTP contract
using `type:schedule-v1` and `basePath:/v1/schedule`. Required endpoints are the
board, `POST /reservations`, `GET /reservations/:id`, and POST `renew`/`release`.
Board shapes and state semantics match the included `lloom` adapter. The manager must
persist request IDs across restarts, reject changed replay payloads, preserve
absolute renewal deadlines and confirm restoration before freeing capacity.
This adapter does not add missing enforcement to a manager.

Accord can observe a serving tool through a status command:

```json
{"products":[{"id":"serving","type":"shrug","command":"/usr/local/bin/shrug","resource":"fleet:gpu-pair"}]}
```

Merge `products` into `awareness.json`. This runs only `shrug --json status`, at
most every 30 seconds, and publishes residency, rank and engine health. A healthy
resident service is idle, not unfinished agent work. Probe failure is unknown.
Generic `type:json` adapters use a configured absolute executable and argument
array, returning `{title,state,detail}`; these are trusted operator-installed
programs, never agent-supplied shell strings.

Product status is **observation-only**: it is not a reservation and fences nothing.
To cover containers with a reservation, use
[external workload registration](EXTERNAL-WORKLOADS.md).

## Upgrades

`npm run verify` exercises the kernel, session adapters, privacy, messaging,
monitor deduplication, migration and process recovery with isolated fixtures.
No qualification fixture contacts live models or GPUs.

Before upgrading a running installation, capture a consistent backup and inspect
active claims. A coordinator restart triggers normal fenced recovery. Do not
restart a live workload merely to change observation settings. Older binaries
refuse an upgraded database; roll back code together with a consistent pre-upgrade
backup only after accounting for work since that backup.
