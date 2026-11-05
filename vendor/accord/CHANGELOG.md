# Changelog

## 0.6.1

- CLI and MCP reservations use a one-hour bounded window by default. Extend the same
  grant without preparing the provider again or restarting the workload.
- Supervised heartbeat reservations renew during slow preparation, before work begins.
- Fatal coordinator storage and leadership failures retain their original diagnostic
  and exit nonzero, allowing launchd or systemd to restart the service.
- CLI version output and MCP initialization read the version from the installed package.
- Installation, upgrade and recovery documentation distinguish supported behavior from
  client-specific and unqualified paths.

Upgrade all linked hosts for reservation windows. Existing raw heartbeat clients remain
compatible. Restarting a coordinator fences unfinished grants, so release active work
first. See [upgrading](docs/UPGRADING.md).

Validation includes SQLite `SQLITE_FULL` induced by a page limit, leadership loss in a
child process, slow provider preparation, generation-preserving extension, and recovery
before regrant. Full-filesystem exhaustion and power loss are not qualified by these tests.

## 0.5.0

- Stable native MCP mailboxes across reconnects and explicit remote-delivery errors.
- Clean service stops and updates from moved installation paths.
- Optional memory search, disabled by default, with provenance and bounded reads.
- Resource-declared ownership limits.
