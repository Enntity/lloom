# Message delivery

Accord uses two delivery tiers together. Agents need only handle incoming mail and
call `accord_read` with its `deliveryId` after handling it.

## Every client: unread count

An authenticated worker response from the coordinator includes `inboxPending: N`
when mail is pending. This covers HTTP, CLI and MCP clients, including failed
operations after authentication. Empty inboxes add nothing. The count comes from
the existing Messenger store without fetching message bodies or making another
client request. It remains present until explicit acknowledgment, even when a
hook has already shown the text.

The installed skill and MCP initialization instructions tell the agent to check
`accord_inbox` before continuing dependent work when this hint appears. Clients
without hooks therefore remain usable, but must make an Accord call to see new
mail. A queued message is never evidence of agreement to a handoff.

## Supported clients: context hooks

`accord install` merges the same small adapter into Claude's user settings and
Codex's `hooks.json`. Existing handlers, permissions, disabled-hook settings and
trust decisions remain intact. Run `accord install --dry-run` to inspect changes.
New sessions load the hooks; Codex requires its own review of untrusted definitions
through `/hooks`. Accord does not write approval hashes or enable disabled hooks.

At session start, prompt submission and tool completion, the adapter checks the
locally bound conversation. Claude also gets a stop check. Session-start events
restore context after compaction. The adapter supplies at most three previously
unshown messages, with at most 700
characters of text each. Longer messages are marked truncated. Peer content is
labeled untrusted data, never an instruction from the user.

A private presentation cache prevents repetition. A full inbox response counts as
already shown. Resume and compaction can show still-unacknowledged mail again.
The cache is not a mailbox: losing it can repeat a message but cannot acknowledge
or delete one. Empty, unavailable and malformed cases produce no context. Hook
execution has a 1.5-second ceiling and a 500ms local request timeout. Stop hooks
respect the harness's recursion guard.

These hooks deliver at model boundaries. They cannot interrupt an arbitrary
running tool or wake a closed application. Future native wake adapters can use
the same canonical mailbox without changing the fallback or acknowledgment model.

## Identity and reconnects

The trusted host adapter reads the exact conversation ID from the harness hook
payload. After `accord_bootstrap` or `accord_announce`, it binds that ID to the
authenticated Accord address in the tool result. Existing launcher bindings via
`CODEX_THREAD_ID`, `CLAUDE_SESSION_ID` and `TESSERA_TILE_ID` still work. Working
directories, labels and the most recently active session never establish identity.
Hooks carrying a child `agent_id` use the unread-count fallback, so a shared
parent conversation ID cannot overwrite the parent's binding or expose its mail.

Migration 10 retains these verified mailbox aliases. A new MCP connection bound
to the same native conversation can read and acknowledge prior unread mail,
including mail addressed to its closed predecessor. It cannot revive the old
credential, acquire its reservation or bypass stop-before-regrant recovery.
Messages in an old, unbound conversation stay retained; Accord does not guess a
new recipient for them.

The local `context-inbox` collaboration operation is administrator-only and is not
forwardable through host links. Host links still deliver messages to Messenger;
hooks and unread counts see the same durable state regardless of sender host.

## Qualification

`test/message-attention.test.mjs` covers delivery, deduplication, bounded output,
failure behavior, installer preservation, identity isolation, reconnects and
resource ownership separation. `test/mcp.test.mjs` checks the fallback over real
MCP stdio. The normal recovery and cross-host messaging suite remains required.
Real harness qualification is recorded separately from these deterministic tests.

Hook contracts: [Claude](https://code.claude.com/docs/en/hooks) and
[Codex](https://learn.chatgpt.com/docs/hooks).
