# Spark head cutover

The Spark head now runs LLooM source `289c97c` with Accord `d041c72`.
Both `pair` (01/02) and `drafter-0304` (03/04) are native managed-http resources
under the existing Spark 03 Accord authority. The legacy write API returns 410.

The verified owner of `r-05cae086`, `codex-qwen-overnight`, confirmed that the
lease retained no experiment or future reservation. It was protecting production
from an obsolete GLM restoration journal. We retained the original schedule bytes
and recorded an exact-lease reconciliation under a drained deployment fence.
No historical restore actions ran. The current pair preparation now targets Qwen,
with embedding and image sidecars explicitly excluded.

All six running containers across 01–04 retained their IDs, PIDs, start times and
restart counts. All routes and runtime contracts matched the pre-cutover baseline.
Only the head gateway restarted; worker gateways and model processes remained.
The head's effective systemd `KillMode=process` already existed in a drop-in.
The earlier qualification's concern about its default kill mode was incorrect.

The first candidate refused an existing TP4 definition because the installed
per-model leader support was absent from source. We restored the previous gateway
and reopened its admission fence, then imported that support, added ownership
regressions, and preflighted the actual configuration before retrying. There was
a gateway admission interruption; this was not a zero-downtime deployment. No
model container stopped during either attempt.

The final gateway drained to zero handlers, restarted under the persistent fence,
passed preservation checks, and reopened generation 5. A normal gateway request
to resident Qwen completed with `stop`. Mac-side discovery sees both native
resources, the adapter reports `migrated`, and remote Accord telemetry is fresh.

The final package also passed two-agent recovery over SSH with disposable
Mac/Linux authorities and a real CPU workload: gateway crash left the workload
alive; the next agent stayed blocked; recovery stopped the old process before
granting the next generation; the stale owner was rejected. We did not stop
production GPU workloads merely to repeat that destructive test.

An unclaimed reservation is not idle hardware. LLooM owns the production serving
baseline; a new reservation must complete its configured drain before use. The
provider fences configured workloads, not arbitrary containers started over SSH.

Evidence:
- `qualification.json`: owner, canary, drain, retry and scope.
- `preservation.json`: six unchanged live containers and four-host checks.
- `head-installed.json`: 1,210 installed files matched the staged final package.
- `network.json`: native resource addresses and remote telemetry.
- `ssh-proof.json`: crash/recovery behavior for the exact final package hash.

Private rollback/config snapshots remain on the head in
`~/.local/share/accord-cutover/289c97c/lloom-before`. Reverting software alone would
revive the legacy scheduler; do not roll back after new Accord grants without
reconciling those grants first.
