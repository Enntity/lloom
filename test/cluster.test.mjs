import assert from 'node:assert/strict';
import {
  ClusterCoordinator,
  modelTargets,
  runtimePlacement,
  runtimeResourcesByNode,
  validateClusterConfig
} from '../src/cluster.mjs';
import { createRegistry } from '../src/registry.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { createRuntimePolicyPlan } from '../src/runtime-policy.mjs';
import { deriveUserConfig } from '../src/init.mjs';

const config = {
  cluster: {
    id: 'spark-cluster',
    nodeId: 'spark-1',
    leaderNode: 'spark-1',
    nodes: {
      'spark-1': { endpoint: 'http://spark-1:8100', resources: { memoryGb: 128 } },
      'spark-2': { endpoint: 'http://spark-2:8100', resources: { memoryGb: 128 } }
    }
  },
  backends: {
    'qwen-spark-1': { type: 'openai', baseUrl: 'http://spark-1:9001/v1' },
    'qwen-spark-2': { type: 'openai', baseUrl: 'http://spark-2:9001/v1' },
    distributed: { type: 'openai', baseUrl: 'http://spark-1:9002/v1' }
  },
  runtimes: {
    'qwen-spark-1': { enabled: true, node: 'spark-1', memoryGb: 40, management: 'external' },
    'qwen-spark-2': { enabled: true, node: 'spark-2', memoryGb: 40, management: 'external' },
    'ray-head': { enabled: true, node: 'spark-1', memoryGb: 6, management: 'external' },
    'ray-worker': { enabled: true, node: 'spark-2', memoryGb: 6, management: 'external' },
    'dsv4-server': { enabled: true, node: 'spark-1', memoryGb: 54, management: 'external' },
    'dsv4-cluster': {
      enabled: true,
      placement: {
        mode: 'distributed',
        members: [
          { node: 'spark-1', runtime: 'ray-head', role: 'head', order: 10, resources: { memoryGb: 6 } },
          { node: 'spark-2', runtime: 'ray-worker', role: 'worker', order: 20, resources: { memoryGb: 54 } },
          { node: 'spark-1', runtime: 'dsv4-server', role: 'server', order: 30, resources: { memoryGb: 54 } }
        ]
      }
    }
  },
  models: [
    {
      id: 'qwen',
      targets: [
        { id: 'spark-1', node: 'spark-1', backend: 'qwen-spark-1', runtime: 'qwen-spark-1' },
        { id: 'spark-2', node: 'spark-2', backend: 'qwen-spark-2', runtime: 'qwen-spark-2' }
      ]
    },
    { id: 'dsv4flash', backend: 'distributed', runtime: 'dsv4-cluster' }
  ]
};

assert.deepEqual(validateClusterConfig(config), []);
assert(
  validateClusterConfig({
    ...config,
    runtimes: {
      a: { placement: { mode: 'distributed', members: [{ node: 'spark-1', runtime: 'b' }] } },
      b: { placement: { mode: 'distributed', members: [{ node: 'spark-2', runtime: 'a' }] } }
    },
    models: []
  }).some((error) => error.includes('distributed runtime cycle'))
);
assert.equal(modelTargets(config.models[0]).length, 2);
assert.deepEqual(runtimePlacement(config.runtimes['dsv4-cluster'], config).nodes, ['spark-1', 'spark-2']);
assert.deepEqual(runtimeResourcesByNode(config.runtimes['dsv4-cluster'], config), {
  'spark-1': { memoryGb: 60, gpuMemoryGb: 0 },
  'spark-2': { memoryGb: 54, gpuMemoryGb: 0 }
});

const replicatedRecipeConfig = deriveUserConfig(
  {
    cluster: {
      nodeId: 'spark-1',
      nodes: {
        'spark-1': { endpoint: 'http://spark-1:8100', backendHost: '10.10.10.1' },
        'spark-2': { endpoint: 'http://spark-2:8100', backendHost: '10.10.10.2' }
      }
    },
    defaults: {},
    backends: {},
    runtimes: {},
    models: [],
    aliases: {},
    clientCatalog: { modelOrder: [] }
  },
  {
    id: 'replicated-vllm-test',
    version: 1,
    backend: { id: 'vllm' },
    models: [
      {
        role: 'chat',
        model: 'example/Qwen',
        gatewayModel: 'example/Qwen',
        capabilities: ['chat'],
        settings: { memoryGb: 40, placement: { mode: 'replicated' } }
      }
    ]
  },
  { modelRoot: '/models', backendPortRange: { start: 8301, end: 8302 } }
);
const replicatedModel = replicatedRecipeConfig.models.find((model) => model.id === 'example/Qwen');
assert.equal(replicatedModel.targets.length, 2);
assert.equal(replicatedRecipeConfig.runtimes['vllm-example-qwen-spark-1'].node, 'spark-1');
assert.equal(replicatedRecipeConfig.runtimes['vllm-example-qwen-spark-1'].args.includes('10.10.10.1'), true);
assert.equal(replicatedRecipeConfig.backends['vllm-example-qwen-spark-2'].baseUrl, 'http://10.10.10.2:8302/v1');
assert.equal(replicatedRecipeConfig.runtimes['vllm-example-qwen-spark-1'].port, 8301);

const registry = createRegistry(config);
const resolved = registry.resolve('qwen');
const coordinator = new ClusterCoordinator(config, { env: {}, telemetry: null });
const runtimeStatus = {
  runtimes: {
    'qwen-spark-1': { healthy: true, status: 'running', activeRequests: 1, queuedRequests: 0 },
    'qwen-spark-2': { healthy: true, status: 'running', activeRequests: 0, queuedRequests: 0 }
  }
};
assert.equal(coordinator.selectTarget(resolved, runtimeStatus).id, 'spark-2');
runtimeStatus.runtimes['qwen-spark-1'].activeRequests = 0;
assert.equal(coordinator.selectTarget(resolved, runtimeStatus).id, 'spark-2');
assert.equal(coordinator.selectTarget(resolved, runtimeStatus).id, 'spark-1');

const remoteRequests = [];
const remoteCoordinator = new ClusterCoordinator(
  {
    ...config,
    cluster: { ...config.cluster, apiKeyEnv: 'CLUSTER_KEY' }
  },
  {
    env: { CLUSTER_KEY: 'secret' },
    fetchImpl: async (url, options) => {
      remoteRequests.push({ url, options });
      return new Response(
        JSON.stringify({
          ok: true,
          node: {
            id: 'spark-2',
            telemetry: { memory: { totalBytes: 128 * 1024 ** 3 } },
            runtimeManager: { runtimes: {} }
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
  }
);
const remoteNode = await remoteCoordinator.nodeStatus('spark-2');
assert.equal(remoteNode.reachable, true);
assert.equal(remoteRequests[0].url, 'http://spark-2:8100/gateway/node');
assert.equal(remoteRequests[0].options.headers.authorization, 'Bearer secret');
await remoteCoordinator.runtimeAction('spark-2', 'qwen-spark-2', 'start', { warmup: false });
assert.equal(remoteRequests[1].url, 'http://spark-2:8100/gateway/runtimes/qwen-spark-2/start');
assert.equal(remoteRequests[1].options.method, 'POST');

const admission = await createRuntimePolicyPlan(config, {
  requestedRuntimeId: 'dsv4-cluster',
  status: {
    runtimes: Object.fromEntries(Object.keys(config.runtimes).map((id) => [id, { status: 'stopped', healthy: false }])),
    cluster: {
      nodes: {
        'spark-1': {
          local: true,
          reachable: true,
          telemetry: { memory: { totalBytes: 128 * 1024 ** 3, availableBytes: 88 * 1024 ** 3 } }
        },
        'spark-2': {
          local: false,
          reachable: true,
          telemetry: { memory: { totalBytes: 128 * 1024 ** 3, availableBytes: 88 * 1024 ** 3 } }
        }
      }
    }
  },
  profile: { totalMemoryGb: 128, availableMemoryGb: 88 }
});
assert.equal(admission.admission.clustered, true);
assert.equal(admission.admission.allowed, true);
assert.equal(admission.admission.nodes['spark-1'].requestedAddsMemoryGb, 60);
assert.equal(admission.admission.nodes['spark-2'].requestedAddsMemoryGb, 54);

const loadedGroupPlan = await createRuntimePolicyPlan(config, {
  status: {
    runtimes: Object.fromEntries(
      Object.keys(config.runtimes).map((id) => [
        id,
        {
          status: id.startsWith('dsv4') || id.startsWith('ray-') ? 'running' : 'stopped',
          healthy: id.startsWith('dsv4') || id.startsWith('ray-')
        }
      ])
    ),
    cluster: {
      nodes: {
        'spark-1': { local: true, reachable: true },
        'spark-2': { local: false, reachable: true }
      }
    }
  },
  profile: { totalMemoryGb: 128, availableMemoryGb: 68 }
});
assert.equal(loadedGroupPlan.admission.nodes['spark-1'].loadedMemoryGb, 60);
assert.equal(loadedGroupPlan.admission.nodes['spark-2'].loadedMemoryGb, 54);

const lifecycle = [];
const fakeCoordinator = {
  attachRuntimeManager(manager) {
    this.runtimeManager = manager;
  },
  isLocalNode(node) {
    return node === 'spark-1';
  },
  async runtimeAction(node, runtime, action) {
    lifecycle.push(`${action}:${node}:${runtime}`);
    return action === 'stop'
      ? { runtimeId: runtime, stopped: true }
      : { runtimeId: runtime, started: true, healthy: true };
  }
};
const manager = new RuntimeManager(config, { clusterCoordinator: fakeCoordinator, captureOutput: false });
manager.start = async function (runtimeId, options) {
  const placement = runtimePlacement(this.getRuntime(runtimeId), this.config);
  if (placement.mode === 'distributed') return this.startUnlocked(runtimeId, options);
  lifecycle.push(`start:${placement.node}:${runtimeId}`);
  return { runtimeId, started: true, healthy: true };
};
manager.stop = async function (runtimeId) {
  const placement = runtimePlacement(this.getRuntime(runtimeId), this.config);
  if (placement.mode === 'distributed') return this.stopUnlocked(runtimeId);
  lifecycle.push(`stop:${placement.node}:${runtimeId}`);
  return { runtimeId, stopped: true };
};
await manager.startUnlocked('dsv4-cluster', { warmup: false, reason: 'test' });
assert.deepEqual(lifecycle, ['start:spark-1:ray-head', 'start:spark-2:ray-worker', 'start:spark-1:dsv4-server']);
lifecycle.length = 0;
await manager.stopUnlocked('dsv4-cluster');
assert.deepEqual(lifecycle, ['stop:spark-1:dsv4-server', 'stop:spark-2:ray-worker', 'stop:spark-1:ray-head']);

console.log('cluster tests passed');
