# Install and join

Accord has an installer, distinct agent sessions, an MCP stdio bridge, and host
discovery. Each host runs its own coordinator and resource driver. There is
no required desktop app, model endpoint, cloud account, or central directory.

## One host

With Node 22.16+ and this source checkout:

```sh
node src/cli.mjs install --dry-run
node src/cli.mjs install
```

The default data directory is `~/.local/share/accord`. `--data DIR` overrides it.
Add `~/.local/bin` to PATH for the installed `accord` command. The installation
uses absolute executable paths for MCP, so MCP does not depend on your shell PATH.
Keep the checkout and Node executable in place; this is a source installation,
not a relocatable standalone binary.

The installer:

- Creates a host identity and private SQLite state when no data directory exists.
- Installs the CLI wrapper and skill under `~/.agents/skills/accord`.
- Registers MCP in Codex's config and Claude Code's user config, and installs a
  Claude skill copy. `--clients codex`, `--clients claude`, or `--clients ''`
  selects integrations. Other MCP clients can use the same stdio command.
- Writes `~/.config/accord/connection.json`, pinning the host authority and paths
  to endpoint and enrollment files. Secret values are absent from MCP config.
- Writes an optional `login-notice.sh`; it does not edit your shell profiles.

Dry-run changes nothing. Repeat installation keeps identical files. Customized
skills and merged config files get backups. Conflicting Accord MCP entries and
unmanaged CLI/profile files are refused before integration files are written.
Installation uses `--home DIR` for isolated tests or an explicitly chosen home.
It does not register system-wide agent integrations.

For user-service startup on macOS or Linux:

```sh
accord service install --dry-run
accord service install --enable
```

`accord install` now combines integration installation and service enablement;
use `--no-start` to configure a separate supervisor. See
[thin collaboration](THIN-COLLABORATION.md) for startup instructions and
`accord connect SSH_HOST` for automatic bidirectional pairing.
macOS uses a LaunchAgent at login; Linux uses a systemd user unit, whose ability
to run before login depends on user-manager configuration. Windows can run
`accord up` under an existing supervisor; automatic Windows service registration
is not implemented. See [qualification](QUALIFICATION.md) for what has run on real hosts.

Restart agent sessions after installing integrations. Then:

```sh
accord doctor
accord run -- claude
```

`doctor` verifies the profile, pinned authority, and every registered resource’s
live driver observation. SSH notices list all resources. It cannot verify that a
desktop harness loaded its MCP configuration. Codex filters the environment it passes
to MCP servers, so the installer forwards the `ACCORD_*` paths and identifiers through
its `env_vars` setting; secret values stay in private files.

## Agent sessions

MCP tool calls lazily create one session for the MCP server process. The
`accord_bootstrap` response contains that identity, host ownership, tasks,
checkpoints, events, and directly paired hosts. Separate MCP processes get
separate identities even when they use the same label or folder.

`accord run -- COMMAND` creates a session before launching the child. It provides
`ACCORD_SESSION_ID`, `ACCORD_SESSION_FILE`, `ACCORD_CONTEXT_FILE`, and
`ACCORD_PROFILE`. The credential lives in a mode-0600 file, not argv or a token
environment variable. The initial context is a snapshot; `accord context` obtains
a fresh one. MCP children inherit this session instead of creating another.
Codex filters MCP subprocess environments, so its installed registration explicitly
forwards five `ACCORD_*` variables (the session ID,
session file, context file, profile, and URL). No credential value is placed in
Codex configuration. Reinstalling upgrades the exact earlier Accord registration
with a backup, including one an install from another folder or Node wrote, and its
service file; customized conflicting entries still require manual resolution.

Shell agents can use `accord claim`, `wait`, `inspect`, `checkpoint`, `renew`,
`write`, and `finish`; see `accord --help`. Mutations require an explicit `--key`
for safe retries. A claim in `preparing` is not usable: inspect it until `running`.
The wait command waits for admission; activation can still be preparing.

Sessions expire after eight hours by default (API range: one second to 24 hours).
Closing or expiring a session revokes its unfinished claims. The resource remains
held until the driver confirms release. A graceful wrapper exit closes its
session and removes its files. After a hard wrapper kill, claim deadlines still
bound abandoned ownership; leftover credential files expire with the session.
A session is an authenticated identity inside one trusted OS-user domain, not
isolation from other processes that can read that user's files.

Credentials have distinct purposes:

| File | Authority |
| --- | --- |
| `admin.token` | Local administrative operations, pairing, pause, cancellation |
| `bootstrap.token` | Create worker sessions; cannot inspect work or claim directly |
| `discovery.token` | Read host and resource ownership metadata only |
| Session credential | Worker operations under one expiring session identity |
| `driver-control.token` | Private coordinator-to-driver control |

## Hosts joining a network

Every host has a persistent authority ID; a resource is addressed as
`<authority>/artifact`. Pairing adds a pinned discovery connection. It does not
copy leases, elect another resource owner, grant remote worker access, or transfer
admin credentials. Pairings are directional; pair each desired observer explicitly.
This is a small one-hop directory, capped at 32 peers, without transitive discovery.

This release binds HTTP to loopback. Between machines use an authenticated SSH
forward (or another explicitly managed local transport with equivalent security).
For example, with a preconfigured SSH host and verified host key:

```sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18787:127.0.0.1:8787 worker-host
```

Obtain the authority ID from `accord host` on the remote host. Provision a local
private copy of that host's discovery credential through your existing secure
channel, then on the observing host:

```sh
accord join --url http://127.0.0.1:18787 \
  --authority REMOTE_AUTHORITY --discovery-file /private/path/remote-discovery.token
accord network
```

Pairing verifies the authority before saving it. Live discovery rechecks that
identity. An unreachable or replaced peer is `unknown`, with a local check time;
no cached observation grants work. `accord leave --authority ID` removes pairing.
Discovery credentials are stored in the private coordinator database, never
returned in board, network, or event responses. Peers see owner/task identifiers
and resource state, not task input or checkpoints.

A remote agent needs a separately provisioned enrollment profile; discovery alone
cannot create sessions. A profile can use `url` instead of `endpointFile`:

```json
{
  "schema": 1,
  "authority": "REMOTE_AUTHORITY",
  "url": "http://127.0.0.1:18787",
  "enrollmentFile": "/private/path/remote-bootstrap.token",
  "discoveryFile": "/private/path/remote-discovery.token"
}
```

Use `accord run --profile PROFILE -- COMMAND` or register `accord mcp --profile
PROFILE` in the client. Artifact operations can travel through the coordinator;
only one forward is required. Worker capabilities remain scoped to that host.
The isolated suite uses a local TCP forward. The separate live qualification
uses a verified OpenSSH connection to a Linux host, including disconnect/reconnect.

For an agent that arrives through SSH directly:

```sh
ssh worker-host 'accord host --notice'
ssh worker-host 'accord host'
```

The first prints an advisory notice; the second prints JSON. Interactive shells
can source the installed login-notice script. Noninteractive SSH must query
explicitly because it may not run a login profile. Failed discovery says UNKNOWN
and exits nonzero. Terminal labels are escaped. Notices never grant access.

## Reproduce the fresh-agent proof

```sh
npm run demo:bootstrap
npm run verify
```

The new demo installs into a temporary home. A first session holds an artifact
lease and checkpoints. A separate fresh process receives only the profile, sees
the existing holder, and starts waiting without a supplied task ID. The driver is
killed and the first owner stops renewing. The incoming process observes
revocation pending and cannot acquire. After driver restart and confirmed
revocation, it gets a higher generation, resumes the checkpoint, writes the
artifact, and finishes. The old grant is refused. The proof records coordinator
events and driver audit in `evidence/bootstrap.json` when it runs and removes temporary state.

## Install options

`accord install` sets up Claude Code and Codex, plus every other agent it finds: OpenCode,
Grok Build, OMP, Hermes, ZCode, DeepSeek Harness and Devin. `--clients a,b` picks them
yourself. Each agent gets its MCP entry and startup instructions in its own config, with a
backup. An agent whose config Accord cannot safely edit is reported as `skipped`, and the
rest continue. Only Claude Code and Codex get hooks. DeepSeek Harness uses a home-level
`cordis.patch.yml`, so one entry reaches `dsh`, `dsh web` and the desktop app.

No npm runtime dependencies are required. `accord install --dry-run` previews the
changes. Use `--no-start` for a custom supervisor, and `--clients ''` for a host
with no Codex or Claude integration. Add `~/.local/bin` to your shell PATH if needed;
MCP uses absolute paths. `accord doctor` checks the local service. The browser board
is at `http://127.0.0.1:8787`; use the local admin token file shown by `accord up`.
Credentials are held in memory by the board, not browser storage.

## The agent loop

- **Join and announce:** a session address, capabilities, location, and current activity.
- **Find:** search participants across explicitly linked hosts. Offline and stale
  observations remain visible as such.
- **Send and receive:** durable direct messages and notifications, pending until
  marked read. Queued, delivered, read, and acted upon are different facts.
- **Reserve:** a FIFO queue per resource, a renewable lease, and release. No task
  definition, checkpoint, expected output, or result receipt is required.

The MCP tool list holds the daily loop in under 1,000 tokens; `accord_more` reaches
jobs, reports, questions, telemetry and workloads on demand. Any MCP client can run `accord mcp`. Shell-only
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
or wake a closed conversation. Everywhere else, `accord inbox --wait-ms` blocks for
up to an hour at no token cost and returns as soon as mail lands.

## Resource pools

Add `"capacity": N` (2 to 32) to a cooperative or process manifest to register a pool.
Managed providers can't be pooled, because a provider has one workload per registration. Reserve the pool's
name to get the next free slot, first come first served. Slots `name-0` to `name-(N-1)`
are ordinary resources, so fencing and recovery stay per slot. Each physical asset must
have one authoritative host. Multi-host atomic reservations, GPU isolation, and
automatic vendor installation are not implemented.

## Sessions and latency

Join responses are capped at 4 KiB and `find` at 8 KiB, with recent collaborators
and small resource and inbox previews. Full history stays behind search, board, resources and inbox
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
A durable session never extends a lease or revives an old grant.

Start with `accord_bootstrap({label, activity, key})` to join and publish current
work in one call, before launching long-running tools or subagents. Optional
`location` and `capabilities` make that work discoverable. No-argument bootstrap
remains supported. Retain the key and payload when retrying an ambiguous result.

Clients can queue tool calls behind running work. Combining startup calls removes a
scheduling step; it cannot bypass queues or approvals in the client.

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
