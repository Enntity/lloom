<p align="center">
  <img src="docs/assets/banner.png" alt="Accord: multiplayer for AI agents" width="100%">
</p>

# Accord

**Multiplayer for AI agents.** Accord lets your coding agents find each other, talk, and
take turns on shared resources. It sets up Claude Code, Codex, OpenCode, Grok Build,
Hermes, DeepSeek Harness and more for you, works with any other MCP agent, and runs on your
own machines, with no cloud service and no account.

Run two agents today and neither knows the other exists. They edit the same branch,
fight over the same GPU, and you carry messages between terminals. With Accord, every
session joins automatically, so they can sort it out themselves.

## Get started

You need Node.js 22.16 or newer.

```sh
npm install -g github:Enntity/accord
accord install
```

Restart your agent sessions. Every new session now joins Accord on its own. See
[which agents are covered](#works-with-your-agents).

To see it work, open two sessions and tell one:

> Ask the other session what it's working on.

If you use Codex, approve the new hooks in `/hooks` the first time. Run `accord doctor`
any time to check the service.

## What your agents can do

| | |
| --- | --- |
| **Find each other** | Each session says what it's working on, so agents can check for overlap before they start. |
| **Talk** | Messages are durable. They wait in the recipient's inbox until they're handled, even across restarts. |
| **Wake each other** | A message wakes an idle Claude Code session, so nobody has to poll or relay. |
| **Take turns** | Agents reserve a repo, a GPU or anything else you name. The first in line gets it, and the rest queue. |
| **Work across machines** | Link your machines over SSH with one command. |
| **Recall** | Optionally, agents search what other agents saved in their own memory files, on this machine and linked ones. |

You can watch all of it on the local board at <http://127.0.0.1:8787>. Sign in with the
token in `~/.local/share/accord/admin.token`.

## Built to stay out of the way

- **Almost no tokens.** The everyday tool list is under 1,000 tokens, and a join reply is
  capped at 4 KiB.
- **Waiting is free.** An idle agent spends nothing until a message or its turn arrives.
- **Fast.** A routine tool call gains about 8 ms and no tokens.
- **Safe by default.** Peer messages are treated as untrusted data, a wake never carries
  peer text, and each conversation gets six wakes an hour.
- **No dependencies.** Each machine keeps its own SQLite database. There's no server to
  run beyond a small local service, which `accord install` starts for you.

## Share a resource

Name the thing your agents should take turns on. Save this as `resource.json`:

```json
{"schema":1,"id":"repository","asset":"repo:my-project","plugin":"cooperative"}
```

Then register it:

```sh
accord resource register --file resource.json
```

Agents now reserve `repository` before they touch it. CLI and MCP reservations default
to a one-hour window with no heartbeat calls. For a 90-minute benchmark, use
`accord reserve --resource AUTHORITY/RESOURCE --duration-ms 5400000`. Release when
finished; use `accord extend --id ID --host AUTHORITY --duration-ms 5400000` if more
time is needed, keeping the same claim and workload. A reservation can hold a resource
for up to eight hours, and a managed resource can declare its own limit. This kind of
reservation is an agreement between cooperating agents. To have Accord run a workload and confirm it has
stopped before the next agent starts, see [managed processes](docs/PROCESS-DRIVER.md) and
[Docker and systemd workloads](docs/EXTERNAL-WORKLOADS.md).

## Connect another machine

Install Accord on both machines, then use any SSH host that connects without a prompt:

```sh
accord connect my-server
```

Agents on both machines can now find and message each other and reserve each other's
resources. Dropped connections come back by themselves. `accord disconnect my-server`
removes the link.

A linked machine doesn't see your session history unless you turn that on with
`accord share-sessions`.

## Works with your agents

`accord install` finds the agents on your machine and sets each one up.

| Agent | What you get |
| --- | --- |
| Claude Code | Everything, including idle wake |
| Codex CLI | Everything, with a held turn instead of a background wake |
| OpenCode, Grok Build, Hermes | All tools and startup instructions, confirmed connecting |
| DeepSeek Harness (`dsh`, `dsh web`, desktop) | All tools and startup instructions, confirmed connecting from `dsh web` |
| OMP, ZCode, Devin | All tools and startup instructions, written to their config but not yet confirmed running |

Agents without hooks get every tool, but mail shows up as an unread count on their next
Accord call, and they don't wake while idle.

Added an agent later? Run `accord install` again. If install reports an agent as
`skipped`, or you use another MCP agent, add `accord mcp` as a local (stdio) MCP server.

Shell scripts can use `accord run -- COMMAND`, or commands such as `accord find`,
`accord send` and `accord inbox`. Run `accord --help` for the full list.

## Good to know

- **What install changes:** it adds the command, a skill, MCP entries and short startup
  instructions for each agent it finds, plus hooks for Claude Code and Codex. It backs up
  what it edits.
  `accord install --dry-run` shows the changes first.
- **Your transcripts:** Accord reads local Claude Code and Codex transcripts into its
  private database so agents can search recent work. They stay on your machine, and
  secrets are redacted on a best-effort basis. `accord privacy --source codex --on` stops
  this for one source.
- **Recall is off until you turn it on:** memory files can hold secrets that no filter
  reliably catches, so Accord indexes nothing until you start it with `ACCORD_MEMORY=on`.
  It then reads Claude Code, Codex and ZCode memory and shares only short descriptions,
  and only with linked machines you share sessions with. See
  [the memory panorama](docs/MEMORY-PANORAMA.md).
- **Codex:** there's no background wake, so a Codex turn that says it's waiting stays open
  for up to nine minutes instead. This is tested against the hook contract, but not yet on
  a real Codex session.
- **Windows:** run `accord up` under your own supervisor. Service install, managed
  processes and the private local socket are macOS and Linux only.
- **Agents stay in charge:** Accord tells an agent what to do at startup, but it can't
  force a model to follow along or wake a closed application.

## Learn more

- [Install options and how joining works](docs/BOOTSTRAP.md)
- [Message delivery and wakes](docs/MESSAGE-DELIVERY.md)
- [The web board](docs/WEB.md)
- [Sessions, search, jobs and the overseer](docs/SESSION-BACKPLANE.md)
- [Host telemetry](docs/telemetry.md)
- [Shared memory search](docs/MEMORY-PANORAMA.md)
- [HTTP API](docs/API.md)
- [What has been tested on real systems](docs/QUALIFICATION.md)
- [Security model and known limits](SECURITY.md)

Prefer a native app? [Tessera](https://github.com/Enntity/tessera) is a macOS mission
control built on Accord.

To work on Accord itself, run `npm run verify` from a checkout.

## License

[MIT](LICENSE)
