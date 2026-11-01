# Thin collaboration

Accord's normal workflow is join → announce → find → message → reserve → release.
It does not evaluate an agent's output or require a task lifecycle. The old task,
checkpoint, and receipt APIs remain for compatibility and recovery regression
coverage, but they are absent from the normal skill and most are hidden from the
MCP tool list. Reservations reuse their transactional ownership machinery internally.

## Reuse

The CLI/skill/MCP installer follows Tessera's installer: absolute executable paths,
backups, preserved user configuration, and refusal to replace conflicting entries.
The board, activity, send, and inbox vocabulary follows Tessera's AgentDesk and
control-plane conventions. Its Swift/macOS runtime and passive transcript watchers
are not dependencies or bundled code. Participants announce themselves explicitly.

The durable message implementation is the unchanged SQLite store from Enntity
Messenger commit `08a788e25a80650f7a0355341852975cbe424d2b`, included under
`vendor/messenger` with its MIT license and verified upstream hashes. Accord adds
address mapping and a durable host transport outbox. There is one Accord process
installation, with no separate messaging daemon, account, or MongoDB dependency.
No entity account or production Messenger deployment is involved.

## Interface

HTTP/JSON is the service interface; CLI and stdio MCP are clients. The thin endpoint
is `POST /v1/collaboration` with `{operation,args,host?}`. Operations are `announce`,
`find`, `send`, `inbox`, `read`, `sent`, `resources`, `reserve`, `reservation`,
`release`, `renew`, `start`, and `process`. Mutations use idempotency keys. Clients
provide defaults, but callers should retain explicit keys for ambiguous retries.

A participant is the authenticated session, addressed as `host-authority/session-id`.
Labels and advertised capabilities never establish identity or grant authority.
MCP creates one session per connection. `accord run` shares its private session file
with subprocesses; explicit shell sessions can reconnect to the same inbox. A new
session is a new participant, not a guessed continuation of another with the same
name. Ordinary enrollment sessions persist until explicitly closed. A trusted
native conversation binding lets a reconnecting client read its prior unread
mail. This does not revive old credentials or transfer resource ownership.
Unbound sessions do not inherit mail based on matching names or directories.

Presence describes observations: recent announcement, unknown after two minutes
without one, or offline after session close/expiry. It is not a process liveness
claim. Activities are searchable metadata, not transcript ingestion.

Messages are stored before acknowledging queueing. Host delivery retries survive
coordinator restart; receiving Messenger deduplicates by sender and message ID.
Reading an inbox does not remove messages. Explicit `read` marks one delivery
handled, preventing a lost inbox response from silently losing mail. Processing
can occur more than once if the recipient crashes before marking read. The adapter
handles Messenger delivery lease tokens internally; agents need only the message's
`deliveryId`. Notifications are messages marked as notifications; no OS push or
arbitrary terminal typing is implied.

## Resources and recovery

`reserve` creates a queue entry owned by the authenticated session. Every resource
has capacity one. Its FIFO queue survives restart; cancellation and queue expiry
remove a waiting request. A running reservation defaults to a five-minute lease,
renewable up to eight hours total. Session close, expiry, and coordinator restart
initiate recovery. A reservation that lost ownership is terminal; it does not
silently reacquire another generation. A fresh request joins the queue again.

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

Linked hosts are trusted to represent their own agents and request worker-level
access to the linked host's registered resources. This preview has no per-resource
ACL or tenant isolation. Links expose registered activity and resource metadata,
not arbitrary transcripts, files, or admin credentials. Discovery is one hop.
Disconnecting a link does not declare a running workload stopped; leases and
resource-driver recovery remain authoritative.

Local work continues when a link fails. Remote discovery becomes unknown, messages
stay queued, and remote reservations remain owned by the remote authority. No
replacement authority is elected. Re-run `connect` to restore a dead SSH tunnel;
autostart/reconnection of these tunnels is not yet installed as a service. Removing
an unreachable peer requires later cleanup on that peer; disconnect reports this.

## Bootstrap and qualification

Installation adds managed blocks to Codex's global AGENTS.md (or its existing
override) and Claude's user CLAUDE.md, in addition to the skill and MCP registration.
The existing surrounding instructions remain intact. Installation also merges
bounded context hooks for Claude and Codex, with unread-count fallback for all
authenticated worker clients. See [message delivery](MESSAGE-DELIVERY.md).
Instruction loading conventions are documented by
[OpenAI](https://learn.chatgpt.com/docs/agent-configuration/agents-md) and
[Anthropic](https://code.claude.com/docs/en/memory).

`npm run verify` records local fixture results and source hashes. The opt-in
`scripts/qualify-thin-ssh.mjs --confirm-live` uses isolated Mac and Linux services,
installed generic CLI agents, actual SSH, a killed process supervisor, and durable
ownership audits. `--models` additionally runs real Codex and Claude CLI processes;
Claude's MCP connection reaches the Linux authority over SSH. Prompts describe the
collaboration without naming tools. Credentials stay in private temporary files.
Current results live in `evidence/thin/`; these are separate from historical
artifact-only client qualifications in `evidence/live/`.

This work does not replace Tessera's native UI, passive discovery, wake adapters,
transcript access, or human question UI. LLooM keeps inference, jobs, scheduling,
model restoration, and routing until separate parity tests authorize migration.
