# Ownership and recovery

The coordinator and artifact driver are separate processes and separate SQLite
databases. They do not share a transaction. The coordinator persists its intended
driver action as the claim's state; reconciliation repeats that action until its
matching receipt is committed. This is a small durable outbox specialized to
activation and revocation.

```text
task:   queued → preparing → running → releasing → succeeded
                              ↓
                          recovering → queued or failed
                              ↓
                          cancelling → cancelled

claim:  preparing → running → releasing → closed
            └─────────┴────→ revoking → closed
```

`preparing`, `running`, `releasing`, and `revoking` all occupy the resource. The
unique index applies to all four. A timeout changes the next action to revoke;
it does not free the slot. `releasing` means a result was verified and success
awaits revocation. `revoking` preserves whether the task should retry, fail, or
be cancelled. Retries create new claims and higher generations.

## Failure boundaries

| Interruption | Recovery |
| --- | --- |
| Agent dies after checkpoint | Lease expires; driver is revoked; another attempt sees the checkpoint |
| Driver cannot be reached | Hold remains; no conflicting grant; bounded HTTP attempts continue |
| Activation happened but reply was lost | Retry the same claim and generation; no duplicate grant |
| Revoke happened but reply was lost | Hold remains until an idempotent revoke acknowledgment returns |
| Coordinator dies with active work | After its leadership lease expires, replacement records a higher epoch and revokes unfinished claims. An unexpired reservation window instead returns to `preparing` under the same claim and generation; the driver reconfirms it, or refuses and it is revoked |
| Coordinator dies after result verification | Persisted releasing state retains the result and resumes revocation |
| Driver restarts | Clear active grant, retain generation and receipts; coordinator later reconciles its hold. A cooperative driver keeps the grant; a managed driver keeps only a provider-confirmed grant resumable |
| Delayed old activation arrives | Revocation tombstone or higher epoch/generation rejects it |
| Old worker writes after new grant | Driver validates current credential and rejects it |
| Old worker completes late | Coordinator validates owner, active attempt and deadline and rejects it |
| Driver database replaced | Instance mismatch retains the hold; explicit operator reconciliation is required |
| Migration checksum changes or database cannot open | Startup fails; state is not replaced with an empty database |

Every mutation checks the current coordinator leadership token in a SQLite
transaction. Each leadership takeover increments its persisted epoch. Driver
control messages carry that epoch plus the resource generation. A deposed
coordinator cannot commit state, and its delayed control messages cannot revoke
or activate a newer generation.

Leadership and claim clocks use a wall-clock anchor plus monotonic elapsed time
within a process lifetime. After restart, leadership expiry is still compared
against a new wall-clock anchor. A backwards system-clock change can delay
takeover; the implementation prefers a retained hold over guessing. Suspend and
platform clock behavior still require broader qualification.

The driver remains the physical authority until revocation commits. Therefore an
old agent may still submit an artifact while revocation is pending, but the
coordinator will not accept a late result or grant the resource to another
attempt. Artifact writes and revocation are serialized in the driver database.
This gives an exact ordering at the effect boundary.

## Limits of the proof

The artifact is stored in the driver's SQLite transaction. There are no external
filesystem writes to reconcile and no long-running GPU process. A GPU/process
driver must additionally prove old execution stopped; copying this driver's
acknowledgment behavior without that proof would be unsafe.

The protocol uses at-least-once driver commands and idempotent effects. It does
not promise exactly-once arbitrary external work. Same-user filesystem access
can bypass database and credential protection; OS isolation is outside scope.

Backup/restore, multi-host authority, TLS enrollment, malformed-driver hardening,
long-duration load, and power-loss/disk-full tests are not yet qualified. Do not
restore both databases to old snapshots and assume generations remain safe.
Preserve the driver's high-water state; restore into an isolated environment
until a dedicated recovery procedure exists.

## Reproduce and inspect

Run `npm run verify`. Its qualification receipt includes source hashes, runtime,
test output, and the separate demo's coordinator events and driver audit. Test
fixtures are local and contain no model credentials. The test suite includes a
100-request claim race, actual SIGKILL faults, lost replies, and a replaced driver
database. A compile-only pass is never counted as a recovery test.

### Fatal storage failures

A stalled coordinator may renew an expired leadership lease while its token still
owns the leader row. The check and renewal hold the SQLite write lock, so a
replacement coordinator and the old coordinator cannot both renew. Each late
renewal records `coordinator.lease_recovered` with the gap duration. A changed or
explicitly released token remains fenced. This does not extend resource claims:
their deadlines still expire, and expired claims cannot be renewed or reactivated.

A failed leadership heartbeat or ownership reconciliation stops new acknowledgments
and reports the original error to `serve`. The process logs `coordinator.failed` and
exits nonzero, with shutdown bounded to five seconds. Installed launchd/systemd
services restart with their existing ten-second throttle. Persistent storage failure
therefore remains unavailable; freeing space lets the next restart reconcile the
old generations before any new grant. No grant is revived in place.

Local regression tests exercise a real SQLite `SQLITE_FULL` using a database page
limit, and a child process losing leadership then exiting and recovering. This is
not a full-filesystem or power-loss qualification. Supervised heartbeat reservations
renew during preparation as well as running; only running grants authorize work.
