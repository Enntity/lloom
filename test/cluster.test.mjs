import assert from 'node:assert/strict';
import {
  buildNvidiaSyncDiscovery,
  ClusterCoordinator,
  federatedNodeConfigFromSnapshot,
  materializeFederatedNodes,
  modelTargets,
  parseNvidiaSyncSshConfig,
  runtimePlacement,
  validateClusterConfig
} from '../src/cluster.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';

const syncPeers = parseNvidiaSyncSshConfig(`
Host ennspark02-lan
  ### CreatedBy: NVIDIA Sync
  Hostname 10.100.20.2
  User spark

Host ignored
  Hostname 192.168.1.20
`);
assert.deepEqual(syncPeers, [{ alias: 'ennspark02-lan', createdBySync: true, hostname: '10.100.20.2', user: 'spark' }]);

const discovery = buildNvidiaSyncDiscovery({
  peers: syncPeers,
  localAddresses: [{ interface: 'enp1s0', address: '10.100.20.1', prefixlen: 24 }],
  localNodeId: 'ennspark01',
  hostname: 'spark-host'
});
assert.equal(discovery.provider, 'nvidia-sync');
assert.equal(discovery.nodes.ennspark02.backendHost, '10.100.20.2');

const heterogeneous = {
  cluster: {
    nodeId: 'spark',
    nodes: {
      spark: {
        endpoint: 'http://spark:8100',
        labels: { architecture: 'linux-arm64', accelerator: 'cuda' },
        resources: { memoryGb: 128 }
      },
      macbook: {
        endpoint: 'http://macbook:8100',
        apiKeyEnv: 'LAB_KEY',
        labels: { architecture: 'darwin-arm64', accelerator: 'metal' },
        resources: { memoryGb: 64 },
        proxy: {
          models: [
            { id: 'local/qwen', as: 'lab/qwen', kind: 'chat', capabilities: ['chat', 'tools'] },
            { id: 'local/embed', kind: 'embedding' }
          ]
        }
      },
      linuxbox: {
        endpoint: 'http://linuxbox:8100',
        apiKeyEnv: 'LAB_KEY',
        labels: { architecture: 'linux-amd64', accelerator: 'rocm' },
        proxy: { models: [{ id: 'local/qwen', as: 'lab/qwen', weight: 2 }] }
      }
    }
  },
  backends: {},
  runtimes: {},
  models: []
};

materializeFederatedNodes(heterogeneous);
assert.equal(heterogeneous.backends['lloom-node-macbook'].baseUrl, 'http://macbook:8100/v1');
assert.equal(heterogeneous.backends['lloom-node-macbook'].apiKeyEnv, 'LAB_KEY');
assert.equal(heterogeneous.models.find((model) => model.id === 'macbook/local/embed').kind, 'embedding');
const replicated = heterogeneous.models.find((model) => model.id === 'lab/qwen');
assert.deepEqual(
  modelTargets(replicated).map((target) => [target.node, target.upstreamModel, target.weight]),
  [
    ['macbook', 'local/qwen', 1],
    ['linuxbox', 'local/qwen', 2]
  ]
);
assert.deepEqual(validateClusterConfig(heterogeneous, { LLOOM_NODE_ID: 'spark' }), []);

assert.deepEqual(
  runtimePlacement(
    {
      placement: {
        mode: 'distributed',
        members: [
          { node: 'spark', runtime: 'head', role: 'head', order: 20 },
          { node: 'linuxbox', runtime: 'worker', role: 'worker', order: 10 }
        ]
      }
    },
    heterogeneous,
    { LLOOM_NODE_ID: 'spark' }
  ).nodes,
  ['spark', 'linuxbox']
);

const coordinator = new ClusterCoordinator(heterogeneous, {
  env: { LLOOM_NODE_ID: 'spark', LAB_KEY: 'secret' },
  profile: { platformId: 'linux-arm64', accelerators: ['cuda'] },
  models: [{ id: 'spark/local-model', kind: 'chat' }],
  telemetry: {
    async snapshot() {
      return { memory: { utilization: 25 }, gpu: null };
    }
  }
});
const local = await coordinator.localNodeStatus({ runtimeStatus: { runtimes: {} } });
assert.equal(local.system.platform, process.platform);
assert.equal(local.profile.platformId, 'linux-arm64');
assert.equal(local.models[0].id, 'spark/local-model');
const joinedNode = federatedNodeConfigFromSnapshot({
  nodeId: 'macbook',
  endpoint: 'http://macbook:8100/',
  snapshot: {
    node: {
      name: 'MacBook Local',
      system: { platform: 'darwin', arch: 'arm64' },
      profile: { platformId: 'darwin-arm64', totalMemoryGb: 64, accelerators: ['metal'] },
      models: [
        { id: 'local/qwen', kind: 'chat', runtime: 'qwen' },
        { id: 'cloud/model', kind: 'chat' },
        { id: 'loop', runtime: 'loop', federated: true }
      ]
    }
  }
});
assert.equal(joinedNode.endpoint, 'http://macbook:8100');
assert.equal(joinedNode.labels.architecture, 'darwin-arm64');
assert.deepEqual(
  joinedNode.proxy.models.map((model) => model.as),
  ['macbook/local/qwen']
);

const resolved = { resolvedId: replicated.id, model: replicated };
const nodeStatus = {
  nodes: {
    macbook: { reachable: true },
    linuxbox: { reachable: true }
  }
};
const first = coordinator.selectTarget(resolved, { runtimes: {} }, nodeStatus);
assert.equal(first.node, 'macbook');
await coordinator.withTarget({ ...resolved, target: first }, async () => {
  const whileBusy = coordinator.selectTarget(resolved, { runtimes: {} }, nodeStatus);
  assert.equal(whileBusy.node, 'linuxbox');
});

assert.equal(
  coordinator.selectTarget(
    resolved,
    { runtimes: {} },
    { nodes: { macbook: { reachable: true }, linuxbox: { reachable: false } } }
  ).node,
  'macbook'
);
coordinator.noteTargetOutcome({ ...resolved, target: first }, { ok: false, status: 502 });
assert.equal(coordinator.selectTarget(resolved, { runtimes: {} }, nodeStatus).node, 'linuxbox');

const lifecycleCalls = [];
const lifecycleCoordinator = {
  attachRuntimeManager() {},
  isLocalNode() {
    return false;
  },
  async runtimeAction(node, runtime, action) {
    lifecycleCalls.push(`${action}:${node}:${runtime}`);
    return action === 'start' ? { started: true, healthy: true } : { stopped: true };
  }
};
const distributedConfig = {
  cluster: { nodeId: 'leader', nodes: { leader: {}, worker: { endpoint: 'http://worker:8100' } } },
  runtimes: {
    head: { enabled: true, node: 'leader' },
    worker: { enabled: true, node: 'worker' },
    split: {
      enabled: true,
      placement: {
        mode: 'distributed',
        members: [
          { node: 'leader', runtime: 'head', role: 'head', order: 20 },
          { node: 'worker', runtime: 'worker', role: 'worker', order: 10 }
        ]
      }
    }
  }
};
const manager = new RuntimeManager(distributedConfig, {
  logger: { error() {}, warn() {}, info() {} },
  captureOutput: false,
  clusterCoordinator: lifecycleCoordinator
});
await manager.start('split', { warmup: false });
await manager.stop('split');
assert.deepEqual(lifecycleCalls, [
  'start:worker:worker',
  'start:leader:head',
  'stop:leader:head',
  'stop:worker:worker'
]);

console.log('cluster tests passed');
