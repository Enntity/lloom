# Live installation and recovery qualification

Passed on 2026-10-30 with installed Codex and Claude Code, a macOS Accord service,
and a second Accord service on `ennspark02` (`spark-6f19`, Linux aarch64).
Both services use Node 22.19.0. Codex was 0.165.0-alpha.1.2; Claude Code was 2.1.312.
This is one live fault run after fixing the integration issues described below.

## What passed

| Check | Evidence |
| --- | --- |
| Installed Codex loads Accord MCP, enrolls, and discovers its local host | [local-codex.json](../evidence/live/local-codex.json) |
| Installed Claude loads Accord MCP, enrolls, and discovers its local host | [local-claude.json](../evidence/live/local-claude.json) |
| macOS service restart preserves authority and peer configuration | [local-restart.json](../evidence/live/local-restart.json) |
| Real Codex-to-Claude recovery over verified SSH | [ssh-codex-claude.json](../evidence/live/ssh-codex-claude.json) |
| Lost SSH tunnel becomes unknown; reconnect preserves identity | [ssh-services.json](../evidence/live/ssh-services.json) |
| Linux service restart preserves accepted result and artifact digest | [ssh-services.json](../evidence/live/ssh-services.json) |
| Both installed services running at final inspection | [installation.json](../evidence/live/installation.json) |

The remote recovery trace records these steps:

1. Codex inherited the launcher's enrolled session, claimed generation **3**, and
   checkpointed `Prepared: write ACCORD SURVIVES INTERRUPTION`.
2. The controller suspended only Accord's artifact driver with `SIGSTOP` and
   killed the Codex process group with `SIGKILL`.
3. After lease expiry, discovery still reported the old holder as `revoking`,
   with `DRIVER_UNAVAILABLE`. Expiry did not free the resource.
4. A fresh Claude process received the remote connection profile and the test
   instruction, without a task ID or session credential. Its own MCP session
   discovered the held lease and checkpoint through bootstrap and host calls.
5. Claude called `accord_wait` while the old claim still held the resource.
   Only then did the controller resume the driver.
6. After confirmed revocation, Claude acquired generation **4**, inspected it
   until running, renewed its own lease, and completed the checkpointed artifact.
7. The former grant was rejected with `STALE_GRANT`. The complete driver audit
   showed **zero overlapping active grants**. The accepted artifact was exactly
   `ACCORD SURVIVES INTERRUPTION`, SHA-256
   `267c110614a0a23c516413a7789fb58969f9e60cb5e7acf81ef76cc8bec8e46c`.

This used real model-driven tool calls. The controller injected faults and checked
invariants; it did not perform Claude's claim, renewal, write, or completion.
Both agent processes ran on the Mac against the Linux authority through SSH.
This does not claim that Codex or Claude was installed on the Linux host.

## Failures found and repaired

Codex filtered the wrapper's environment before launching MCP. The first live
attempt detected a different session ID and failed before fault injection.
The installer now explicitly forwards `ACCORD_SESSION_FILE`,
`ACCORD_CONTEXT_FILE`, `ACCORD_SESSION_ID`, `ACCORD_PROFILE`, and `ACCORD_URL`.
These are paths and identifiers; secret values remain in private files. This uses
Codex's documented [`env_vars` setting](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
An exact previous Accord registration is upgraded with a backup, preserving
unrelated settings. Customized conflicting registrations remain refused.
The regression suite exercises the upgrade; the successful live trace proves
that the launched and MCP identities match. The initial failure is retained in
[failed-session-inheritance.json](../evidence/live/failed-session-inheritance.json).

Claude initially needed the user's OAuth sign-in renewed. After sign-in, its
local smoke test passed. The recovery launcher also needed `--` before the
prompt because Claude's variadic `--mcp-config` option consumed it as a filename.
The corrected launcher passed the live recovery test. The service-check script's
first draft looked for a nonexistent artifact digest field; it now hashes returned
content and compares it to the persisted receipt. Its corrected run passed.
Failed rehearsal tasks were cancelled and confirmed released.

## Installed footprint

The local source installation points at this checkout. The Linux runtime source
is commit `6a28f50` under `~/.local/share/accord-releases/6a28f50`; it does not need
the local Codex registration fix because no agent clients were installed there.
The operator-only fault controller was copied alongside that release. Recorded
[source hashes](../evidence/live/source-manifest.json) identify both sides.

- Mac authority: `9cfb416e-4bea-4c8d-b616-134a3c5a4594`.
- Linux authority: `cfa2165e-141a-4fea-b9e5-195cc3064223`.
- Both data directories: `~/.local/share/accord`; both local endpoints: loopback
  ports 8787 for the coordinator and 8788 for the driver.
- Local CLI: `~/.local/bin/accord`; local profile:
  `~/.config/accord/connection.json`. Codex and Claude have user MCP registrations
  and installed skills. Existing agent sessions may need restarting to load them.
- Mac service: `org.enntity.accord`; Linux user service: `accord.service`.
- Mac SSH tunnel: `org.enntity.accord.ssh-ennspark02`, a separate LaunchAgent using
  strict host-key checking, keepalives, and loopback forwarding from port 18787.
- Remote enrollment profile on the Mac:
  `~/.config/accord/peers/ennspark02/connection.json`. Discovery and enrollment
  credentials were provisioned over SSH into mode-0600 files. Admin and driver
  credentials stayed on their owning hosts.

Pairing is directional: the Mac observes the Linux host. Each retains its own
authority; no database replication or automatic peer enrollment is implied.
The installed services and tunnel remain enabled. Both resource drivers were
reachable and unclaimed at final inspection. The Linux epoch reached 3; the Mac
restarted at epoch 2. Boot-after-power-loss and login-independent startup were
not tested.

## Reproduce

Ordinary regression checks remain isolated:

```sh
npm run verify
```

The current run passed 30 tests and both deterministic recovery demos. Its source
hashes and logs are in [qualification.json](../evidence/qualification.json).
It does not contact model providers or fleet hosts.

The live scripts are separate opt-in operator tools. They require an already
installed, otherwise idle Accord artifact host, a verified SSH alias, a private
remote enrollment profile, and authenticated local harnesses. The fault controller
must be copied into `scripts/` beside the remote Accord source. For this installation:

```sh
node scripts/qualify-ssh.mjs --confirm-live --host ennspark02 \
  --profile "$HOME/.config/accord/peers/ennspark02/connection.json" \
  --remote-control /home/enntitysparkadmin/.local/share/accord-releases/6a28f50/scripts/live-host-control.mjs \
  --remote-node /home/enntitysparkadmin/.local/bin/node \
  --second claude --out evidence/live/ssh-codex-claude.json

node scripts/qualify-services.mjs --confirm-live --host ennspark02 \
  --profile "$HOME/.config/accord/peers/ennspark02/connection.json" \
  --remote-control /home/enntitysparkadmin/.local/share/accord-releases/6a28f50/scripts/live-host-control.mjs \
  --remote-node /home/enntitysparkadmin/.local/bin/node \
  --tunnel-label org.enntity.accord.ssh-ennspark02
```

The controller verifies authority, checks that no unrelated work is unfinished,
and identifies the driver's PID under Accord's systemd supervisor before signaling
it. Its cleanup resumes a suspended driver and cancels incomplete test work.
A forcibly killed controller or SSH outage during cleanup can still require an
operator to resume the driver. These are fault-injection tools, not a daemon or
a production recovery dependency.

## Boundary before migration

The proven enforcement boundary is the artifact API. No GPU jobs, model routes,
entity state, or existing LLooM reservations were changed. Arbitrary process
termination, GPU exclusivity, network partition during active remote work,
unattended model launching, credential rotation, and host replacement remain
separate qualification work. A lost discovery connection alone never grants work.

Tessera and LLooM still own their existing functionality. Their cutover gates in
[PRODUCT-BOUNDARY.md](PRODUCT-BOUNDARY.md) remain: implement and fault-test the
actual process/model driver, match reservation semantics, then drain the old
owner before transferring authority.
