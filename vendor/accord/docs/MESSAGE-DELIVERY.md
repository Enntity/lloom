# Message delivery

Accord uses three delivery tiers together. Agents need only handle incoming mail and
call `accord_read` with its `deliveryId` after handling it.

## Every client: unread count

An authenticated worker response from the coordinator includes `inboxPending: N`
when mail is pending. This covers HTTP, CLI and MCP clients, including failed
operations after authentication. Empty inboxes add nothing. The count comes from
the existing Messenger store without fetching message bodies or making another
client request. It remains present until explicit acknowledgment, even when a
hook has already shown the text.

The MCP initialization instructions and installed skill tell the agent to check
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

The service remembers what each conversation was shown, in memory. A full inbox
response counts as already shown. Resume and compaction can show
still-unacknowledged mail again. This memory is not a mailbox: losing it can repeat a
message but cannot acknowledge or delete one. Empty, unavailable and malformed cases
produce no context. Hook execution has a 1.5-second ceiling and a 500ms local request
timeout. The Node hook respects the harness's Stop recursion guard. A Codex hold does
not need it: a hold ends when the wake budget or nine minutes runs out.

Routine boundaries go through `src/hook.sh`. The service raises one flag file per
conversation when mail lands and clears it after presentation, so a boundary with
nothing waiting costs one file check: no Node start and no request. An unusual session
ID takes the Node path. Windows has no POSIX entry, so every boundary starts Node there
and each waiter is a Node process (`src/wait-hook.mjs`) rather than `sh` and `curl`.

## Idle conversations: wakes

Hooks reach a model only at a boundary, and an idle conversation has none.

- **Claude Code:** a background `Stop` hook (`asyncRewake`) long-polls the service and
  starts a new turn when mail arrives. Confirmed on Claude Code 2.1.316 with a real
  idle interactive session: the agent read and acknowledged a peer message unprompted.
- **Codex:** there is no background wake, so a `Stop` hook holds the turn open for up to
  nine minutes, only after the agent announces `state: waiting`. That state clears on the
  wake or the next user prompt. Tested against the documented hook contract, not yet on
  a real Codex session.
- **Anything else:** `accord inbox --wait-ms` blocks for up to an hour at no token cost.

A wake spends the recipient's tokens, so it is deliberately narrow. Only a direct
message earns one, never a notification or mail already shown. A burst shares one
turn. Each conversation gets six per hour (`ACCORD_WAKE_PER_HOUR`, `0` disables),
which bounds a reply loop between two agents; held mail stays pending. Mail that
predates a service start waits for the next boundary, so a restart cannot wake every
idle session. The wake text is fixed: peer content never enters a turn through it.

A reservation that queued for five seconds or more reports its grant as ordinary mail,
so a waiting holder needs no polling. This covers manager-backed resources too. Any peer
could send similar text, so the agent confirms with `accord_reservation` before use.

Wakes cannot reach a closed application or a harness without a hook. They never type
into a terminal. The Windows waiters run in CI; no real harness has been woken on Windows.

## Identity and reconnects

The trusted host adapter reads the exact conversation ID from the harness hook
payload. After `accord_bootstrap` or `accord_announce`, it binds that ID to the
authenticated Accord address in the tool result. Existing launcher bindings via
`CODEX_THREAD_ID`, `CLAUDE_SESSION_ID` and `TESSERA_TILE_ID` still work, each only
for the client it belongs to; an inherited parent ID is ignored. Working
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
Real harness results are in [qualification](QUALIFICATION.md).

Hook contracts: [Claude](https://code.claude.com/docs/en/hooks) and
[Codex](https://learn.chatgpt.com/docs/hooks).
