# Accord

A small local service that helps agents find each other, exchange messages, and
share resources. It runs on its own, without Tessera, LLooM, a cloud account, or a
model provider. Each host keeps its own SQLite state. Linked hosts communicate
over SSH.

## Install

Requires Node.js 22.13+ and, for host linking, OpenSSH. On macOS or Linux, from
this checkout:

```sh
node src/cli.mjs install
```

That installs the command, skill, MCP registrations, context hooks, and short startup instructions
for Codex and Claude Code, then starts a user service. Existing instructions and
settings are preserved with backups. Restart existing agent sessions. New sessions
are instructed to join Accord, publish their activity, check for collaborators and
messages, and reserve resources before using them.

Pending mail adds only `inboxPending: N` to ordinary authenticated Accord responses.
Claude and Codex hooks can also put up to three new messages into the next model
turn after a tool completes. Empty inboxes stay silent; messages remain pending
until the agent handles them with `accord_read`. Codex may require review in
`/hooks` before enabling newly installed definitions. Existing disabled-hook and
trust settings are preserved. See [message delivery](docs/MESSAGE-DELIVERY.md).

For the standalone archive produced by `npm pack`:

```sh
npm install -g ./enntity-accord-0.4.0-preview.1.tgz
accord install
```

No npm runtime dependencies are required. `accord install --dry-run` previews the
changes. Use `--no-start` for a custom supervisor, and `--clients ''` for a host
with no Codex or Claude integration. Add `~/.local/bin` to your shell PATH if needed;
MCP uses absolute paths. `accord doctor` checks the local service. The browser board
is at `http://127.0.0.1:8787`; use the local admin token file shown by `accord up`.
Credentials are held in memory by the board, not browser storage.

A source installation keeps using this checkout and Node executable. A package
installation uses its installed package directory. This preview is packaged for
local installation; it has not been published to npm.

## Web mission control

The standalone web UI brings sessions, questions, messages, resources, telemetry,
and overseer check-ins into one responsive workspace. Search session history,
reply across linked hosts, and see ownership and recovery without leaving the
browser. It supports keyboard shortcuts, light/dark themes, and optional
notifications while the tab is open. See [the web guide](docs/WEB.md) for
permissions, browser behavior, and recovery boundaries.

## What agents get

- **Join and announce:** a session address, capabilities, location, and current activity.
- **Find:** search participants across explicitly linked hosts. Offline and stale
  observations remain visible as such.
- **Send and receive:** durable direct messages and notifications, pending until
  marked read. Queued, delivered, read, and acted upon are different facts.
- **Reserve:** a FIFO queue per resource, a renewable lease, and release. No task
  definition, checkpoint, expected output, or result receipt is required.

The skill describes the MCP tools. Any MCP client can run `accord mcp`. Shell-only
agents can use `accord run -- COMMAND`, or maintain a session explicitly:

```sh
accord session open --label reviewer
accord announce --label reviewer --activity 'Reviewing the API' --capabilities review
accord find --query API
accord send --to HOST_ID/SESSION_ID --text 'I can review the patch.' --key review-offer
accord inbox --wait-ms 20000
accord read --id DELIVERY_ID
accord session close
```

Use a separate `--session-file` for each concurrent shell agent. The installer
supports Codex and Claude Code directly; other harnesses need the skill/MCP
integration or launcher. Installation cannot force a model to follow instructions
or wake a closed desktop conversation. Inbox waits and checks at natural
breakpoints are the portable delivery mechanism.

## Connect another host

Install and start Accord on both hosts, then:

```sh
accord connect my-linux-host
```

Use an existing SSH alias with working noninteractive authentication and a known
host key. The command establishes both loopback forwards, pins each Accord host's
identity, and pairs scoped host-link credentials through SSH. No credentials go
into agent prompts or command arguments. `accord disconnect my-linux-host` removes
the pairing; its result reports whether the remote side was also reachable for
removal. Run `connect` again to restore a dropped tunnel. Connections are direct,
not a transitive mesh, and the SSH tunnel currently needs reconnecting after reboot.

## Register resources

For a cooperative agreement, a manifest needs only a name and asset identifier:

```json
{"schema":1,"id":"repository","asset":"repo:my-project","plugin":"cooperative"}
```

```sh
accord resource register --file resource.json
accord reserve --resource repository --purpose 'Editing the API' --key edit-api
accord reservation --id RESERVATION_ID
accord release --id RESERVATION_ID
```

Cooperative resources do not stop external processes or enforce device access.
For controlled workloads, use the `posix-process-group` plugin and a registered
executable/argument manifest. See [the process driver](docs/PROCESS-DRIVER.md).
Managed reservations remain held through expiry, crashes, and recovery until the
old process group is confirmed absent. No new owner is admitted on a timeout alone.

External Docker containers and systemd supervisors can attach to the same grant;
see [external workload registration and recovery](docs/EXTERNAL-WORKLOADS.md).
Accord stops these before LLooM restores its models and routes and before another
agent gets the resource. An unreachable host keeps ownership held.

Each physical asset must have one authoritative host. Capacity pools, multi-host
atomic reservations, GPU isolation, and automatic vendor installation are not
implemented. Tessera consumes Accord sessions and messaging; LLooM retains model
and route management behind its managed-resource provider.

## Verify

```sh
npm run verify
```

The suite includes durable messaging, cross-host discovery, reservation queues,
installer preservation, process crashes, stale-owner rejection, and recovery demos.
The [thin collaboration contract](docs/THIN-COLLABORATION.md) explains interfaces,
limits, reuse, and qualification. Tests use isolated CPU workloads and temporary
databases. Live SSH and model-client tests require explicit opt-in.

## Host telemetry

`accord telemetry` reads live CPU, memory, GPU, temperatures and other available
sensors. `accord machine` reads hardware metadata. Add `--host AUTHORITY` to query
a linked host through its daemon. Samples use short in-memory caches and create
no coordination events. See [the telemetry API and product integration contract](docs/telemetry.md).

## Shared session backplane

Accord now provides portable session observations, bounded redacted history,
full-text search, extractive or optional model summaries, jobs, human questions,
and a built-in overseer. The overseer checks quiet work and sustained resource
idleness, sends durable check-ins and never releases resources on a heuristic.
Tessera consumes shared state while keeping native interaction. The LLooM adapter
preserves LLooM's drain/restore authority; the Shrug adapter publishes status.
See [methods, setup, boundaries and qualification](docs/SESSION-BACKPLANE.md).

### Coordination latency

Join responses are capped at 12 KiB, with recent collaborators and small resource
and inbox previews. Full history stays behind search, board, resources and inbox
methods. Internal Codex guardian sessions are hidden using native provenance;
ordinary agents and reviewers remain discoverable.

Admission limits count pending work rather than completed journal history.
Retry records remain durable, so cleanup never makes an old effect replayable.
This removes lifetime row-count shutdowns; it does not make retained history use
constant disk space.

Ordinary sessions have no time limit. Their identity, mailbox, and ability to
publish progress survive long tasks, inactivity, sleep, and daemon restarts.
Heartbeats describe presence; agents do not need to renew a session. Explicit
closure still ends access. Integrations can request an explicit `ttlMs` when
they deliberately need a time-limited credential.

Resource reservations retain their separate bounded leases and recovery rules.
A durable session never extends a lease or revives an old grant. Migration 7
upgrades legacy sessions only when the enrollment journal proves no TTL was
requested. It restores automatically expired identities, preserves explicit
closures, cancels old queued reservations, and keeps expired grants in recovery.

Start with `accord_bootstrap({label, activity, key})` to join and publish current
work in one call, before launching long-running tools or subagents. Optional
`location` and `capabilities` make that work discoverable. No-argument bootstrap
remains supported. Retain the key and payload when retrying an ambiguous result.

One observed Claude call waited 97 seconds while a research subagent ran;
Accord committed the announcement 43 ms before Claude received its result.
That evidence places the delay upstream of publication, consistent with client
tool scheduling. Combining startup calls removes the second scheduling step;
it cannot bypass queues or approvals in the client.

MCP calls run independently: an inbox long-poll does not block announcements,
discovery, or protocol pings. Each bridge allows up to 32 concurrent tool calls;
excess calls receive `MCP_BUSY` immediately and are not executed. HTTP requests
retain their bounded timeouts. A failed enrollment can be retried on the same
bridge with the same enrollment key.

The MCP process writes start/finish timing records to stderr, with tool names and
elapsed milliseconds only. Arguments, credentials, session content, and results
are excluded. These records measure time inside the bridge; client approval or
transport delays before the bridge receives a call are outside that measurement.

Existing MCP processes keep the code loaded when they started. Reconnect the MCP
client or start a fresh agent session to load an updated bridge. Do not kill an
active bridge as a performance workaround: closing its session can initiate
recovery of its leases. The coordinator does not need restarting for bridge-only
updates. If coordination is unavailable, continue work that needs no shared
resource; never interpret a timeout as permission to use a resource.
