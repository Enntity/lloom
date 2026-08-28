import assert from 'node:assert/strict';
import http from 'node:http';
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
import {
  dockerCreateArgs,
  keepWarmOwnership,
  ownsDistributedRuntime,
  reconfigureRuntimeIds,
  RuntimeManager,
  shouldRecreateDockerContainer
} from '../src/runtime-manager.mjs';

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
            {
              id: 'local/qwen',
              as: 'lab/qwen',
              kind: 'chat',
              capabilities: ['chat', 'tools'],
              remoteRuntime: 'mac-qwen'
            },
            { id: 'local/embed', kind: 'embedding', remoteRuntime: 'mac-embed' }
          ]
        }
      },
      linuxbox: {
        endpoint: 'http://linuxbox:8100',
        apiKeyEnv: 'LAB_KEY',
        labels: { architecture: 'linux-amd64', accelerator: 'rocm' },
        proxy: { models: [{ id: 'local/qwen', as: 'lab/qwen', weight: 2, remoteRuntime: 'linux-qwen' }] }
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
  modelTargets(replicated).map((target) => [target.node, target.upstreamModel, target.remoteRuntime, target.weight]),
  [
    ['macbook', 'local/qwen', 'mac-qwen', 1],
    ['linuxbox', 'local/qwen', 'linux-qwen', 2]
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

const longStartCalls = [];
const longStartCoordinator = new ClusterCoordinator(
  {
    cluster: {
      nodeId: 'leader',
      nodes: {
        leader: { endpoint: 'http://leader:8100' },
        worker: { endpoint: 'http://worker:8100' }
      }
    },
    runtimes: { worker: { startupTimeoutMs: 7_200_000 } }
  },
  {
    env: { LLOOM_NODE_ID: 'leader' },
    fetchImpl: async (_url, options) => {
      longStartCalls.push(options);
      return new Response(JSON.stringify({ started: true, healthy: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  }
);
await longStartCoordinator.runtimeAction('worker', 'worker', 'start');
assert.equal(longStartCalls.length, 1);
assert(longStartCalls[0].dispatcher, 'cluster requests must override the five-minute fetch headers timeout');
assert.equal(longStartCalls[0].signal.aborted, false);
const longStartTimeoutCalls = [];
longStartCoordinator.requestNode = async (...args) => {
  longStartTimeoutCalls.push(args);
  return { started: true, healthy: true };
};
await longStartCoordinator.runtimeAction('worker', 'worker', 'start');
assert.equal(longStartTimeoutCalls[0][2].timeoutMs, 7_260_000);
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
  joinedNode.proxy.models.map((model) => [model.as, model.remoteRuntime]),
  [['macbook/local/qwen', 'qwen']]
);

const resolved = { resolvedId: replicated.id, model: replicated };
const nodeStatus = {
  nodes: {
    macbook: {
      reachable: true,
      runtimeManager: { runtimes: { 'mac-qwen': { status: 'running', healthy: true } } }
    },
    linuxbox: {
      reachable: true,
      runtimeManager: { runtimes: { 'linux-qwen': { status: 'running', healthy: true } } }
    }
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
    {
      nodes: {
        macbook: {
          reachable: true,
          runtimeManager: { runtimes: { 'mac-qwen': { status: 'running', healthy: true } } }
        },
        linuxbox: { reachable: false }
      }
    }
  ).node,
  'macbook'
);
assert.equal(
  coordinator.selectTarget(
    resolved,
    { runtimes: {} },
    {
      nodes: {
        macbook: {
          reachable: true,
          runtimeManager: {
            runtimes: { 'mac-qwen': { status: 'running', healthy: true, activeRequests: 3 } }
          }
        },
        linuxbox: {
          reachable: true,
          runtimeManager: {
            runtimes: { 'linux-qwen': { status: 'running', healthy: true, activeRequests: 0 } }
          }
        }
      }
    }
  ).node,
  'linuxbox'
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
  cluster: {
    nodeId: 'leader',
    leaderNode: 'leader',
    nodes: { leader: {}, worker: { endpoint: 'http://worker:8100' } }
  },
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

const healthyServer = http.createServer((_request, response) => {
  response.writeHead(200).end('ok');
});
await new Promise((resolve) => healthyServer.listen(0, '127.0.0.1', resolve));
distributedConfig.runtimes.split.healthUrl = `http://127.0.0.1:${healthyServer.address().port}/health`;
assert.equal(await manager.isHealthy('split'), true, 'logical distributed health bypasses unrelated admission work');
const callsBeforeHealthyEnsure = lifecycleCalls.length;
const startsBeforeHealthyEnsure = manager.stateFor('split').starts;
manager.stateFor('split').lastError = 'stale failure';
assert.deepEqual(await manager.start('split', { warmup: false }), {
  runtimeId: 'split',
  started: false,
  healthy: true,
  distributed: true,
  reason: 'already-healthy'
});
assert.equal(lifecycleCalls.length, callsBeforeHealthyEnsure, 'healthy ensure does not flap either rank');
assert.equal(manager.stateFor('split').starts, startsBeforeHealthyEnsure, 'healthy ensure is not counted as a start');
assert.equal(manager.stateFor('split').lastError, null, 'healthy ensure clears stale failure state');
await new Promise((resolve) => healthyServer.close(resolve));
delete distributedConfig.runtimes.split.healthUrl;
assert.equal(await manager.isHealthy('missing-runtime'), false);

manager.stateFor('worker').status = 'running';
const recoveryStart = lifecycleCalls.length;
await manager.start('split', { warmup: false });
assert.equal(manager.stateFor('split').lastError, null, 'successful recovery clears stale failure state');
assert.deepEqual(lifecycleCalls.slice(recoveryStart), [
  'stop:leader:head',
  'stop:worker:worker',
  'start:worker:worker',
  'start:leader:head'
]);
assert.equal(
  manager.events.some((event) => event.runtimeId === 'split' && event.event === 'distributed-recovery'),
  true
);

let blockedStartReady;
const blockedStartStarted = new Promise((resolve) => {
  blockedStartReady = resolve;
});
const cancellableDistributedManager = new RuntimeManager(structuredClone(distributedConfig), {
  logger: { error() {}, warn() {}, info() {} },
  captureOutput: false,
  clusterCoordinator: {
    attachRuntimeManager() {},
    isLocalNode(node) {
      return node === 'leader';
    },
    async runtimeAction(node, runtime, action, _body, options = {}) {
      if (action !== 'start') return { stopped: true };
      blockedStartReady();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
  }
});
delete cancellableDistributedManager.config.runtimes.split.healthUrl;
const blockedDistributedStart = cancellableDistributedManager.start('split', { warmup: false });
await blockedStartStarted;
const preemptiveStop = cancellableDistributedManager.stop('split');
await assert.rejects(blockedDistributedStart, /runtime stop requested|stop requested/);
assert.equal((await preemptiveStop).stopped, true, 'operator stop preempts an in-flight distributed start');

const upgradedDistributedConfig = structuredClone(distributedConfig);
upgradedDistributedConfig.runtimes.head.recipe = { id: 'flash', version: 7 };
upgradedDistributedConfig.runtimes.worker.recipe = { id: 'flash', version: 7 };
assert.deepEqual(
  reconfigureRuntimeIds(distributedConfig, upgradedDistributedConfig, {
    nodeId: 'worker',
    leaderNode: 'leader'
  }),
  ['worker']
);
assert.deepEqual(
  reconfigureRuntimeIds(distributedConfig, upgradedDistributedConfig, {
    nodeId: 'leader',
    leaderNode: 'leader'
  }),
  ['head', 'split']
);
assert.equal(
  ownsDistributedRuntime(distributedConfig, distributedConfig.runtimes.split, {
    nodeId: 'worker',
    leaderNode: 'leader'
  }),
  false
);

const workerKeepWarmManager = new RuntimeManager(
  { ...structuredClone(distributedConfig), cluster: { ...distributedConfig.cluster, nodeId: 'worker' } },
  {
    logger: { error() {}, warn() {}, info() {} },
    captureOutput: false,
    clusterCoordinator: {
      nodeId: 'worker',
      attachRuntimeManager() {},
      isLocalNode(nodeId) {
        return nodeId === 'worker';
      }
    }
  }
);
workerKeepWarmManager.config.runtimes.head.keepWarm = true;
workerKeepWarmManager.config.runtimes.worker.keepWarm = true;
workerKeepWarmManager.config.runtimes.split.keepWarm = true;
assert.deepEqual(keepWarmOwnership(workerKeepWarmManager.config, 'head', { nodeId: 'worker' }), {
  owned: false,
  reason: 'distributed-runtime-owned'
});
assert.deepEqual(await workerKeepWarmManager.startKeepWarm(), [
  { runtimeId: 'head', started: false, reason: 'distributed-runtime-owned' },
  { runtimeId: 'worker', started: false, reason: 'distributed-runtime-owned' },
  { runtimeId: 'split', started: false, reason: 'leader-owned' }
]);

const reconfigureCalls = [];
const leaderReconfigureManager = new RuntimeManager(structuredClone(distributedConfig), {
  logger: { error() {}, warn() {}, info() {} },
  captureOutput: false,
  clusterCoordinator: {
    nodeId: 'leader',
    attachRuntimeManager() {},
    isLocalNode(nodeId) {
      return nodeId === 'leader';
    }
  }
});
leaderReconfigureManager.drainRuntime = async (runtimeId) => reconfigureCalls.push(`drain:${runtimeId}`);
leaderReconfigureManager.stop = async (runtimeId) => {
  reconfigureCalls.push(`stop:${runtimeId}`);
  return { runtimeId, stopped: true };
};
leaderReconfigureManager.admit = async (runtimeId) => {
  reconfigureCalls.push(`admit:${runtimeId}`);
  return { runtimeId, admitted: true };
};
upgradedDistributedConfig.runtimes.split.keepWarm = true;
const reconfigured = await leaderReconfigureManager.reconfigure(upgradedDistributedConfig);
assert.deepEqual(reconfigured.changed, ['head', 'split']);
assert.deepEqual(reconfigureCalls, ['drain:split', 'stop:split', 'admit:split']);
assert.deepEqual(reconfigured.results.at(-1), {
  runtimeId: 'head',
  started: false,
  reason: 'distributed-runtime-owned'
});

const workerReconfigureCalls = [];
const workerReconfigureManager = new RuntimeManager(
  { ...structuredClone(distributedConfig), cluster: { ...distributedConfig.cluster, nodeId: 'worker' } },
  {
    logger: { error() {}, warn() {}, info() {} },
    captureOutput: false,
    clusterCoordinator: {
      nodeId: 'worker',
      attachRuntimeManager() {},
      isLocalNode(nodeId) {
        return nodeId === 'worker';
      }
    }
  }
);
workerReconfigureManager.drainRuntime = async (runtimeId) => workerReconfigureCalls.push(`drain:${runtimeId}`);
workerReconfigureManager.stop = async (runtimeId) => {
  workerReconfigureCalls.push(`stop:${runtimeId}`);
  return { runtimeId, stopped: true };
};
workerReconfigureManager.admit = async (runtimeId) => {
  workerReconfigureCalls.push(`admit:${runtimeId}`);
  return { runtimeId, admitted: true };
};
const workerReconfigured = await workerReconfigureManager.reconfigure(upgradedDistributedConfig);
assert.deepEqual(workerReconfigured.changed, ['worker']);
assert.deepEqual(workerReconfigureCalls, []);
assert.deepEqual(workerReconfigured.results, [
  { runtimeId: 'worker', started: false, reason: 'distributed-runtime-owned' }
]);
assert.equal(workerReconfigureManager.config.runtimes.worker.recipe.version, 7);

const demotedKeepWarmConfig = {
  cluster: { nodeId: 'leader', leaderNode: 'leader' },
  runtimes: {
    standalone: {
      enabled: true,
      keepWarm: true,
      command: 'standalone-server',
      recipe: { id: 'standalone', version: 1 }
    }
  }
};
const demotedReconfigureManager = new RuntimeManager(structuredClone(demotedKeepWarmConfig), {
  logger: { error() {}, warn() {}, info() {} },
  captureOutput: false
});
demotedReconfigureManager.processes.set('standalone', {
  pid: 123,
  exitCode: null,
  signalCode: null
});
const demotedCalls = [];
demotedReconfigureManager.drainRuntime = async (runtimeId) => demotedCalls.push(`drain:${runtimeId}`);
demotedReconfigureManager.stop = async (runtimeId) => {
  demotedCalls.push(`stop:${runtimeId}`);
  return { runtimeId, stopped: true };
};
demotedReconfigureManager.admit = async (runtimeId) => {
  demotedCalls.push(`admit:${runtimeId}`);
  return { runtimeId, admitted: true };
};
const demotedNextConfig = structuredClone(demotedKeepWarmConfig);
demotedNextConfig.runtimes.standalone.keepWarm = false;
demotedNextConfig.runtimes.standalone.recipe.version = 2;
const demoted = await demotedReconfigureManager.reconfigure(demotedNextConfig);
assert.deepEqual(demotedCalls, ['drain:standalone', 'stop:standalone']);
assert.deepEqual(demoted.results, [{ runtimeId: 'standalone', started: false, reason: 'not-keep-warm' }]);

const reconfiguringRequestManager = new RuntimeManager(structuredClone(demotedKeepWarmConfig), {
  logger: { error() {}, warn() {}, info() {} },
  captureOutput: false
});
reconfiguringRequestManager.reconfiguringRuntimes.add('standalone');
await assert.rejects(
  reconfiguringRequestManager.start('standalone', { reason: 'model-request' }),
  (error) => error.code === 'RUNTIME_RECONFIGURING' && error.statusCode === 503
);

const admissionBusyManager = new RuntimeManager(
  { runtimes: {} },
  {
    logger: { error() {}, warn() {}, info() {} },
    captureOutput: false
  }
);
let releaseActiveAdmission;
const activeAdmission = admissionBusyManager.withAdmissionLock(
  () =>
    new Promise((resolve) => {
      releaseActiveAdmission = resolve;
    }),
  { runtimeId: 'qwen', reason: 'admin-admit' }
);
await new Promise((resolve) => setImmediate(resolve));
await assert.rejects(
  admissionBusyManager.withAdmissionLock(async () => 'unexpected', {
    runtimeId: 'deepseek',
    reason: 'model-request'
  }),
  (error) => error.code === 'RUNTIME_ADMISSION_BUSY' && error.statusCode === 503
);
releaseActiveAdmission();
await activeAdmission;

const managedDockerRuntime = {
  containerName: 'managed-runtime',
  bootstrap: { adapter: 'docker', image: 'example/model:v2', command: ['serve'] }
};
assert.equal(shouldRecreateDockerContainer(managedDockerRuntime, { exists: true, specHash: null }), true);
assert.equal(shouldRecreateDockerContainer(managedDockerRuntime, { exists: true, specHash: 'stale' }), true);
const managedDockerArgs = dockerCreateArgs(managedDockerRuntime);
const managedDockerSpecHash = managedDockerArgs[4].split('=', 2)[1];
assert.equal(
  shouldRecreateDockerContainer(managedDockerRuntime, { exists: true, specHash: managedDockerSpecHash }),
  false
);

const cancellableManager = new RuntimeManager({ runtimes: {} });
let lifecycleStarted;
const lifecycleReady = new Promise((resolve) => {
  lifecycleStarted = resolve;
});
const blockedLifecycle = cancellableManager.withRuntimeLifecycleLock('changing-runtime', async (signal) => {
  lifecycleStarted();
  await new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
});
await lifecycleReady;
assert.equal(cancellableManager.abortRuntimeLifecycle('changing-runtime', 'superseded by test config'), true);
await assert.rejects(blockedLifecycle, /superseded by test config/);
assert.equal(cancellableManager.abortRuntimeLifecycle('changing-runtime'), false);
assert.equal(
  cancellableManager.events.some(
    (event) => event.event === 'lifecycle-abort' && event.runtimeId === 'changing-runtime'
  ),
  true
);

console.log('cluster tests passed');
