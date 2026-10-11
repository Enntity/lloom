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

- each node's memory budget and resident set;
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
