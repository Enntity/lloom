# Pool planning

`lloom pool plan` treats every node in the cluster as one pool and proposes which model lanes run where, how each alias routes, and what would change from today. It is a dry run: it never starts, stops or reroutes anything. Act on a plan with `lloom fleet`, `lloom route`, `lloom keep-warm` and `lloom suspend`/`resume`.

The reconciler and pool controller that would apply plans are built and tested in a fleet simulator (`lloom pool simulate`, below), but they are not wired to a live gateway yet.

```bash
lloom pool plan                                   # live status + 7-day demand from the gateway
lloom pool plan --cordon spark-node-01,spark-node-02    # what if the pair is taken?
lloom pool plan --profile standalone              # keep a fleet profile's routes fixed
lloom pool plan --pin omp=qwen38-27b-nvfp4        # keep one alias fixed
lloom pool plan --consider-installs               # also place bundled recipes not installed yet
lloom pool plan --offline --json                  # config + this machine only
```

The planner sits above the per-node admission planner (`runtime-policy.mjs`), and does not replace it. Admission still decides at request time whether a start fits in live memory. The pool plan decides which lanes should be resident and where.

## Inputs

**Nodes.** Each node comes from `GET /gateway/cluster?inventory=1`. `GET /gateway/node?inventory=1` adds the node's inventory, which is collected on request and cached for five minutes. The inventory contains:

- structured compute architectures (`sm_121` for GB10, `apple-metal` for Apple Silicon);
- memory domains;
- free disk per model root;
- recipes whose weights are already complete on disk;
- installed commands and Docker images;
- direct fabric links to other nodes, from NVIDIA Sync discovery.

A gateway that predates inventory still reports its machine profile, and the planner works from that, without weights or images. A node that does not answer is planned around as unavailable. Without a running gateway, the plan uses the config's node resources plus this machine's own inventory.

**Variants (the catalog).** A variant is one way to serve a gateway model. Variants are grouped by underlying model, and come from four sources:

- **Managed runtimes:** each runtime is fixed to its configured `node` or `placement`. Its memory per node is the configured estimate, raised to the measured resident size when that is larger.
- **Federated targets:** a node's proxy model with a `remoteRuntime`.
- **Unmanaged lanes:** declared with a `pool` block on the model, for example a hand-run TP2 server on the pair:

  ```json
  {
    "id": "qwen3.8-flash-next-atlas",
    "backend": "atlas",
    "pool": { "nodes": ["spark-node-01", "spark-node-02"], "memoryGbPerNode": 110 }
  }
  ```

  LLooM cannot start or stop these, so the plan lists them as manual actions.

- **External models:** cloud and other models with no node.

With `--consider-installs`, bundled recipes add variants that may go on any eligible node set.

Each variant has structured requirements: node count, tensor-parallel degree, compute architectures, platform, backend, context window and scheduler sequences. Recipes can state these with `requirements.computeArchs`, `requirements.tensorParallel` and `models[].settings.maxSequences`. When they are absent, they are inferred from launch settings (`CUTE_DSL_ARCH`, `TORCH_CUDA_ARCH_LIST`, `--tensor-parallel-size`, `MAX_NUM_SEQS`) or from the accelerators and cluster node count. Performance comes from live gateway metrics when a model has at least five requests in the window, otherwise from the best matching benchmark result.

**Workloads.** Every alias is a workload. Its candidates are its current members plus the members of all its route profiles, expanded through nested aliases, with suspended members left out. Demand is the alias's request rate over the last seven days, from the `requested` buckets in `/gateway/metrics`. A gateway that predates those buckets reports demand per resolved model only, so each model's demand is split evenly across the aliases routed to it.

Residency is the larger of two values:

- **Demand-based:** at least 1 request/hour means `always`; at least 0.125 means `preferred`; otherwise `auto`.
- **Current-target:** the residency of the runtime the alias routes to now.

Override any of this per alias in config:

```json
"pool": {
  "cordon": ["spark-node-02"],
  "pins": { "routes": { "omp": "qwen38-27b-nvfp4" } },
  "workloads": {
    "embeddings": { "residency": "always" },
    "video": { "required": false, "slo": { "ttftMs": 2000, "contextWindow": 131072 } }
  },
  "policy": { "headroomGb": 4, "churnWeight": 10, "external": "fallback" }
}
```

**Pins are hard constraints.** A pin is any of the following:

- a runtime's `node` or `placement`;
- `keepWarm` (residency `always`);
- `pool.pins.routes` and `--pin`;
- the routes and `always` residency of a `--profile`.

The currently active routes are not pins; they are what the diff is measured against. To keep a hand-chosen route, pin it.

## Membership

Nodes can also join a head themselves and keep a lease, so the planner always knows who is in the pool. Membership is optional and inert until used: the head writes nothing and accepts no enrollment until an operator issues a token. Static `cluster.nodes` config, `lloom cluster add-node` and on-demand polling keep working unchanged.

```bash
# on the head
lloom pool token create --ttl 1h --uses 1        # prints a one-time enrollment token
lloom pool members                               # state, lease age, inventory, running lanes
lloom pool cordon spark-node-02 --reason "disk swap"
lloom pool drain spark-node-02 --reason rebalance
lloom pool uncordon spark-node-02
lloom pool leave spark-node-02                   # decommission; the id may enroll again
lloom pool token create --node-id spark-node-02  # re-enroll a node that is still a member

# on the joining node (token on stdin, never in argv)
lloom pool join http://head-private:8100 --token-stdin --endpoint http://10.10.10.2:8100 --apply --yes
```

**Enrollment.** `POST /gateway/pool/enroll` takes the token as a bearer credential and the node's `nodeId`, `endpoint` and optional `labels`. It returns a node secret and the lease length. A token expires (default one hour) and has a use count (default one). Labels set on the token override labels the node sends. A token issued with `--node-id` enrolls only that node.

A token can claim an id that is a current member, or a node configured in `cluster.nodes`, only if it was issued for that id. Otherwise the head answers 409. This means no other node's token can take over a node's liveness, endpoint or reported capacity.

Re-enrolling rotates the node's secret and keeps any cordon or drain, so a node cannot re-enroll its way out of one. After `lloom pool leave`, the id is free again. A node cannot enroll with the head's own node id.

Enrollment attempts are rate limited per client address. Heartbeats are rate limited per address too, and are refused before the body is read unless the bearer has the node-secret format. Node-reported text that contains control characters is dropped. `join` warns when the head URL is plain HTTP and the host is neither loopback nor a tailnet address.

`lloom pool join` stores the secret in `pool-node-secret` (mode 0600) next to the node's config and sets:

```json
"pool": { "head": { "url": "http://head-private:8100", "nodeId": "spark-node-02", "secretFile": "pool-node-secret" } }
```

`secretEnv: "NAME"` reads the secret from an environment variable instead. A relative `secretFile` resolves against the config directory, and must be a private regular file. `intervalMs` sets the heartbeat interval (default 10 s). Without `--apply --yes`, `join` only shows what it would do and does not read the token.

**Leases.** With `pool.head` set, `serve` sends `POST /gateway/pool/heartbeat` with the cached pool inventory, the running runtimes and host telemetry, authenticated with the node secret. It backs off exponentially, up to five minutes, while the head is unreachable. The head's lease is 30 s by default. A member is `ready` while its lease is current and `suspect` once it expires. It is `lost` 90 s after its last heartbeat (`pool.membership.leaseMs` and `lostAfterMs` on the head). `left` means the node left the pool. The head keeps only the inventory fields the planner reads.

**State.** The head keeps membership in `pool-membership.json` next to its config file (mode 0600, atomic writes). The file is written when a token is issued, a node enrolls, or a node is cordoned, drained or uncordoned. Heartbeats are not written: after a head restart, members show their last heartbeat time until they next check in. The file holds SHA-256 hashes of tokens and node secrets, never the values. Both are 256-bit random strings.

**Planning.** `lloom pool plan` reads `GET /gateway/pool/members` and merges members with configured nodes:

- A configured node keeps its endpoint, credentials and resources.
- Membership adds liveness (a `lost` or `left` member is unavailable) and cordon or drain (the node hosts no placements).
- Membership adds inventory when it is more complete than what the head already has.
- An offline plan reads the saved file. It applies cordons, drains and departures there, but not lease ages.

A node that only enrolled is planned on, but it is not routable. The head has no credential for that node's gateway and no model catalog for it, and enrollment does not create either. So the plan warns that the node needs `lloom cluster add-node <id> <endpoint> --apply --yes` before the head can route there, and marks it `enrolled only`. Enrollment does not grant routing: the endpoint a node reports is not used for traffic, and a configured endpoint always wins.

**Auth.** Enrollment accepts only an enrollment token, and heartbeats only a node secret. Admin and inference keys are rejected on both routes, and neither route returns or grants an API key. A node secret is not accepted on any other route. `GET /gateway/pool/members` is admin-read. Token creation and cordon, drain and uncordon are admin writes, so remote use needs `security.allowRemoteAdmin` and an admin key. As with cluster keys, put the head on a private network or behind TLS: plain HTTP carries tokens and secrets in the clear.

## Constraints and objective

- **Memory per domain.** Unified memory on Spark and Apple Silicon. Device memory, plus system memory for host-side state, on discrete GPUs.
  - The budget follows admission: `memoryBudgetGb`, else capacity × `maxMemoryUtilization`, else capacity minus `reserveMemoryGb`. Host memory (unified and system) is also capped at the runtime memory guard's ceiling: `min(runtimePolicy.memorySafety.maxMemoryUtilization, runtimePolicy.maxMemoryUtilization)`, 0.9 by default. The guard aborts any load past that, so a plan that only fits under a 0.95 admission budget would be aborted mid-load. Pool planning then subtracts `headroomGb` (default 4 GB), because exhausting unified memory hangs a Spark. On a 128 GB Spark the default budget is 128 × 0.9 − 4 = 111.2 GB.
  - `always` and `preferred` lanes must fit together. Every on-demand lane must fit next to the `always` set.
  - A `preferred` lane that does not fit becomes on demand, with a warning.
  - A runtime the memory guard aborted counts at least the memory the load had taken when it was stopped (`memorySafetyAbort.consumedGb` in runtime status). While it is latched (no automatic restarts until someone starts it by hand), the planner plans around it.
- **Tensor parallel only across directly linked nodes.** Every pair in a multi-node set must share a reported fabric link.
- **Compute architecture, platform and accelerators** must match the node.
- **Cordoned and unavailable nodes** host nothing.

Plans are compared in this order:

1. Every required workload and pin covered.
2. Fewest workloads on external models, which are a fallback by default. `--external allow` lets them compete on latency; `never` excludes them.
3. Fewest latency SLO misses.
4. Lowest cost. Cost is demand × latency over a 24-hour horizon, plus each change's load time × `churnWeight`.

Latency is time to first token plus decode time for 256 output tokens, or the measured request duration for media. Load time is estimated from the variant's memory, or taken from its `loadSeconds`. Missing weights add download time, a missing image adds pull time, and an unmanaged lane adds a fixed manual-action time.

The search places workloads greedily, pinned and hot ones first, sharing a placement wherever several aliases can use the same lane. Local search then retries each workload with each alternative candidate and keeps any change that makes the whole plan better. For example, local search can move one alias to a smaller model so that another required alias still fits, or move all cognition aliases to a faster lane together once one of them pays its load cost.

## Output

The text output lists:

- each node's memory budget and resident set, and its membership state;
- every placement by tier, with the aliases it serves;
- the changes from now:
  - route changes;
  - lanes to start;
  - manual starts and stops for unmanaged lanes;
  - lanes no workload needs any more (`release`);
  - residency changes;
- uncovered workloads, with reasons.

`--json` returns the full report. It includes the plan's profile-shaped `routes` and `residency`, `placements`, per-node memory, the `diff`, and the `score`.

On a three-Spark fleet, the planner's fixture tests (`test/fixtures/pool/spark-fleet.json`) reproduce the hand-written fleet profiles. With every node present, it gives the `sparkqwen-pair-rc16` routes and residency. With the 01/02 pair cordoned or offline, it gives `standalone`: cognition moves to the 27B on spark-node-03, which becomes `always`, and the SparkQwen lane gets a manual stop.

With the memory guard ceiling applied, the same fixture shows a conflict the hand-written `standalone` profile hides: a keep-warm 27B, embeddings and hear hold 64 GB on spark-node-03, so the 48 GB video lane (112 GB) no longer fits under the 111.2 GB budget, and video is reported uncovered.

## Reconciling a plan

`src/pool-reconciler.mjs` turns a plan and the observed state into ordered steps that never drop a route:

1. **Prefetch** weights for a new placement whose node lacks them.
2. **Downgrade residency** for lanes leaving keep-warm, so LLooM does not restart them while they drain.
3. **Start** new lanes that fit next to everything still running (make before break).
4. **Flip routes** once their target is ready.
5. **Drain and stop** lanes no route uses any more. This includes a lane whose model moved to another node: it stops once the new lane is up. A lane already draining from an earlier change counts as holding its memory until the drain ends.
6. **Upgrade residency** for lanes that just started.

When a new lane only fits after an old one is gone, the move is a swap. The old lane's aliases go to an interim member that is already serving, such as another running lane or an external fallback. Then the old lane drains and stops, the new lane starts, and the aliases flip to it. If there is no interim member, the plan reports an interruption instead of hiding it. Unmanaged lanes (for example a hand-run TP2 server) become `manual-start` and `manual-stop` steps for an operator.

Steps run with dependencies. When a step fails, everything that depends on it is skipped. A lane that fails to start therefore never strands its aliases: their route flips are skipped, and so is the stop of the old lane, which keeps serving. Every step has a timeout (45 minutes for a start, 20 for a drain, 2 hours for a manual step), so one stuck step cannot hold the controller forever.

## Pool controller

`src/pool-controller.mjs` plans, decides and reconciles in a loop:

- **off** never plans.
- **advise** plans and records proposals that a person applies.
- **auto** applies proposals itself.

Moving a model costs minutes of load time, so the controller only acts on a plan worth moving for:

- **Urgent changes act at once.** A change is urgent in two cases:
  - The plan covers a required workload that keeping today's routes would leave uncovered: a node went away, a lane died, or memory was freed.
  - The plan vacates a cordoned or draining node.

  An urgent plan with _different routes_ can cancel a change still in progress. For example, it cancels a manual restart that is waiting on a node which has just died. The same routes never preempt themselves, and residency changes never preempt.

- **Other changes are held back.** The steps must be the same for `confirmTicks` (2) ticks in a row. They must also either cut the latency cost by at least `minGain` (10%) or improve SLOs or local coverage. After that come a `cooldownMs` (15 min) cooldown and a `maxLoadGbPerHour` (400 GB) budget for new loads. A lane already loading does not count against the budget again. A single change larger than the whole budget may still go when nothing else loaded in the past hour.
- **Residency-only changes follow noisy demand,** so they get a slower signal: `maintenanceConfirmTicks` (10) and `maintenanceCooldownMs` (1 hour).
- **Failed starts are skipped for a while.** A lane that fails to start is excluded from planning on that node for `failureBackoffMs` (30 min).
- **One tick at a time.** Ticks never overlap, and an exception thrown by an observer cannot wedge the controller.

## Simulation

`lloom pool simulate` runs a fleet scenario through the real planner, reconciler and controller. It uses a deterministic discrete-event model of the fleet and reads or changes nothing on the gateway or any node. `--mode compare` (the default) runs the scenario twice:

- `off`: what LLooM does today without a pool controller;
- `auto`: with the controller.

The command exits non-zero when a scenario's expectations fail.

```bash
lloom pool simulate test/fixtures/pool/scenarios/pair-crash.json
lloom pool simulate my-fleet.json --mode auto --hours 48 --seed 3 --json
```

The simulator owns the truth: real footprints, load times, request service times and failures. The planner sees only what LLooM would see: configured estimates, footprints measured once a lane has run, observed latency and demand, and node liveness. In membership scenarios, liveness comes from leases. The simulator also models what LLooM already does:

- requests go to the alias's routed member, else the first ready candidate, else a cold start that admission allows, else an external member;
- admission evicts idle on-demand lanes first, then idle preferred lanes, and never evicts keep-warm lanes;
- keep-warm and preferred lanes are restored;
- the memory guard aborts a load past its ceiling and latches the runtime.

A lane whose real footprint overflows physical memory is a memory violation: the node hangs for `hangMinutes`. Plans must never cause one.

**Scenarios** are JSON files with these fields:

- `nodes`, `variants` and `workloads`, in planner shapes. Variants add `sim` truth such as `memoryGbPerNode`, `loadSeconds`, `maxSequences`, `failsOn` and `startFailRate`. Workloads add `demand` (`perHour`, `diurnal`, `bursts`, `changes`).
- `initial` running lanes, routes and residency.
- `events`: `cordon`, `uncordon`, `fail`, `recover`, `join`, `leave`, `partition`, `start-lane`, `stop-lane` and `apply-profile`. An event may be limited to some modes, for example an operator's manual fleet switch that happens only without a controller.
- `operator`: how long manual steps take.
- `membership`: heartbeat, lease and lost-after seconds.
- `expect`: checks per mode, as `{ "path.in.report": { "min" | "max" | "equals" | "includes": … } }`.

A scenario can extend a `base` file. Objects merge, arrays of objects merge by `id` (`"remove": true` drops one), and anything else replaces the base value. The scenarios in `test/fixtures/pool/scenarios/` start from the three-Spark fleet:

| Scenario              | What happens                                                         | Today (`off`)                                                                        | With the controller (`auto`)                                                                             |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pair-taken`          | Operator takes the 01/02 pair for 6 hours and gives it back          | Operator switches fleet profiles by hand                                             | Cordon and uncordon only; the same moves, one apply each                                                 |
| `pair-crash`          | spark-node-01 crashes for 4 hours, nobody watching                   | 60 cold waits, 12 requests to the cloud, 1414 GB reloaded, cognition p95 up to 106 s | 26 cold waits, none to the cloud, 1008 GB reloaded, cognition p95 0.9 s, back on the pair after recovery |
| `lease-loss`          | The same crash, detected only through leases, after a 60 s partition | as above                                                                             | Acts 2 min after the crash (lease lost at 90 s); the partition moves nothing                             |
| `mac-joins`           | A Mac Studio with no weights joins a one-Spark pool                  | Cognition stays on the 27B                                                           | Prefetches weights, moves cognition to the Mac, releases the 27B, drops no requests                      |
| `memory-estimate-low` | The video lane needs 74 GB but is configured as 48 GB                | One guard abort, then the lane is latched                                            | One guard abort; the planner learns the lower bound and plans video as unavailable                       |
| `demand-flap`         | Image and music demand swing hard every 30 minutes                   | n/a                                                                                  | At most one residency change an hour and no extra loads                                                  |

Numbers are from seeded runs of these fixtures. They show behaviour, and are not benchmarks.

**Limits of the model.** Lane capacity is modelled (sequences, decode slowdown with concurrency, queues), but the planner does not use it yet, so an overloaded lane queues rather than gaining a replica. GPU interference between co-located lanes is not modelled. Demand is Poisson with diurnal shape and bursts.
