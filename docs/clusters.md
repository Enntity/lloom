# LLooM clusters

LLooM clusters keep one stable OpenAI/Anthropic-compatible client endpoint while model runtimes live on any number of nodes. Every node runs the same LLooM package and config. `LLOOM_NODE_ID` (or `cluster.nodeId`) identifies the local node; the leader uses authenticated LLooM admin endpoints to inspect telemetry and start or stop runtimes on workers.

The cluster layer supports two placement modes:

- **Replicated**: one physical runtime per node. Requests prefer healthy replicas, choose the least-loaded runtime, and round-robin ties. Each replica retains its own concurrency queue and memory admission.
- **Distributed**: one logical runtime has an ordered list of physical member runtimes across nodes. LLooM starts members in order, rolls back in reverse order after a failure, and stops them in reverse order. The backend launcher still owns engine-specific tensor/pipeline parallelism.

There is no two-node assumption. Node maps, replica targets, distributed members, topology cards, and admission plans are all arrays/maps over the recipe's declared nodes.

## Node configuration

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

Omit `placement.nodes` to use all `cluster.nodes`; set it to an explicit node-ID array for a subset. During materialization LLooM creates a backend/runtime target per node, pins it to that node, rewrites its health/warmup URLs to the node's private `backendHost`, and advertises one logical model ID.

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

For a model such as DSv4Flash that uses both Sparks, define the physical launchers normally and add one logical distributed runtime. The member list can contain any number of nodes and roles:

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

The launcher commands above are installation-specific placeholders. They must remain attached (or manage containers), report real health, bind only to the private fabric, and configure the vLLM/SGLang/Ray parallelism appropriate to the exact model build. LLooM coordinates lifecycle and admission; it does not guess tensor-parallel or pipeline-parallel flags.

Distributed resource estimates belong on each member. Admission evaluates every node independently using live `MemAvailable` plus configured limits. A group is admitted only if it fits every node after safe, node-relevant evictions.

## Operations and topology

```bash
lloom cluster
lloom cluster doctor
lloom runtime-plan dsv4flash-cluster
lloom runtime-start dsv4flash-cluster
```

`GET /gateway/node` returns the local node's CPU, RAM, NVIDIA GPU, and local runtime state. `GET /gateway/cluster` returns all node snapshots, reachability, labels, and runtime state. `/gateway/status` includes the same cluster graph alongside logical runtime status.

The live dashboard renders node cards between the main LLooM chassis and model cards. Each node card reports RAM and GPU utilization; replicated models connect to every target node and distributed models connect to every member node.

Before sending model traffic, `lloom cluster doctor` should report every declared node reachable with memory telemetry. Then start a small replicated lane, verify requests alternate under equal load, and only then canary the distributed engine.
