# Pool planning

`lloom pool plan` treats every node in the cluster as one pool and proposes which model lanes run where, how each alias routes, and what would change from today. It is a dry run: it never starts, stops or reroutes anything, and there is no apply step yet. Act on a plan with `lloom fleet`, `lloom route`, `lloom keep-warm` and `lloom suspend`/`resume`.

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
  { "id": "qwen3.8-flash-next-atlas", "backend": "atlas", "pool": { "nodes": ["spark-node-01", "spark-node-02"], "memoryGbPerNode": 110 } }
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

# on the joining node (token on stdin, never in argv)
lloom pool join http://head-private:8100 --token-stdin --endpoint http://10.10.10.2:8100 --apply --yes
```

**Enrollment.** `POST /gateway/pool/enroll` takes the token as a bearer credential and the node's `nodeId`, `endpoint` and optional `labels`. It returns a node secret and the lease length. A token expires (default one hour) and has a use count (default one). Labels set on the token override labels the node sends. Enrolling an existing node id again needs a different token, and rotates the node's secret. It keeps any cordon or drain, so a node cannot re-enroll its way out of one. A node cannot enroll with the head's own node id. Attempts are rate limited per client address.

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
  - The budget follows admission: `memoryBudgetGb`, else capacity × `maxMemoryUtilization`, else capacity minus `reserveMemoryGb`. Pool planning then subtracts `headroomGb` (default 4 GB), because exhausting unified memory hangs a Spark.
  - `always` and `preferred` lanes must fit together. Every on-demand lane must fit next to the `always` set.
  - A `preferred` lane that does not fit becomes on demand, with a warning.
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
