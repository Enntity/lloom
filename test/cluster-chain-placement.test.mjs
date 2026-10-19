import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runtimeAuthority, runtimeControlAllowed } from '../src/cluster.mjs';
import { loadConfig } from '../src/config.mjs';
import { deriveUserConfig } from '../src/init.mjs';
import { keepWarmOwnership, ownsDistributedRuntime, reconfigureRuntimeIds } from '../src/runtime-manager.mjs';
import { syncClusterSetupMembers } from '../src/setup.mjs';

// A distributed recipe over a daisy chain: each rank is cabled only to its
// neighbours, so ranks and per-side rails come from cluster.nodes[ID].fabricChain.
const ENV = [
  'NODE_RANK=${nodeRank}',
  'MASTER_ADDR=${leaderAddress}',
  'FABRIC_INTERFACE=${fabricInterface}',
  'FABRIC_LEFT_HCA=${fabricLeftHca}',
  'FABRIC_RIGHT_HCA=${fabricRightHca}',
  'WORLD=${clusterNodeCount}'
];

function member(nodeRole, runtime, order, extra = {}) {
  return {
    nodeRole,
    runtime,
    role: nodeRole === 'leader' ? 'head' : 'worker',
    order,
    ...extra,
    runtimeSettings: {
      adapter: 'docker',
      management: 'managed',
      containerName: 'chain-${nodeId}',
      bootstrap: { adapter: 'docker', image: 'example/engine@sha256:' + 'a'.repeat(64), createArgs: [...ENV] }
    }
  };
}

function chainRecipe({ nodes = 4, rankOrder = 'descending', createArgs } = {}) {
  const members = [
    member('worker', 'chain-worker', 10, rankOrder ? { rankOrder } : {}),
    member('leader', 'chain-head', 20)
  ];
  if (createArgs) for (const entry of members) entry.runtimeSettings.bootstrap.createArgs = createArgs;
  return {
    id: 'test-chain',
    version: 1,
    requirements: { cluster: { nodes, topology: 'chain' } },
    backend: { id: 'docker-test' },
    models: [
      {
        role: 'default',
        model: 'example/model',
        gatewayModel: 'example-chain',
        runtime: 'chain-cluster',
        settings: { port: 8893, memoryGb: 100, placement: { mode: 'distributed', members } }
      }
    ]
  };
}

// Map order and labels deliberately disagree with the chain: d is rank 0 and
// the leader, a is the far end, and e is a fifth node outside the chain.
function chainConfig() {
  const left = 'mlx5_0,mlx5_1';
  const right = 'mlx5_2,mlx5_3';
  return {
    server: { host: '127.0.0.1', port: 8100 },
    models: [],
    backends: {},
    runtimes: {},
    aliases: {},
    cluster: {
      leaderNode: 'd',
      nodes: {
        a: {
          backendHost: '192.0.2.10',
          labels: { role: 'worker' },
          fabricChain: { rank: 3, interface: 'eth3', leftHca: left }
        },
        b: {
          backendHost: '192.0.2.11',
          fabricChain: { rank: 1, interface: 'eth1', leftHca: left, rightHca: right }
        },
        c: {
          backendHost: '192.0.2.12',
          fabricChain: { rank: 2, interface: 'eth2', leftHca: left, rightHca: right }
        },
        d: {
          backendHost: '192.0.2.13',
          fabricInterface: 'pair0',
          fabricHca: 'mlx5_9',
          fabricChain: { rank: 0, interface: 'eth0', address: '198.51.100.1', rightHca: right }
        },
        e: { backendHost: '192.0.2.14', labels: { role: 'worker' } }
      }
    }
  };
}

const derive = (config, recipe = chainRecipe()) =>
  deriveUserConfig(config, recipe, { modelRoot: '/models', additive: true, backendVariables: {} });

function env(runtime) {
  const args = runtime.bootstrap.createArgs;
  return Object.fromEntries(args.map((arg) => arg.split('=')).map(([key, ...value]) => [key, value.join('=')]));
}

test('a chain places ranks from fabricChain and starts from its far end', () => {
  const config = chainConfig();
  const snapshot = structuredClone(config);
  const derived = derive(config);
  assert.deepEqual(config, snapshot, 'planning must not mutate input');
  const members = derived.runtimes['chain-cluster'].placement.members;
  assert.deepEqual(
    [...members].sort((left, right) => left.order - right.order).map((entry) => [entry.node, entry.order]),
    [
      ['a', 10],
      ['c', 11],
      ['b', 12],
      ['d', 20]
    ]
  );
  const expected = {
    a: { NODE_RANK: '3', FABRIC_INTERFACE: 'eth3', FABRIC_LEFT_HCA: 'mlx5_0,mlx5_1', FABRIC_RIGHT_HCA: '' },
    c: {
      NODE_RANK: '2',
      FABRIC_INTERFACE: 'eth2',
      FABRIC_LEFT_HCA: 'mlx5_0,mlx5_1',
      FABRIC_RIGHT_HCA: 'mlx5_2,mlx5_3'
    },
    b: {
      NODE_RANK: '1',
      FABRIC_INTERFACE: 'eth1',
      FABRIC_LEFT_HCA: 'mlx5_0,mlx5_1',
      FABRIC_RIGHT_HCA: 'mlx5_2,mlx5_3'
    },
    d: { NODE_RANK: '0', FABRIC_INTERFACE: 'eth0', FABRIC_LEFT_HCA: '', FABRIC_RIGHT_HCA: 'mlx5_2,mlx5_3' }
  };
  for (const entry of members) {
    const runtime = derived.runtimes[entry.runtime];
    assert.equal(runtime.node, entry.node);
    assert.equal(runtime.containerName, `chain-${entry.node}`);
    assert.equal(runtime.authority.owner, 'd');
    // The rendezvous is rank 0's chain address, not its pair backendHost.
    assert.deepEqual(env(runtime), { ...expected[entry.node], MASTER_ADDR: '198.51.100.1', WORLD: '4' });
  }
  assert.equal(derived.runtimes['chain-worker-a'].healthStrategy, 'container');
  assert.equal(derived.runtimes['chain-head'].healthStrategy, 'http');
  assert(!members.some((entry) => entry.node === 'e'), 'a node without fabricChain is not on the chain');
});

test('rankOrder ascending, or none, keeps rank order', () => {
  for (const rankOrder of ['ascending', null]) {
    const members = derive(chainConfig(), chainRecipe({ rankOrder })).runtimes['chain-cluster'].placement.members;
    assert.deepEqual(
      members.filter((entry) => entry.role === 'worker').map((entry) => [entry.node, entry.order]),
      [
        ['b', 10],
        ['c', 11],
        ['a', 12]
      ]
    );
  }
  assert.throws(() => derive(chainConfig(), chainRecipe({ rankOrder: 'reverse' })), /rankOrder must be/);
});

test('a re-applied chain follows the declared ranks, not the earlier placement', () => {
  const first = derive(chainConfig());
  const moved = { ...structuredClone(first), cluster: chainConfig().cluster };
  moved.cluster.nodes.a.fabricChain.rank = 1;
  moved.cluster.nodes.b.fabricChain.rank = 3;
  delete moved.cluster.nodes.b.fabricChain.rightHca;
  moved.cluster.nodes.a.fabricChain.rightHca = 'mlx5_2,mlx5_3';
  const again = derive(moved);
  assert.equal(env(again.runtimes['chain-worker-a']).NODE_RANK, '1');
  assert.equal(env(again.runtimes['chain-worker-b']).NODE_RANK, '3');
});

test('chain wiring is validated before anything materializes', () => {
  const cases = [
    [(nodes) => delete nodes.c.fabricChain, /fabricChain on exactly 4 nodes; 3 declare one/],
    [
      (nodes) => (nodes.c.fabricChain.rank = 1),
      /cluster\.nodes\[(b|c)\]\.fabricChain\.rank must be a unique integer from 0 to 3/
    ],
    [(nodes) => (nodes.c.fabricChain.rank = 4), /fabricChain\.rank must be a unique integer/],
    [(nodes) => (nodes.c.fabricChain.rank = '2'), /fabricChain\.rank must be a unique integer/],
    [(nodes) => delete nodes.d.fabricChain.address, /cluster\.nodes\[d\]\.fabricChain\.address must be rank 0's IP/],
    [(nodes) => (nodes.d.fabricChain.address = 'leader.local'), /fabricChain\.address/],
    [(nodes) => (nodes.b.fabricChain.interface = 'eth1;true'), /cluster\.nodes\[b\]\.fabricChain\.interface/],
    [
      (nodes) => delete nodes.b.fabricChain.leftHca,
      /cluster\.nodes\[b\]\.fabricChain\.leftHca must list .* cabled to rank 0/
    ],
    [(nodes) => delete nodes.c.fabricChain.rightHca, /cluster\.nodes\[c\]\.fabricChain\.rightHca .* cabled to rank 3/],
    [(nodes) => (nodes.d.fabricChain.leftHca = 'mlx5_0'), /cluster\.nodes\[d\]\.fabricChain\.leftHca must be empty/],
    [(nodes) => (nodes.a.fabricChain.rightHca = 'mlx5_2'), /cluster\.nodes\[a\]\.fabricChain\.rightHca must be empty/],
    [(nodes) => (nodes.b.fabricChain.leftHca = 'mlx5_0:1'), /leftHca must list unique, exact RDMA device names/],
    [(nodes) => (nodes.b.fabricChain.leftHca = 'mlx5_0,mlx5_0'), /leftHca must list unique/],
    [(nodes) => (nodes.b.fabricChain.leftHca = ['mlx5_0']), /leftHca must list unique/]
  ];
  for (const [mutate, message] of cases) {
    const config = chainConfig();
    mutate(config.cluster.nodes);
    assert.throws(() => derive(config), message);
  }
  assert.throws(() => derive(chainConfig(), chainRecipe({ nodes: 3 })), /exactly 3 nodes; 4 declare one/);
});

test('chain and pair fabric templates cannot be mixed', () => {
  assert.throws(
    () => derive(chainConfig(), chainRecipe({ createArgs: ['FABRIC_HCA=${fabricHca}'] })),
    /a chain placement takes \$\{fabricLeftHca\} and \$\{fabricRightHca\}, not \$\{fabricHca\}/
  );
  const pair = chainRecipe();
  delete pair.requirements.cluster.topology;
  pair.requirements.cluster.nodes = 2;
  const config = chainConfig();
  config.cluster.nodes = { d: config.cluster.nodes.d, e: config.cluster.nodes.e };
  assert.throws(() => derive(config, pair), /need requirements\.cluster\.topology "chain"/);
});

// A federation head (b leads its own cluster) can be a middle rank of a chain
// that d, the chain's rank 0, leads: the group records d as its leader, and
// every node's config agrees that only d controls the chain's runtimes.
test('a chain is led by its rank 0 even where another node leads the cluster', async () => {
  const headConfig = chainConfig();
  headConfig.cluster.leaderNode = 'b';
  headConfig.cluster.nodeId = 'b';
  const onHead = derive(headConfig);
  const group = onHead.runtimes['chain-cluster'];
  assert.equal(group.placement.leaderNode, 'd');
  assert.equal(group.authority.owner, 'd');
  for (const entry of group.placement.members) assert.equal(onHead.runtimes[entry.runtime].authority.owner, 'd');
  assert.equal(env(onHead.runtimes['chain-worker-b']).NODE_RANK, '1');
  assert.equal(env(onHead.runtimes['chain-worker-b']).MASTER_ADDR, '198.51.100.1');

  for (const runtimeId of ['chain-cluster', 'chain-worker-b', 'chain-head']) {
    assert.equal(runtimeAuthority(onHead, runtimeId).owner, 'd', runtimeId);
    assert.equal(runtimeControlAllowed(onHead, runtimeId, 'd'), true, runtimeId);
    assert.equal(runtimeControlAllowed(onHead, runtimeId, 'b'), false, runtimeId);
  }
  assert.equal(runtimeAuthority(onHead, 'chain-worker-b').delegated, true);
  assert.equal(ownsDistributedRuntime(onHead, group, { nodeId: 'b', leaderNode: 'b' }), false);
  assert.equal(ownsDistributedRuntime(onHead, group, { nodeId: 'd', leaderNode: 'b' }), true);
  assert.equal(keepWarmOwnership(onHead, 'chain-cluster', { nodeId: 'b', leaderNode: 'b' }).reason, 'leader-owned');
  assert.equal(keepWarmOwnership(onHead, 'chain-cluster', { nodeId: 'd', leaderNode: 'b' }).owned, true);
  const changed = structuredClone(onHead);
  changed.runtimes['chain-worker-b'].bootstrap.createArgs.push('EXTRA=1');
  assert(!reconfigureRuntimeIds(onHead, changed, { nodeId: 'b', leaderNode: 'b' }).includes('chain-cluster'));
  assert(reconfigureRuntimeIds(onHead, changed, { nodeId: 'd', leaderNode: 'b' }).includes('chain-cluster'));

  // The persisted config validates on the head, and a leader outside the cluster does not.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-chain-leader-'));
  try {
    const file = path.join(dir, 'config.json');
    for (const [id, node] of Object.entries(onHead.cluster.nodes)) node.endpoint = `http://${id}.example:8100`;
    await fs.writeFile(file, JSON.stringify(onHead));
    const loaded = await loadConfig(file, { env: {} });
    assert.equal(runtimeAuthority(loaded, 'chain-cluster').owner, 'd');
    const stray = structuredClone(onHead);
    stray.runtimes['chain-cluster'].placement.leaderNode = 'z';
    await fs.writeFile(file, JSON.stringify(stray));
    await assert.rejects(loadConfig(file, { env: {} }), /placement\.leaderNode must name a node in cluster\.nodes/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  // Setup sync: only the chain's leader pushes setup to its members.
  const recipeRuntime = { ...group, recipe: { id: 'test-chain', version: 1 } };
  const synced = [];
  const coordinator = (nodeId) => ({
    nodeId,
    nodes: Object.fromEntries(Object.keys(headConfig.cluster.nodes).map((id) => [id, {}])),
    isLocalNode: (id) => id === nodeId,
    async requestNode(id) {
      synced.push([nodeId, id]);
      return { ok: true, status: 'applied' };
    }
  });
  const syncConfig = { cluster: headConfig.cluster, runtimes: { 'chain-cluster': recipeRuntime } };
  assert.deepEqual(await syncClusterSetupMembers(syncConfig, { coordinator: coordinator('b'), recipeId: 'test-chain' }), {
    synced: [],
    skipped: true
  });
  const fromLeader = await syncClusterSetupMembers(syncConfig, { coordinator: coordinator('d'), recipeId: 'test-chain' });
  assert.equal(fromLeader.skipped, false);
  assert.deepEqual(synced.map(([from, to]) => `${from}>${to}`).sort(), ['d>a', 'd>b', 'd>c']);
});

test('a pair placement keeps the cluster leader and records no group leader', () => {
  const config = chainConfig();
  config.cluster.nodes = {
    d: config.cluster.nodes.d,
    e: { ...config.cluster.nodes.e, fabricInterface: 'pair0', fabricHca: 'mlx5_9' }
  };
  const pair = chainRecipe({ createArgs: ['FABRIC_HCA=${fabricHca}'] });
  delete pair.requirements.cluster.topology;
  pair.requirements.cluster.nodes = 2;
  const derived = derive(config, pair);
  assert.equal(derived.runtimes['chain-cluster'].placement.leaderNode, undefined);
  assert.equal(derived.runtimes['chain-cluster'].authority.owner, 'd');
});
