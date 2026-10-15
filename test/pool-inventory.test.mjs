// Node inventory tests. Every probe (statfs, docker, commands, model files) is
// injected; nothing touches the host's model roots or container runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClusterCoordinator } from '../src/cluster.mjs';
import {
  collectNodeInventory,
  computeArchsForProfile,
  createNodeInventoryCache,
  inventoryFromProfile
} from '../src/pool-inventory.mjs';

const sparkProfile = {
  platformId: 'linux-arm64',
  totalMemoryGb: 119.7,
  isAppleSilicon: false,
  accelerators: ['cuda', 'nvidia-gpu', 'blackwell', 'gb10'],
  devices: [{ id: 'cuda:0', kind: 'gpu', vendor: 'nvidia', backend: 'cuda', computeCapability: '12.1' }],
  memoryDomains: [{ id: 'unified:0', kind: 'unified', capacityGb: 119.7, deviceIds: ['cuda:0'] }],
  cluster: {
    provider: 'nvidia-sync',
    links: [
      {
        nodeId: 'spark-node-01',
        peerNodeId: 'spark-node-02',
        localInterface: 'enp1s0f0np0',
        peerAddress: '10.100.0.2'
      },
      { nodeId: 'spark-node-01', peerNodeId: 'spark-node-02', localInterface: 'enp1s0f1np1', peerAddress: '10.100.1.2' }
    ]
  }
};

test('compute architectures are structured from device capabilities', () => {
  assert.deepEqual(computeArchsForProfile(sparkProfile), ['sm_121']);
  assert.deepEqual(computeArchsForProfile({ isAppleSilicon: true, devices: [] }), ['apple-metal']);
  assert.deepEqual(computeArchsForProfile({ devices: [{ computeCapability: '8.9' }, { computeCapability: '8.9' }] }), [
    'sm_89'
  ]);
  assert.deepEqual(computeArchsForProfile({ devices: [] }), []);
});

test('profile-only inventory carries memory domains and direct links', () => {
  const inventory = inventoryFromProfile(sparkProfile);
  assert.deepEqual(inventory.computeArchs, ['sm_121']);
  assert.deepEqual(inventory.memoryDomains, [{ id: 'unified:0', kind: 'unified', capacityGb: 119.7 }]);
  assert.deepEqual(inventory.links, [
    { peerNodeId: 'spark-node-02', localInterface: 'enp1s0f0np0', peerAddress: '10.100.0.2' },
    { peerNodeId: 'spark-node-02', localInterface: 'enp1s0f1np1', peerAddress: '10.100.1.2' }
  ]);
  assert.equal(inventory.complete, false);
});

test('a node inventory reports disk, cached weights, backends and images', async () => {
  const recipes = [
    { id: 'spark-a', requirements: { platforms: ['linux-arm64'], commands: ['docker'] } },
    { id: 'spark-b', requirements: { platforms: ['linux-arm64'] } },
    { id: 'mac-only', requirements: { platforms: ['darwin-arm64'], commands: ['mlx_lm.server'] } }
  ];
  const checked = [];
  const inventory = await collectNodeInventory({
    nodeId: 'spark-node-01',
    profile: sparkProfile,
    recipes,
    modelRoots: ['/models', '/missing'],
    probes: {
      statfs: async (root) =>
        root === '/models' ? { freeGb: 812.4, totalGb: 3725.3 } : Promise.reject(new Error('ENOENT')),
      modelRootStatus: async (recipe, root) => {
        checked.push(`${recipe.id}:${root}`);
        return { complete: recipe.id === 'spark-a' };
      },
      commandExists: async (command) => command === 'docker',
      dockerImages: async () => ['vllm/vllm-openai@sha256:abc', 'lloom/comfy:cuda'],
      now: () => '2026-10-11T00:00:00.000Z'
    }
  });
  assert.equal(inventory.version, 1);
  assert.equal(inventory.nodeId, 'spark-node-01');
  assert.equal(inventory.complete, true);
  assert.equal(inventory.collectedAt, '2026-10-11T00:00:00.000Z');
  assert.deepEqual(inventory.computeArchs, ['sm_121']);
  assert.deepEqual(inventory.disks, [{ root: '/models', freeGb: 812.4, totalGb: 3725.3 }]);
  assert.deepEqual(inventory.weights, [{ recipeId: 'spark-a', root: '/models', complete: true }]);
  assert.deepEqual(checked.sort(), ['spark-a:/models', 'spark-b:/models'], 'only platform-compatible recipes');
  assert.deepEqual(inventory.backends, {
    commands: { docker: true },
    dockerImages: ['lloom/comfy:cuda', 'vllm/vllm-openai@sha256:abc']
  });
  assert.equal(inventory.links.length, 2);
});

test('failing probes degrade to partial inventory instead of throwing', async () => {
  const inventory = await collectNodeInventory({
    nodeId: 'mac',
    profile: { platformId: 'darwin-arm64', isAppleSilicon: true, totalMemoryGb: 64 },
    recipes: [{ id: 'mac', requirements: { platforms: ['darwin-arm64'] } }],
    modelRoots: ['/models'],
    probes: {
      statfs: async () => ({ freeGb: 10, totalGb: 100 }),
      modelRootStatus: async () => {
        throw new Error('permission denied');
      },
      commandExists: async () => false,
      dockerImages: async () => {
        throw new Error('should not run without docker');
      }
    }
  });
  assert.deepEqual(inventory.computeArchs, ['apple-metal']);
  assert.deepEqual(inventory.weights, []);
  assert.deepEqual(inventory.backends, { commands: {}, dockerImages: [] });
  assert.deepEqual(inventory.errors, ['weights mac: permission denied']);
});

test('the inventory cache reuses results within its TTL and shares in-flight work', async () => {
  let now = 0;
  let calls = 0;
  const cache = createNodeInventoryCache({
    ttlMs: 1000,
    now: () => now,
    collect: async () => ({ call: ++calls })
  });
  const [first, second] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(first.call, 1);
  assert.equal(second.call, 1);
  now = 999;
  assert.equal((await cache.get()).call, 1);
  now = 1000;
  assert.equal((await cache.get()).call, 2);
});

test('gateway node status includes inventory only when asked', async () => {
  const requested = [];
  const coordinator = new ClusterCoordinator(
    {
      cluster: {
        nodeId: 'head',
        nodes: { head: {}, peer: { endpoint: 'http://peer:8100' } }
      }
    },
    {
      env: {},
      profile: () => sparkProfile,
      inventory: async () => ({ version: 1, nodeId: 'head' }),
      fetchImpl: async (url) => {
        requested.push(String(url));
        return new Response(JSON.stringify({ ok: true, node: { id: 'peer', inventory: { version: 1 } } }), {
          headers: { 'content-type': 'application/json' }
        });
      }
    }
  );
  assert.equal((await coordinator.localNodeStatus()).inventory, undefined);
  assert.deepEqual((await coordinator.localNodeStatus({ includeInventory: true })).inventory, {
    version: 1,
    nodeId: 'head'
  });
  const peer = await coordinator.nodeStatus('peer', { inventory: true });
  assert.deepEqual(peer.inventory, { version: 1 });
  assert.deepEqual(requested, ['http://peer:8100/gateway/node?memoryUsage=1&inventory=1']);
  await coordinator.nodeStatus('peer');
  assert.equal(requested.at(-1), 'http://peer:8100/gateway/node?memoryUsage=1');
  const cluster = await coordinator.status({ inventory: true });
  assert.deepEqual(cluster.nodes.head.inventory, { version: 1, nodeId: 'head' });
  assert.deepEqual(cluster.nodes.peer.inventory, { version: 1 });
});
