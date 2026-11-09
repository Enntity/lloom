# Thin collaboration

Accord's normal workflow is join → announce → find → message → reserve → release.
It does not evaluate an agent's output or require a task lifecycle. The old task,
checkpoint, and receipt APIs remain for compatibility and recovery regression
coverage, but they are absent from the normal skill and most are hidden from the
MCP tool list. Reservations reuse their transactional ownership machinery internally.

## Installation and messaging

The installer uses absolute executable paths, keeps backups, preserves user
configuration, and refuses to replace conflicting entries. Participants announce
themselves explicitly.

The durable message implementation is a vendored SQLite store under `vendor/messenger`,
with its MIT license and pinned hashes. Accord adds address mapping and a durable host
transport outbox. There is one Accord process, with no separate messaging daemon or
account.

## Interface

HTTP/JSON is the service interface; CLI and stdio MCP are clients. The thin endpoint
is `POST /v1/collaboration` with `{operation,args,host?}`. Operations are `announce`,
`find`, `send`, `inbox`, `read`, `sent`, `resources`, `reserve`, `reservation`,
`release`, `renew`, `start`, and `process`. Mutations use idempotency keys. Clients
provide defaults, but callers should retain explicit keys for ambiguous retries.

A participant is the authenticated session, addressed as `host-authority/session-id`.
Labels and advertised capabilities never establish identity or grant authority.
MCP reuses a persistent session when its trusted launcher supplies a native
conversation ID: `CODEX_THREAD_ID`, `CLAUDE_SESSION_ID`, `ZCODE_SESSION_ID`, or
`TESSERA_TILE_ID`. ZCode also supplies `com.zcode/request-context.session_id`
in MCP call metadata; Codex desktop supplies `threadId` in its native MCP metadata.
A bridge trusts only the ID that belongs to the client that connected (and the
Tessera tile it runs in), so an agent started inside another agent's shell never
takes that agent's mailbox. Each conversation gets its own client even on a pooled
transport. These IDs never come from model tool arguments. Closing or crashing
the transport does not close the native conversation. Explicit session closure
still takes effect and cannot be undone by reconnecting.

`accord run` shares its private session file with subprocesses. Without a native
ID or inherited session, MCP creates an isolated session per connection. A new
session is a new participant, not a guessed continuation with the same name. Ordinary enrollment sessions persist until explicitly closed. A trusted
native conversation binding lets a reconnecting client read its prior unread
mail. This does not revive old credentials or transfer resource ownership.
Unbound sessions do not inherit mail based on matching names or directories.

Enrollment makes a session replyable immediately; announcing controls directory
metadata, not mailbox existence. Invalid local recipients fail the send immediately.
Remote failures remain durably queued and retry automatically. Ordinary API/tool
responses include a bounded `deliveryProblems` hint when outbound delivery fails
or stays queued for 30 seconds. It contains IDs/reasons, never message bodies;
`accord_more` with `tool: "accord_sent"` and `args: {id}` inspects one delivery.
Retry uncertain sends with the original key, not a new duplicate request.

Presence describes observations: recent announcement, unknown after two minutes
without one, or offline after session close/expiry. It is not a process liveness
claim. Activities are searchable metadata, not transcript ingestion.

Messages are stored before acknowledging queueing. Host delivery retries survive
coordinator restart; the receiving store deduplicates by sender and message ID.
Reading an inbox does not remove messages. Explicit `read` marks one delivery
handled, preventing a lost inbox response from silently losing mail. Processing
can occur more than once if the recipient crashes before marking read. The adapter
handles delivery lease tokens internally; agents need only the message's
`deliveryId`. Notifications are messages marked as notifications; no OS push or
arbitrary terminal typing is implied.

## Resources and recovery

`reserve` creates a queue entry owned by the authenticated session. Every resource
has capacity one; a pool is a group of such resources sharing one FIFO queue. Its queue survives restart; cancellation and queue expiry
remove a waiting request. CLI, MCP and the JavaScript client default to a one-hour
bounded window. `durationMs` requests a different window, including preparation,
starting when the claim is acquired, not while queued. The owning daemon persists
the deadline; no chat heartbeat is needed. Release early when finished.

`extend` with `durationMs` sets the deadline to at least that duration from now,
without changing the claim, generation or workload. It also converts an existing
live heartbeat lease to a window. Same-key retries return the original deadline.
A disconnected or crashed chat retains the window until its deadline; explicit
session close or coordinator/driver restart still initiates recovery. Windows are
finite (at most 30 days per request) even on indefinitely renewable resources.

Supervised launchers such as `withReservation` explicitly use `leaseMs` instead:
0.5–300 seconds, renewed automatically while their process lives. Legacy HTTP
requests without either timing field keep the five-minute heartbeat behavior.
The resource catalog advertises `reservation-windows-v1`; new clients refuse
window requests on older hosts before mutation. Compatibility resource managers
reject windows rather than silently granting a short lease.

Both modes remain subject to the resource ownership limit. A `managed-http` manifest may declare
`maxOwnershipMs` (one minute to 30 days) or `allowIndefinite: true`; a resource that
declares neither allows eight hours, and the catalog reports the effective
`maxOwnershipMs` (`null` when indefinite). Re-registering the same resource may change
only these two fields. Session close, expiry, and a heartbeat's coordinator restart
initiate recovery. A window keeps its claim, generation and deadline across a coordinator
restart: it reports `preparing` until the driver reconfirms the grant, and is revoked only
if the driver cannot. A reservation that lost ownership is terminal; it does not
silently reacquire another generation, and a participating holder that did not release
receives a notice. A fresh request joins the queue again.

A provider that no longer offers a resource answers its `availability` call with HTTP 404 and
error code `resource_unknown`. Once nothing holds, awaits or depends on that resource, the
coordinator removes it with its finished history, and the driver host removes its registration
and files. This runs a second after the coordinator starts and every ten minutes. An unreachable
provider or any other error keeps the resource. If the provider offers it again, registering the
same manifest restores it, and its generations continue above every generation it issued.

`release` needs no work-result receipt. For managed processes, it invalidates the
old grant and waits for the driver to stop the old group. Unknown release stays
held. Driver confirmation and fencing generations are internal implementation
mechanisms, not an agent-facing certification workflow. See the process driver
for the limits of POSIX groups, including escaped descendants and lost anchors.

The cooperative plugin records an agreement only. Its release confirms that the
logical reservation ended, not that an external workload stopped. It is useful for
repositories and conventions among cooperating agents. Do not register a GPU as
cooperative and report process isolation.

## Host links

`connect SSH_HOST` uses pinned OpenSSH host keys, forward and reverse loopback
ports, and separate per-direction link tokens. Each receiver binds its token to
one originating host; forwarded sender addresses must match that host and session.
A host pins the remote Accord authority before forwarding. Host-link credentials
cannot call admin routes. Existing discovery-only pairing remains read-only.

A host proves it holds the link before the other sends it a credential, so a process
holding a dropped tunnel's port gets nothing. Upgrade both ends of a link together: a
host from before this proof reads as unknown.

Linked hosts are trusted to represent their own agents and request worker-level
access to the linked host's registered resources. Accord has no per-resource
ACL or tenant isolation. Links expose registered activity and resource metadata, not files or admin credentials,
and session history only when the serving host opts in with `accord share-sessions`. Discovery is one hop.
Disconnecting a link does not declare a running workload stopped; leases and
resource-driver recovery remain authoritative.

Local work continues when a link fails. Remote discovery becomes unknown, messages
stay queued, and remote reservations remain owned by the remote authority. No
replacement authority is elected. The service restores a dead SSH tunnel by itself
with a per-host backoff of up to five minutes, reusing the saved link and pinned
identity. Removing an unreachable peer requires later cleanup on that peer; disconnect
reports this.

## Bootstrap

Installation adds managed blocks to Codex's global AGENTS.md (or its existing
override) and Claude's user CLAUDE.md, in addition to the skill and MCP registration.
The existing surrounding instructions remain intact. Installation also merges
bounded context hooks for Claude and Codex, with unread-count fallback for all
authenticated worker clients. See [message delivery](MESSAGE-DELIVERY.md).
Instruction loading conventions are documented by
[OpenAI](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and
[Anthropic](https://code.claude.com/docs/en/memory).

`npm run verify` records local fixture results and source hashes. The opt-in
`scripts/qualify-thin-ssh.mjs --confirm-live` uses isolated services on two hosts,
installed generic CLI agents, actual SSH, a killed process supervisor, and durable
ownership audits. `--models` additionally runs real Codex and Claude CLI processes.
Prompts describe the collaboration without naming tools. Credentials stay in private
temporary files.
