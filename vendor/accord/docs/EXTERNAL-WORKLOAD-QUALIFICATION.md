# External workload qualification

Recorded 2026-11-01T16:59:07.843Z. Live fleet installation is **pending approval** for restricted
persistent SSH workload-control access. The code is not yet active on the Spark head.

## Executed proof

Two deterministic agent clients, real Docker containers on two Linux arm64 SSH
hosts, and a real systemd user supervisor; Mac arm64 coordinator/driver, Node 22.19.
Only disposable CPU fixtures were used. No live GPU reservation was acquired.

1. The first client acquired the fixture resource, registered two fresh containers
   and a supervisor, then launched them through Accord. Both containers were live.
2. The second client queued for the same resource.
3. Both coordinator and driver were killed with SIGKILL. One host's fixture helper
   was made unavailable. Recovery fenced the generation and stopped the supervisor;
   the second client remained queued while that host's container was still alive.
4. Restoring the helper allowed both immutable container identities to be confirmed
   stopped. Only then did the provider restore and the second generation activate.
5. The old owner's launch was rejected. The second client released normally.
   All temporary containers, service definitions and helper files were removed.

The last external stop was recorded **1282 ms before the second grant**.
The ordering and matching source hashes are in
[`external-recovery-ssh.json`](../evidence/external-recovery-ssh.json).
The provider in this proof is a fixture which asserts stopped real objects before
acknowledging restoration; it does not change LLooM model routes.

## Local qualification

132 tests and the artifact, process and bootstrap recovery demos passed on the
recorded source. Twelve external-workload cases cover crash recovery, wrong owner,
changed host identity, failed stop, supervisor order, incomplete adoption, ambiguous
launch, duplicate release, fresh-object requirements, connector validation, missing
journal, and migration from the previous driver schema without losing identity or
the held generation. See [`qualification.json`](../evidence/qualification.json).

## Live preservation and handoff

The verified former holder reported its containers and watchers stopped/removed
and released normally. The queued benchmark then completed and released too.
Fresh inspection found both real resource groups unclaimed with empty queues.
Production model containers remained running, and the LLooM gateway retained its
PID and healthy status. No Tessera, LLooM or installed Accord service was restarted
for this work. Recheck ownership before deployment; this observation is not a lease.

## Limits

This qualifies registered Docker and systemd objects, not arbitrary privileged
SSH/Docker actions, unregistered restart loops or GPU device isolation. Lost or
replaced attachment state blocks recovery. Existing running workloads require
coordinated operator adoption; this handoff needed none because their owners
finished normally. Live deployment and restricted-key verification remain separate
from the successful source and isolated SSH proof.
