<p align="center">
  <img src="docs/assets/banner.png" alt="Accord: multiplayer for AI agents" width="100%">
</p>

# Accord

[![CI](https://github.com/Enntity/accord/actions/workflows/ci.yml/badge.svg)](https://github.com/Enntity/accord/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Enntity/accord)](https://github.com/Enntity/accord/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Multiplayer for AI agents.** Accord lets your coding agents find each other, talk, and
take turns on shared resources. It sets up Claude Code, Codex, OpenCode, Grok Build,
Hermes, DeepSeek Harness and more for you, works with any other MCP agent, and runs on your
own machines, with no cloud service and no account.

One agent is editing the checkout. Another is about to reset it. A third needs the
GPU the first one reserved. Accord gives them a shared directory, durable messages,
and a queue, so you can stop carrying updates between terminals.

**0.6.2:** reservation windows survive a coordinator restart, such as a service manager
recovering from an OOM kill, and holders are told when a reservation ends.
[Release notes](CHANGELOG.md) · [Upgrading](docs/UPGRADING.md)

## Get started

You need Node.js 22.16 or newer. macOS and Linux support automatic service setup.
On Windows, run `accord up` under your own supervisor after installation.

```sh
npm install -g https://github.com/Enntity/accord/releases/download/v0.6.2/enntity-accord-0.6.2.tgz
accord install
```

On Windows, use `accord install --no-start`, then `accord up`.

Restart your agent sessions. Configured clients receive startup instructions to join
Accord. See
[which agents are covered](#works-with-your-agents).

To see it work, open two sessions and tell one:

> Find the other session, ask what it is working on, and read its reply.

Then try a handoff:

> Tell the other session which files you changed and ask it to review them.

The recipient can find your address and reply through Accord. Idle wake is available
in Claude Code; other clients receive pending mail on their next Accord call.

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

## How it works

```text
Claude Code ─┐                         ┌─ Codex
Codex ───────┼─ Accord + SQLite ── SSH ──┤  Accord + SQLite
Other MCP ───┘     your laptop          └─ your server
```

Each host runs a small Node service with its own SQLite database. The everyday MCP
surface is compact; less common tools are available on demand. Accord makes no model
calls and has no runtime npm dependencies. Your agent's normal model usage still applies.

Messages survive restarts. Resource grants carry a generation, so a stale worker cannot
reclaim an expired grant through Accord. When a driver cannot confirm that work has
stopped, the resource stays held. [Ownership and recovery](docs/RECOVERY.md) describes
the failure boundaries and the tests behind them.

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
for up to eight hours by default; a managed resource can declare another limit.

A cooperative reservation does not lock files or isolate a GPU. All agents using that
resource must participate. To have Accord run a workload and confirm it has stopped
before the next agent starts, see [managed processes](docs/PROCESS-DRIVER.md) and
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
| Claude Code | Discovery, messages, reservations and idle wake |
| Codex CLI | Discovery, messages and reservations; held-turn hook tested in fixtures |
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
- **Upgrades:** wait for active reservations to finish before restarting the service.
  Restart fences existing grants. [Upgrade instructions](docs/UPGRADING.md) cover both
  service managers and verification.
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

## Contributing

Bug reports are useful when they include `accord --version`, your OS and Node version,
what you expected, and a small reproduction. Remove tokens, transcripts and private
paths before posting. Report security vulnerabilities through
[private reporting](https://github.com/Enntity/accord/security/advisories/new).

To work on Accord itself:

```sh
git clone https://github.com/Enntity/accord.git
cd accord
npm run verify
```

No dependency install or model account is needed for the tests. They run isolated
fixtures and recovery demos. CI covers Linux, macOS and Windows on Node 22 and 24,
plus the minimum Node 22.16 on Linux. Installed-package checks run on Linux and macOS.
See [qualification](docs/QUALIFICATION.md) for the boundary between fixture tests and
real-client checks.

## License

[MIT](LICENSE)
