# Upgrading Accord

## Before restarting

Finish or release active reservations on the host you are upgrading. Coordinate with
agents using resources on linked hosts. A coordinator restart fences unfinished tasks and
heartbeat reservations; it does not preserve their permission to continue. An unexpired
reservation window resumes once its driver reconfirms the same generation. Managed release
can stop a workload and restore its provider.

Keep the existing private data directory and connection profile. Do not initialize a
second authority or copy tokens between hosts. Keep the previous package available for
binary rollback; database rollback is a separate recovery operation and can invalidate
fencing history. See [recovery](RECOVERY.md).

## Install 0.6.6

```sh
npm install -g https://github.com/Enntity/accord/releases/download/v0.6.6/enntity-accord-0.6.6.tgz
accord install
```

The installer preserves other client settings and backs up files it changes. If it
finds an already running service, it updates the configuration but leaves the restart
to you. Follow the `next` command in its output once reservations are clear.

On Linux with the default systemd user service:

```sh
systemctl --user restart accord.service
```

On macOS, replacing the install path requires reloading launchd's service definition:

```sh
launchctl bootout "gui/$(id -u)/org.enntity.accord"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/org.enntity.accord.plist"
```

On Windows, use `accord install --no-start`, then restart `accord up` through your
chosen supervisor. Automatic Windows service installation is not included.

## Check the result

```sh
accord --version
accord doctor
```

The CLI should report `0.6.6`; the doctor should report `ready`. The CLI version identifies
the package invoked by your shell, so also check the running service's command line
against the new install path. Restart your agent sessions to load the updated MCP bridge.

On linked hosts, verify `accord find`, send and acknowledge a test message, and exercise
reserve, extend and release on a dedicated cooperative resource. Check that extension
keeps the claim and generation. Do not use an active GPU workload as a smoke test.

## Changes from 0.6.5

A coordinator stalled past its leadership lease renews only if it still owns the
leadership token; a replacement or explicitly released token remains fenced.
The service records the gap as `coordinator.lease_recovered`. Resource deadlines
still apply. Managed-provider restoration retries retain a confirmed stop; a new
coordinator epoch or driver restart reconfirms it. No schema migration is added.

## Changes from 0.6.4

The installer compares the Codex Accord entry in `~/.codex/config.toml` by value, so an
upgrade no longer stops with "Existing Codex Accord MCP registration differs" after Codex has
re-saved the file. No schema change, so a 0.6.4 database upgrades in place.

## Changes from 0.6.3

`accord resource remove --id NAME` lets the administrator of the host that owns a resource
retire it. It works for every plugin and refuses while anything holds, queues on or depends
on the resource. No schema migration is added, so a 0.6.3 database upgrades in place.

## Changes from 0.6.2

A `managed-http` resource whose provider answers availability with 404 `resource_unknown`
is removed once nothing holds, queues on or depends on it; the first pass runs a second
after the coordinator starts. Providers that never answer that way are unaffected. No
schema migration is added, so a 0.6.2 database upgrades in place. Upgrade the host that
owns a resource for its withdrawals to take effect.

## Changes from 0.6.1

A coordinator restart keeps an unexpired reservation window: its claim returns to
`preparing` under the same generation and deadline until the driver reconfirms it.
Heartbeat reservations and tasks are still fenced. No schema migration is added, so a
0.6.1 database upgrades in place; the first 0.6.2 start resumes windows recorded by 0.6.1.

## Changes from 0.5

CLI and MCP reservations default to a one-hour window. `durationMs` sets a bounded
window; `leaseMs` explicitly selects a supervised heartbeat. An extension preserves the
claim and generation. New clients refuse window requests on old hosts before changing
anything, so upgrade all linked hosts before relying on this feature.

The schema adds migration 16. Existing heartbeat reservations retain their recorded
lease deadline during migration; the normal restart fencing rules still apply.

0.6.1 also renews supervised leases during preparation and exits on fatal coordinator
storage or leadership failure so the installed service manager can restart. A disk
that remains full still needs free space; restarting cannot repair it.
