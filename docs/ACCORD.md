# Accord integration

Accord is the standalone session and resource backplane used by LLooM and Tessera.
Both ship a pinned Accord package and install the host when absent. They reuse an
existing connection profile and authority; an unavailable or invalid existing host
is an error, never a reason to create a replacement authority. The installer
serializes concurrent product setup and preserves client configuration.

## Ownership boundary

Accord owns agent identity, discovery, messages, questions, session activity,
summaries, search, jobs, resource queues, lease deadlines, fencing and recovery.
LLooM no longer maintains a reservation queue, agent job database, expiry timer,
or owner-name authentication. The old reservation/job mutation routes return 410
with an Accord instruction. `lloom schedule` remains a read-only projection.

LLooM owns inference request/session metrics, KV caches, model catalogs, recipes,
installation operations, admission, routing, model maintenance and health checks.
These are model-serving state, not a second agent session system. Tessera owns
native terminal interaction and presentation of the shared state.

Machine inventory, GPU/CPU utilization, temperatures and memory readings come from
the Accord daemon. Its fast available-memory endpoint is separate from slower GPU
and inventory probes. Unknown or stale memory prevents new model admission. Initial
read-only setup planning can use the same Accord inventory collector before the
host is installed; no second sensor implementation lives in LLooM.

## Resource provider

The product-independent `managed-http` Accord plugin calls an administrator-installed
provider with a pinned authority, claim and monotonically increasing generation.
Provider credentials stay in a local private file. A dedicated loopback listener retains its port across restarts, independently of
the inference listener (which can bind a Tailscale address). Only requests with that
credential reach LLooM's effect interface; inference and gateway admin keys do not.

LLooM's fsynced effect journal records prior routes and suspension states before
changing them. `prepare` moves routes, drains and verifies suspension. Optional
`workloads` name models the holder can start through `accord workload start`.
On release or recovery, `stop` suspends those workloads and verifies their shutdown;
`restore` reverses recorded effects and waits for health. Failed, lost or interrupted
steps remain held. Replays never create a new lease or resurrect a revoked generation.

Resources may share an effect: with one resource per Spark, a model served across
two Sparks is drained by a hold on either, and both holds route its aliases the same
way. Every holder records the state from before the first hold; the effect is
applied once and restored only when the last holder that needs it releases. A hold
that would route a shared alias to a different profile is refused before any effect.
A workload plan that spans Sparks lists them as `resources`; `lloom workload run`
acquires them in sorted order, so two jobs needing overlapping Sparks queue instead
of each holding half, and registers each container under the hold for its host.

Removing a resource from `reservations.resources`, or lowering its capacity, withdraws it:
its provider answers availability with 404 `resource_unknown`, and Accord forgets the
resource once nothing holds or awaits it. A hold that is still open keeps its journal and
restores normally first.

This controls LLooM-managed workloads. Arbitrary SSH commands, external containers,
escaped process groups and unrelated GPU users are not isolated by a lease. Use an
appropriate Accord process/container driver for those workloads; missing evidence
must never be represented as a confirmed stop.

## Cutover and old data

Existing `schedule.json` files are retained as immutable migration evidence. Active,
acquiring, releasing and stuck entries block the corresponding provider, even if
their old deadlines have passed. They must be reconciled after the old workload is
verified stopped; the migration does not interrupt it or guess ownership. Before
upgrading an existing reservation head, have the holder stop the workload and
release through the still-running old head, which verifies restoration. When the
legacy record describes production residency that must remain running, use the
reviewed reconciliation procedure in [reservations.md](reservations.md), recording
holder confirmation, exact effects and a deployment fence. Do not remove or edit
active legacy records to force a cutover. The Spark head completed this procedure;
see [installed cutover evidence](evidence/2026-11-01-accord/head-cutover/README.md).
An active Accord grant is a separate upgrade constraint: restarting its driver
revokes that generation and initiates recovery. Wait for a coordinated release
before updating that host's coordinator or driver. Queued
legacy requests must join Accord and requeue. Old job histories are imported into
Accord's searchable observations with their original owner and timestamps, without
pretending they are authenticated new sessions.

The source `lloom-schedule` skill is retired. Product setup archives an installed
copy outside agent discovery. Accord is the single published coordination skill.

Qualification uses disposable hosts and CPU-only workloads. Hardware deployment
and existing live reservations are separate evidence from these protocol tests.
