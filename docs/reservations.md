# Shared resources and jobs

Use the Accord skill or CLI for registration, discovery, messages, jobs and leases.
`lloom schedule --json` shows the same ownership in LLooM's familiar read-only shape.
The old reserve/renew/release/job write commands and gateway routes no longer own
state; use `accord reserve`, `reservation`, `extend`, `release`, `job` and `jobs`.

LLooM registers configured resources with Accord at gateway startup. For example:

```json
{"reservations":{"resources":{"lab":{
  "asset":"lab-gpu-pool",
  "description":"Lab model work",
  "hosts":["worker"],
  "routes":[{"alias":"chat","profile":"cloud"}],
  "suspend":["resident"],
  "workloads":["experiment"]
}}}}
```

Use one stable physical `asset` per resource and one authoritative host. `workloads`
are administrator-configured LLooM models, not arbitrary agent commands. Capacity
slots without shared route/model effects become separate Accord resources. Shared
model effects and shared workload definitions require capacity one.

1. Join Accord and discover the resource's full address.
2. Reserve it with a stable request key. Only `running` grants access.
3. Start the configured workload through Accord, and publish job progress there.
4. Extend before the returned deadline. A progress report is not an implicit renewal.
5. Release and wait for `released`. Unknown or recovering means it remains held.

The provider stops the old managed workload and restores exact model/route state
before Accord grants another generation. Coordinator, provider or driver failure,
health-check failure and ambiguous replies do not free the resource. Previously
suspended models remain suspended.

Pre-migration active leases remain held in the original schedule evidence until
verified recovery. Do not edit an old deadline or delete a schedule file to claim
hardware is free. See [integration boundaries and cutover](ACCORD.md).

For a historical hold whose owner confirms there is no borrowed workload, an
operator may adopt the verified current serving configuration as the production
baseline. Drain the gateway with its deployment fence first. Run
`node scripts/reconcile-accord-hold.mjs --config FILE --plan PLAN` to inspect,
then add `--apply --yes`. The plan must identify the exact lease and configuration
SHA-256, matching fence operation/generation, owner confirmation, live baseline
evidence, and `noBorrowedWorkload: true`. The original journal remains unchanged;
a separate exact-record reconciliation prevents replay of obsolete restoration.
A changed lease blocks again. This does not stop or certify arbitrary containers.
Future reservations still execute the current resource's drain/restore contract.
Production serving is LLooM's baseline, not an agent reservation; an unclaimed
reservation does not mean idle hardware. Only configured workloads are fenced.
