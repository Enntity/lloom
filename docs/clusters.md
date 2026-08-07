# LLooM clusters

LLooM clusters keep one stable OpenAI/Anthropic-compatible client endpoint while model runtimes live on any number of nodes. Managed runtime clusters normally use the same LLooM package and config on each node. Federated labs may instead join independently configured LLooM gateways—including Apple Silicon, CUDA, ROCm, and CPU-only hosts—behind one central LLooM. `LLOOM_NODE_ID` (or `cluster.nodeId`) identifies the local node; the leader uses authenticated LLooM endpoints to inspect telemetry, route requests, and start or stop runtimes it manages.

The cluster layer supports two placement modes:

- **Replicated**: one physical runtime per node. Requests prefer healthy replicas, choose the least-loaded runtime, and round-robin ties. Each replica retains its own concurrency queue and memory admission.
- **Distributed**: one logical runtime has an ordered list of physical member runtimes across nodes. LLooM starts members in order, rolls back in reverse order after a failure, and stops them in reverse order. The backend launcher still owns engine-specific tensor/pipeline parallelism.

There is no two-node assumption. Node maps, replica targets, distributed members, topology cards, and admission plans are all arrays/maps over the recipe's declared nodes.

## Federating an existing LLooM

Expose the joining LLooM only on a trusted private network, require authentication, and then run this on the central gateway:

```bash
export LLOOM_CLUSTER_KEY='the key accepted by the joining LLooM'
lloom cluster add-node macbook-local http://macbook-private:8100 --apply
```

The command reads the joining node's `/gateway/node` snapshot, records its architecture, accelerators, memory, and directly hosted model catalog, and creates deterministic gateway names such as `macbook-local/local/qwen`. It never copies credentials into config: the node and generated backend retain only `apiKeyEnv`. Config reload activates the node without restarting the central gateway.

The declarative form is useful for review or hand editing:

```json
{
  "cluster": {
    "nodeId": "spark-1",
    "leaderNode": "spark-1",
    "apiKeyEnv": "LLOOM_CLUSTER_KEY",
    "nodes": {
      "spark-1": { "labels": { "role": "leader", "accelerator": "cuda" } },
      "macbook-local": {
        "endpoint": "http://macbook-private:8100",
        "labels": { "role": "node", "architecture": "darwin-arm64", "accelerator": "metal" },
        "resources": { "memoryGb": 64 },
        "proxy": {
          "models": [
            { "id": "local/qwen", "as": "macbook-local/local/qwen", "kind": "chat" }
          ]
        }
      }
    }
  }
}
```

Set the same `as` ID on two or more node model entries to create one logical model duplicated across hosts. LLooM chooses a reachable, healthy, least-loaded target, applies target weights to ties, and briefly removes a target after an upstream 5xx response so another replica can take over. The cooldown expires automatically, allowing a restarted gateway to rejoin without operator repair. Use `--merge` with `cluster add-node` to merge matching remote model IDs instead of namespacing them.

Only runtime-backed models are imported by default. Pass `--include-external` when the central gateway should also route the joining node's unmanaged cloud or network backends. A model that was itself federated from another LLooM is never re-exported by `cluster add-node`, preventing accidental routing loops. Explicit `models[].targets` remains available when different nodes need different upstream model IDs, weights, or backends.

## Node configuration

On a DGX Spark cluster created by NVIDIA Sync, LLooM can discover the peer alias and private fabric directly:

```bash
lloom cluster discover --id ennspark-cluster
lloom cluster discover --id ennspark-cluster --api-key-env LLOOM_ADMIN_API_KEY --apply
```

Discovery reads only NVIDIA Sync-marked SSH entries and local interface addresses. It records the physical hostnames as metadata but uses the stable Sync/Tailscale aliases (with `-lan` removed) as node IDs. `lloom profile` includes the detected topology, so `lloom select` can rank exact-size cluster recipes before cluster configuration is applied.

Use private fabric addresses for node-to-node LLooM and raw backend traffic. `backendHost` is deliberately required when a recipe auto-materializes replicas; LLooM binds the generated backend only to that address, never to every interface.

```json
{
  "server": { "host": "${LLOOM_GATEWAY_HOST}", "port": 8100 },
  "security": {
    "allowMissingAuth": false,
    "allowNonLoopbackBind": true,
    "allowRemoteAdmin": true,
    "apiKeys": ["${LLOOM_API_KEY}"],
    "adminApiKeys": ["${LLOOM_CLUSTER_KEY}"]
  },
  "cluster": {
    "id": "spark-cluster",
    "nodeId": "${LLOOM_NODE_ID}",
    "leaderNode": "spark-1",
    "apiKeyEnv": "LLOOM_CLUSTER_KEY",
    "nodes": {
      "spark-1": {
        "endpoint": "http://10.10.10.1:8100",
        "backendHost": "10.10.10.1",
        "labels": { "hardware": "dgx-spark", "fabric": "connectx" },
        "resources": { "memoryGb": 128, "maxMemoryUtilization": 0.9 }
      },
      "spark-2": {
        "endpoint": "http://10.10.10.2:8100",
        "backendHost": "10.10.10.2",
        "labels": { "hardware": "dgx-spark", "fabric": "connectx" },
        "resources": { "memoryGb": 128, "maxMemoryUtilization": 0.9 }
      }
    }
  }
}
```

Deploy that same file to every Spark and set only the local environment:

```bash
# spark-1
export LLOOM_NODE_ID=spark-1 LLOOM_GATEWAY_HOST=10.10.10.1

# spark-2
export LLOOM_NODE_ID=spark-2 LLOOM_GATEWAY_HOST=10.10.10.2
```

Keep `LLOOM_CLUSTER_KEY` identical on all nodes. A production firewall should allow port 8100 and backend ports only on the private fabric. Clients should use the leader LLooM URL, not worker or backend ports.

## Replicated models

A recipe can materialize the same model on every configured node without naming a fixed cluster size:

```json
{
  "model": "unsloth/Qwen3.6-27B-NVFP4",
  "gatewayModel": "unsloth/Qwen3.6-27B-NVFP4",
  "settings": {
    "memoryGb": 48,
    "maxActiveRequests": 4,
    "placement": { "mode": "replicated" }
  }
}
```

Omit `placement.nodes` to use all `cluster.nodes`; set it to an explicit node-ID array for a subset, or use the `leader`, `worker`, or `workers` role selectors. During materialization LLooM creates a backend/runtime target per node, pins it to that node, rewrites its health/warmup URLs and Docker publish address to the node's private `backendHost`, and advertises one logical model ID.

The equivalent explicit config is:

```json
{
  "models": [{
    "id": "example/Qwen",
    "targets": [
      { "id": "spark-1", "node": "spark-1", "backend": "qwen-spark-1", "runtime": "qwen-spark-1" },
      { "id": "spark-2", "node": "spark-2", "backend": "qwen-spark-2", "runtime": "qwen-spark-2" }
    ]
  }]
}
```

## Distributed models

For a model such as DeepSeek V4 Flash that uses both Sparks, a recipe may declare member runtime templates. LLooM resolves `nodeRole` selectors, materializes one physical runtime per node, and adds one logical distributed runtime. The member list can contain any number of nodes and roles. Headless Docker workers use `healthStrategy: "container"`; the head owns the HTTP health check.

The checked-in `linux-nvidia-dgx-spark-2x-deepseek-v4-flash-mia-vllm` recipe is the concrete two-Spark example. It is based on MiaAI Lab's validated multiprocess vLLM recipe, pins the official 0731 model revision and runtime image digest, starts the worker before the head, and binds the raw vLLM API only to the private NVIDIA Sync fabric.

The companion `linux-nvidia-dgx-spark-cluster-flux2-klein-4b` recipe demonstrates a single worker-pinned service. It keeps the image model on a worker while clients continue to use the leader LLooM endpoint.

Explicit config remains supported:

```json
{
  "runtimes": {
    "dsv4-ray-head": {
      "enabled": true,
      "node": "spark-1",
      "command": "/opt/lloom/bin/start-ray-head",
      "healthUrl": "http://10.10.10.1:8265/api/version",
      "memoryGb": 6
    },
    "dsv4-ray-worker-2": {
      "enabled": true,
      "node": "spark-2",
      "command": "/opt/lloom/bin/start-ray-worker",
      "healthUrl": "http://10.10.10.2:8266/health",
      "memoryGb": 6
    },
    "dsv4-vllm-server": {
      "enabled": true,
      "node": "spark-1",
      "command": "/opt/lloom/bin/start-dsv4flash-vllm",
      "healthUrl": "http://10.10.10.1:8205/health",
      "memoryGb": 54
    },
    "dsv4flash-cluster": {
      "enabled": true,
      "healthUrl": "http://10.10.10.1:8205/health",
      "placement": {
        "mode": "distributed",
        "members": [
          { "node": "spark-1", "runtime": "dsv4-ray-head", "role": "head", "order": 10, "resources": { "memoryGb": 6 } },
          { "node": "spark-2", "runtime": "dsv4-ray-worker-2", "role": "worker", "order": 20, "resources": { "memoryGb": 54 } },
          { "node": "spark-1", "runtime": "dsv4-vllm-server", "role": "server", "order": 30, "resources": { "memoryGb": 54 } }
        ]
      }
    }
  },
  "models": [{
    "id": "deepseek-ai/DSv4Flash",
    "backend": "dsv4flash",
    "runtime": "dsv4flash-cluster",
    "upstreamModel": "deepseek-ai/DSv4Flash"
  }]
}
```

Launcher commands in explicit config are installation-specific. They must remain attached (or manage containers), report real health, bind only to the private fabric, and configure the vLLM/SGLang/Ray parallelism appropriate to the exact model build. LLooM coordinates lifecycle and admission; engine-specific flags live in reviewed recipes rather than being guessed at runtime.

Distributed resource estimates belong on each member. Admission evaluates every node independently using live `MemAvailable` plus configured limits. A group is admitted only if it fits every node after safe, node-relevant evictions.

## Operations and topology

```bash
lloom cluster
lloom cluster doctor
lloom runtime-plan dsv4flash-cluster
lloom runtime-start dsv4flash-cluster
```

`GET /gateway/node` returns the local node's system identity, machine profile, directly advertised models, CPU/RAM telemetry, optional GPU telemetry, and local runtime state. `GET /gateway/cluster` returns all node snapshots, reachability, labels, and runtime state. `/gateway/status` includes the same cluster graph alongside logical runtime status.

The live dashboard renders node cards between the main LLooM chassis and model cards. Each node card reports architecture, accelerator type, CPU, RAM, GPU compute, GPU memory, temperature, and power when the host can report them. Unsupported fields render as unavailable rather than inventing values; Apple Silicon still reports its profile and shared-memory pressure even when per-GPU utilization is unavailable. Select a node for its complete profile. Replicated models connect to every target node and distributed models connect to every member node.

Before sending model traffic, `lloom cluster doctor` should report every declared node reachable with memory telemetry. Then start a small replicated lane, verify requests alternate under equal load, and only then canary the distributed engine.
