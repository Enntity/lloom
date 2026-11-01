# Shared coordination for Tessera and LLooM

**Historical extraction plan.** The current scope is the smaller
[thin collaboration contract](THIN-COLLABORATION.md). Jobs, workflow orchestration,
and task validation are not requirements for Accord participation. The table below
records earlier migration ideas; it does not claim current parity.


The target is one ownership implementation that both products consume. Accord
owns general coordination. Tessera presents it. LLooM supplies model and hardware
operations through drivers. Enntity Messenger remains the owner of conversations
and message delivery. This change implements bootstrap and discovery; it does
not switch either product's live authority.

## Responsibility map

| Responsibility | Owner after migration | Current status |
| --- | --- | --- |
| CLI/skill/MCP bootstrap, session enrollment and identity | Accord | Qualified with installed Codex and Claude MCP clients |
| Durable task attempts, checkpoints, fencing, recovery, event cursors | Accord | Implemented for artifact and registered process resources |
| Host identity, peer pairing, ownership discovery and unknown-state handling | Accord | Qualified over real macOS-to-Linux SSH, including reconnect |
| General resource registry, capacity, fair queues, independent reservations | Accord | Exclusive process registry implemented; pools, fair queues and reservation parity still required |
| Job progress, metrics, stalled-work reporting, retention | Accord | Proposed extension; current task events are narrower |
| Desktop board, windows, transcripts, attention UI, notifications | Tessera | Keep product-specific implementation |
| Harness wake, interrupt and output adapters | Accord adapter packages | MCP and child startup implemented; wake/interrupt qualification remains |
| Route selection, model drain/unload/resume and health checks | LLooM driver | Keep execution logic; implement Accord driver contract |
| Inference, model catalogs, serving and placement policy | LLooM | Keep product-specific implementation |
| Durable conversations, messages, principals and delivery | Enntity Messenger | Compose canonical implementation; no new Accord mailbox |
| Entity cognition, permissions and runtime deployment | Enntity Runtime | Keep existing ownership and consent boundaries |

Tessera should eventually render Accord session/task/resource projections and
send steering commands through the same authenticated API agents use. Its tiles
can retain product IDs but bind to an Accord session ID explicitly. Folder
matching and display names must not confer ownership. It can keep native terminal
and transcript adapters; its own queue/lease/identity implementations should end
when the corresponding Accord contracts are qualified.

LLooM should retain a compatibility CLI: `lloom reserve`, `release`, `job`, and
`schedule` can delegate to Accord once their semantics match. Its driver still
knows how to move traffic, drain serving, suspend a model, resume it, verify
health, and restore the exact previous route. Accord must not grow a model router.

## Authority and host topology

A host is independently useful with a local database and driver. Direct peer
connections provide a network view. An optional directory can later aggregate
that view without acquiring the right to grant resources. Host identities must
survive ordinary restart; replacement is an explicit administrative operation.

Each physical resource has exactly one authority. The same asset must not be
registered under several hosts. The current artifact driver pins its authority
and database incarnation; a future process/GPU driver must enforce that binding
at the actual effect boundary. Names and host advertisements are not enforcement.

During a partition, independent hosts can continue their own local work. A host
cannot claim a disconnected peer's resource on its behalf or create a replacement
lease locally. Multi-host resource bundles need an explicit transaction protocol
with durable holds and recovery; this version does not pretend independent claims
are atomic. There is no cross-host database replication, leader election, or HA
failover in this slice.

Enrollment is separate from discovery. Pairing a peer never installs arbitrary
code, grants its agents local worker access, or shares local admin credentials.
Remote transport currently uses operator-managed SSH forwarding; automated host
pairing, credential rotation, revocation of enrollment capabilities, and TLS
transport remain work before broad remote distribution.

## Driver contract to extract from LLooM

The artifact and POSIX process drivers provide implemented examples. The process
driver proves managed-group absence; it does not enforce device access or recover
a lost supervisor with surviving descendants automatically. See
[PROCESS-DRIVER.md](PROCESS-DRIVER.md). A model/resource
driver needs these additional semantics before it can replace LLooM reservations:

1. **Prepare:** capture the exact prior state and persist each action before
   acknowledging it. Move routes before draining. Reject overlapping resources
   that would mutate the same underlying route or model.
2. **Activate:** accept only the named authority, driver incarnation, generation,
   and attempt. Duplicate activation is safe; revoked generations never reactivate.
3. **Operate:** validate the active grant at the boundary that controls execution.
   A cooperative client lock does not prove another process stopped using a GPU.
4. **Revoke and restore:** stop the controlled workload, restore recorded state in
   reverse order, check model health, then restore traffic. A failed restoration
   stays held. Expiry initiates recovery; it does not declare success.
5. **Inspect:** report durable receipt IDs and observed state so a restarted
   coordinator can reconcile ambiguous outcomes without rerunning effects blindly.

Driver commands must carry stable idempotency keys and fencing metadata. Return
versioned receipts. Keep private driver control credentials out of agent tools.
The coordinator's current pending claim states already provide durable command
retries; model-specific step journals belong with the driver that controls effects.

## Migration sequence and deletion gates

1. Add read adapters in Tessera and LLooM against Accord's HTTP contract. Compare
   views against existing schedules in fixtures and a read-only shadow deployment.
   Do not run two grant authorities during comparison.
2. Extend resource registration with independent reservations, capacities, queue
   fairness, policy-driven TTLs, overdue/keep behavior, job reports and retention.
   These are real gaps: the current artifact tasks and bounded claim retry loop
   do not replace LLooM's reservation queue or standing reservations.
3. Build the LLooM driver and fault-test route restoration, model health failure,
   interrupted drain, lost replies, host restart, zombie processes, and duplicate
   delivery. Prove the resource-specific enforcement boundary.
4. For each cutover, stop new admissions in the old owner, drain or explicitly
   reconcile existing reservations, preserve receipts, and bind the driver to the
   new authority. Never reset a fencing generation to import an old schedule.
   Resume admissions only after the new authority and driver agree.
5. Switch compatibility clients to Accord. Delete duplicated scheduling state
   machines only after API parity and restart/recovery tests pass. Preserve the
   old read-only record for audit. Rollback also requires drained/reconciled
   ownership; restarting the old scheduler against live Accord leases is unsafe.

Tessera acceptance: distinct concurrent sessions in the same folder, reconnecting
event cursors, accurate unknown states, pause/cancel acknowledgments, and durable
human-visible progress. Its inbox migration requires Messenger parity, not a
second mailbox added to Accord.

LLooM acceptance: exact route/model restoration, overlap detection, all existing
capacity/queue/TTL modes, current job reporting, and no active reservation loss
across restart or cutover. Production serving and entity-owned runtimes stay on
their current authorities until these gates pass.

## Keeping the core small

Keep one HTTP contract and one session/resource state implementation. CLI, MCP,
Tessera and LLooM clients are adapters. Package drivers and harness adapters
separately; loading a driver must not require installing the product UI. Continue
using local SQLite transactions and explicit authority boundaries until measured
requirements justify a distributed store. A network directory is not a scheduler.

The present checkout is source-installable and has no external runtime packages.
A signed, relocatable distribution, Windows service integration, unattended
upgrades, backup/restore qualification and long-lived retention are separate
release gates. These limits belong in the product contract, not in hidden adapter
assumptions.
