# Changelog

## 0.6.6

- A coordinator delayed past its leadership lease can continue if no replacement
  took over. It records the gap and preserves live claims; expired claims and
  replaced leadership tokens remain fenced.
- A failed managed-provider restore retries restoration without repeating a
  confirmed workload stop. A coordinator takeover or driver restart reconfirms
  the stop, and the resource stays held until restoration succeeds.
- CI fixtures use the production leadership lease on every platform. Wake tests
  bind their setup through the admin API instead of the hook's 500 ms deadline.

## 0.6.5

- Upgrading no longer stops with "Existing Codex Accord MCP registration differs" after Codex
  has re-saved `~/.codex/config.toml` in its own style. The installer now compares the Accord
  entry's values, not its exact text.

No schema change: a 0.6.4 database upgrades in place.

## 0.6.4

- `accord resource remove --id NAME` retires a resource nobody needs any more, such as a second
  name for something that already has one. It refuses while anyone holds or waits for the
  resource, removes its history and driver files like a withdrawal, and keeps fencing safe if the
  name is registered again. Removing a name that is already gone changes nothing.

Run it on the host that owns the resource, after upgrading that host. A 0.6.3 database upgrades
in place.

## 0.6.3

- A `managed-http` resource its provider no longer offers no longer stays forever. The provider
  answers `availability` with 404 `resource_unknown`, and the resource is removed once it is idle,
  together with its finished history and driver files. Fencing stays safe: a name registered again
  starts above every generation it issued. Unreachable providers keep their resources.

Upgrade the host that owns a resource for its withdrawals to take effect. A 0.6.2 database
upgrades in place.

## 0.6.2

- A coordinator restart, such as a supervisor restart after an OOM kill, no longer ends an
  unexpired reservation window. The same claim and generation return to `preparing` and the
  driver reconfirms them; managed and cooperative drivers do so across their own restart.
  A driver that cannot resume the generation, such as a restarted process driver, gets it
  revoked at once instead of left preparing until the deadline.
- A holder that did not release is told when its reservation ends.

Upgrade the host that owns a resource to keep its windows across restarts. Restarting into
0.6.2 already resumes unexpired windows recorded by 0.6.1.

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
