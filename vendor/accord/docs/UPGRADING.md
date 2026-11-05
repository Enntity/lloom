# Upgrading Accord

## Before restarting

Finish or release active reservations on the host you are upgrading. Coordinate with
agents using resources on linked hosts. A coordinator restart fences unfinished grants;
it does not preserve a running workload's permission to continue. Managed release can
stop a workload and restore its provider.

Keep the existing private data directory and connection profile. Do not initialize a
second authority or copy tokens between hosts. Keep the previous package available for
binary rollback; database rollback is a separate recovery operation and can invalidate
fencing history. See [recovery](RECOVERY.md).

## Install 0.6.1

```sh
npm install -g https://github.com/Enntity/accord/releases/download/v0.6.1/enntity-accord-0.6.1.tgz
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

The CLI should report `0.6.1`; the doctor should report `ready`. The CLI version identifies
the package invoked by your shell, so also check the running service's command line
against the new install path. Restart your agent sessions to load the updated MCP bridge.

On linked hosts, verify `accord find`, send and acknowledge a test message, and exercise
reserve, extend and release on a dedicated cooperative resource. Check that extension
keeps the claim and generation. Do not use an active GPU workload as a smoke test.

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
