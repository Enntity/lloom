# Qualification

`npm run verify` runs the syntax check, the test suite and the recovery demos with
isolated fixtures: temporary databases, CPU-only workloads, and no model, GPU or
network service. It writes its receipts, with the source hashes tested, to `evidence/`.
That directory is ignored by git; CI uploads it from each job as an artifact.

## Real systems

These ran against installed services and real clients on macOS arm64 and Linux arm64,
outside the fixture suite:

| Behavior | Harness |
| --- | --- |
| Installed Codex and Claude Code load Accord over MCP and discover their host | Real clients |
| One agent crashes and another recovers its work over verified SSH | Codex and Claude Code |
| A service restart keeps authority, peers and accepted results | launchd, systemd user |
| A lost SSH tunnel reads as unknown, and reconnecting keeps host identity | OpenSSH |
| Managed process groups stay held until confirmed absent after a crash | macOS, Linux |
| Docker and systemd workloads are stopped before a reservation is regranted | Two Linux hosts |
| An idle session wakes on a peer message and handles it unprompted | Claude Code |
| Installed config connects and lists Accord's tools, without a model turn | OpenCode, Grok Build, Hermes |
| Installed config starts Accord's MCP server, without a model turn | DeepSeek Harness (`dsh web`) |

## Not yet exercised on real systems

- A Codex hold, which is tested only against the documented hook contract.
- A wake on Windows. The Windows waiter runs in CI, without a real harness.
- Automatic tunnel restoration on real hosts, which was proven between containers.
- Capacity pools on a live fleet.
- OMP and ZCode, whose config is written but which have not been run against Accord. Devin
  has only its registration fixture here.
- A full agent turn through any client other than Claude Code and Codex.
- The Unix socket, link proof and session sharing on real hosts. All three are tested
  against real services with fixtures.

Accord provides no GPU isolation, arbitrary process exclusivity, or per-resource access
control. See the limits in [process driver](PROCESS-DRIVER.md) and
[external workloads](EXTERNAL-WORKLOADS.md).

## Running the live checks

The `scripts/qualify-*.mjs` tools are opt-in and refuse to run without `--confirm-live`.
They need an installed, otherwise idle Accord host, a verified SSH alias, a private
remote enrollment profile and authenticated local clients. Copy
`scripts/live-host-control.mjs` beside the remote Accord source, then:

```sh
node scripts/qualify-ssh.mjs --confirm-live --host HOST \
  --profile "$HOME/.config/accord/peers/HOST/connection.json" \
  --remote-control REMOTE_PATH/scripts/live-host-control.mjs \
  --remote-node REMOTE_NODE --second claude
```

The controller verifies the authority and checks that no unrelated work is unfinished
before it injects any fault. Use a host you can afford to interrupt.
