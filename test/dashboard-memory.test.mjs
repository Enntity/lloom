import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMemoryMap } from '../src/dashboard-memory.mjs';

const GiB = 1024 ** 3;
const policy = { mode: 'enforce', minAvailableMemoryGb: 12, maxMemoryUtilization: 0.9 };

function node({ total = 96 * GiB, available = 68 * GiB, reachable = true } = {}) {
  return {
    id: 'node-a',
    local: true,
    reachable,
    telemetry: {
      memory: {
        totalBytes: total,
        availableBytes: available,
        usedBytes: total - available
      }
    }
  };
}

function map(overrides = {}) {
  const { nodeOverrides, ...rest } = overrides;
  return buildMemoryMap({
    node: node(nodeOverrides),
    runtimes: {},
    models: [],
    memorySafety: policy,
    ...rest
  });
}

test('builds an exact 96 GiB local map with reserve and forecast', () => {
  const result = map({
    runtimes: {
      main: {
        id: 'main',
        status: 'running',
        healthy: true,
        memoryUsage: {
          residentBytes: 20 * GiB,
          groupId: 'proc:1',
          sharedRuntimeIds: ['main'],
          loadedModelIds: ['upstream-a'],
          residencyKnown: true
        }
      }
    },
    models: [
      { id: 'model-a', name: 'Model A', runtime: 'main', upstreamModel: 'upstream-a', targets: [{ node: 'node-a' }] }
    ],
    previewModelId: 'model-a'
  });

  assert.equal(result.known, true);
  assert.equal(result.totalBytes, 96 * GiB);
  assert.equal(result.usedBytes, 28 * GiB);
  assert.equal(result.availableBytes, 68 * GiB);
  assert.equal(result.reserveBytes, 12 * GiB);
  assert.equal(result.usableBytes, 56 * GiB);
  assert.equal(
    result.segments.reduce((sum, segment) => sum + segment.bytes, 0),
    96 * GiB
  );
  assert.deepEqual(
    result.segments.map((segment) => segment.kind),
    ['runtime', 'system', 'available']
  );
  assert.equal(result.preview.status, 'resident');
  assert.equal(result.preview.additionalBytes, 0);
  assert.equal(result.preview.remainingBytes, 68 * GiB);
});

test('40 GiB incoming leaves 28 GiB above a 12 GiB reserve', () => {
  const runtimes = {
    incoming: { id: 'incoming', status: 'stopped', memoryGb: 40 }
  };
  const result = map({
    runtimes,
    models: [{ id: 'incoming-model', runtime: 'incoming' }],
    previewModelId: 'incoming-model'
  });
  assert.equal(result.preview.status, 'fits');
  assert.equal(result.preview.additionalBytes, 40 * GiB);
  assert.equal(result.preview.remainingBytes, 28 * GiB);
  assert.equal(result.preview.projectedUsedBytes, 68 * GiB);
  assert.equal(result.preview.percent, 41.666667);
  assert.equal(result.preview.message, 'Expected to fit');
});

test('invalid telemetry does not invent segments or fits', () => {
  for (const memory of [
    { totalBytes: null, availableBytes: 1, usedBytes: 1 },
    { totalBytes: -1, availableBytes: 1, usedBytes: 1 },
    { totalBytes: 10, availableBytes: 11, usedBytes: 1 },
    { totalBytes: 10, availableBytes: -1, usedBytes: 1 },
    { totalBytes: 10, availableBytes: null, usedBytes: 11 }
  ]) {
    const result = buildMemoryMap({
      node: { id: 'node-a', local: true, reachable: true, telemetry: { memory } },
      memorySafety: policy
    });
    assert.equal(result.known, false);
    assert.deepEqual(result.segments, []);
    assert.equal(result.preview, null);
  }
  const unreachable = map({ nodeOverrides: { reachable: false } });
  assert.equal(unreachable.known, false);
});

test('RSS is preferred over a configured peak and oversubscription is bounded', () => {
  const result = map({
    runtimes: {
      a: {
        id: 'a',
        status: 'running',
        memoryGb: 40,
        memoryUsage: { residentBytes: 5 * GiB, groupId: 'proc:1', sharedRuntimeIds: ['a'] }
      },
      b: {
        id: 'b',
        status: 'running',
        memoryUsage: { residentBytes: 6 * GiB, groupId: 'proc:2', sharedRuntimeIds: ['b'] }
      }
    }
  });
  assert.equal(result.segments.find((segment) => segment.runtimeId === 'a').bytes, 5 * GiB);
  assert.equal(
    result.segments.reduce((sum, segment) => sum + segment.bytes, 0),
    96 * GiB
  );
});

test('oversubscribed estimates are scaled within measured used space', () => {
  const result = map({
    nodeOverrides: { total: 10 * GiB, available: 9 * GiB },
    runtimes: {
      a: { id: 'a', status: 'starting', memoryGb: 6 },
      b: { id: 'b', status: 'starting', memoryGb: 6 }
    }
  });
  const runtimeBytes = result.segments
    .filter((segment) => segment.kind === 'runtime')
    .reduce((sum, segment) => sum + segment.bytes, 0);
  assert.ok(runtimeBytes <= result.usedBytes);
  assert.equal(
    result.segments.reduce((sum, segment) => sum + segment.bytes, 0),
    result.totalBytes
  );
  assert.ok(result.segments.filter((segment) => segment.kind === 'runtime').every((segment) => segment.estimated));
});

test('shared runtime groups and confirmed empty lazy lists are honest', () => {
  const result = map({
    runtimes: {
      'shared-a': {
        id: 'shared-a',
        status: 'running',
        command: 'ollama',
        memoryGb: 8,
        memoryUsage: {
          residentBytes: 8 * GiB,
          groupId: 'proc:9',
          sharedRuntimeIds: ['shared-a', 'shared-b'],
          loadedModelIds: [],
          residencyKnown: true
        }
      },
      'shared-b': {
        id: 'shared-b',
        status: 'running',
        command: 'ollama',
        memoryGb: 8,
        memoryUsage: {
          residentBytes: 8 * GiB,
          groupId: 'proc:9',
          sharedRuntimeIds: ['shared-a', 'shared-b'],
          loadedModelIds: [],
          residencyKnown: true
        }
      }
    },
    models: [
      { id: 'shared-model', runtime: 'shared-a', upstreamModel: 'shared-upstream', targets: [{ node: 'node-a' }] }
    ],
    previewModelId: 'shared-model'
  });
  const runtimeSegments = result.segments.filter((segment) => segment.kind === 'runtime');
  assert.equal(runtimeSegments.length, 1);
  assert.equal(runtimeSegments[0].bytes, 8 * GiB);
  assert.equal(result.preview.status, 'fits');
  assert.equal(result.preview.additionalBytes, 8 * GiB);
});

test('missing cold estimate is unknown rather than zero or fits', () => {
  const result = map({
    runtimes: { cold: { id: 'cold', status: 'stopped' } },
    models: [{ id: 'cold-model', runtime: 'cold', targets: [{ node: 'node-a' }] }],
    previewModelId: 'cold-model'
  });
  assert.equal(result.preview.status, 'unknown');
  assert.equal(result.preview.additionalBytes, null);
  assert.equal(result.preview.percent, null);
});

test('remote runtimes are excluded and previews remain node-local', () => {
  const result = map({
    runtimes: {
      remote: {
        id: 'remote',
        remote: true,
        node: 'node-b',
        status: 'running',
        memoryUsage: { residentBytes: 20 * GiB, groupId: 'proc:remote', sharedRuntimeIds: ['remote'] }
      }
    },
    models: [{ id: 'remote-model', runtime: 'remote', targets: [{ node: 'node-b' }] }],
    previewModelId: 'remote-model'
  });
  assert.deepEqual(
    result.segments.filter((segment) => segment.kind === 'runtime'),
    []
  );
  assert.equal(result.preview.status, 'other-node');
  assert.equal(result.preview.nodeId, 'node-b');
  assert.equal(result.preview.additionalBytes, 0);
});

test('distributed wrappers and remote resources do not double count', () => {
  const result = map({
    runtimes: {
      member: {
        id: 'member',
        status: 'running',
        memoryUsage: { residentBytes: 4 * GiB, groupId: 'proc:member', sharedRuntimeIds: ['member'] }
      },
      distributed: { id: 'distributed', distributed: true, members: [{ runtime: 'member' }], status: 'running' }
    }
  });
  assert.deepEqual(
    result.segments.filter((segment) => segment.kind === 'runtime').map((segment) => segment.runtimeId),
    ['member']
  );
});

test('remote reserve is not pooled into the local reserve', () => {
  const result = map({
    runtimes: { remote: { id: 'remote', remote: true, node: 'node-b', runtimeManager: { memorySafety: policy } } }
  });
  assert.equal(result.reserveBytes, 12 * GiB);
});

test('runtime colors are stable and order independent', () => {
  const first = map({ runtimes: { a: { id: 'a', status: 'running' }, b: { id: 'b', status: 'running' } } });
  const second = map({ runtimes: { b: { id: 'b', status: 'running' }, a: { id: 'a', status: 'running' } } });
  const colors = (result) =>
    Object.fromEntries(
      result.segments
        .filter((segment) => segment.kind === 'runtime')
        .map((segment) => [segment.runtimeId, segment.colorIndex])
    );
  assert.deepEqual(colors(first), colors(second));
  assert.ok(Object.values(colors(first)).every((value) => value >= 0 && value <= 7));
});

test('the pure builder is serializable into a browser function', () => {
  const source = buildMemoryMap.toString();
  const browserFunction = new Function(`return (${source})`)();
  const result = browserFunction({
    node: {
      id: 'node-a',
      local: true,
      reachable: true,
      telemetry: { memory: { totalBytes: 10, availableBytes: 7, usedBytes: 3 } }
    }
  });
  assert.equal(result.known, true);
  assert.equal(result.usedBytes, 3);
});

test('a peer uses its own observed runtime and reserve, never pooled capacity', () => {
  const result = map({
    node: {
      id: 'peer',
      local: false,
      reachable: true,
      telemetry: { memory: { totalBytes: 128 * GiB, availableBytes: 32 * GiB } },
      runtimeManager: {
        memorySafety: { ...policy, minAvailableMemoryGb: 20 },
        runtimes: {
          remote: {
            status: 'running',
            healthy: true,
            memoryUsage: { residentBytes: 16 * GiB, residencyKnown: true, loadedModelIds: ['resident'] }
          }
        }
      }
    },
    runtimes: { remote: { remote: true, node: 'peer', memoryGb: 16 } },
    models: [{ id: 'resident', name: 'Resident on peer', runtime: 'remote' }],
    previewModelId: 'resident'
  });
  assert.equal(result.preview.status, 'resident');
  assert.equal(result.reserveBytes, 20 * GiB);
  assert.equal(result.segments.find((s) => s.kind === 'runtime').bytes, 16 * GiB);
  assert.equal(
    result.segments.reduce((sum, s) => sum + s.percent, 0),
    100
  );
});

test('maintenance and missing runtime state cannot promise a free model', () => {
  const base = { models: [{ id: 'paused', runtime: 'model' }], previewModelId: 'paused' };
  assert.equal(
    map({
      ...base,
      runtimes: { model: { healthy: true, status: 'running', maintenance: { state: 'suspended' }, memoryGb: 32 } }
    }).preview.status,
    'paused'
  );
  assert.equal(map(base).preview.status, 'unknown');
});

test('a healthy but empty cache still requires incoming memory', () => {
  const result = map({
    runtimes: {
      a: {
        command: 'ollama',
        status: 'running',
        healthy: true,
        memoryGb: 8,
        memoryUsage: { residentBytes: GiB, residencyKnown: true, loadedModelIds: [] }
      }
    },
    models: [{ id: 'cold', runtime: 'a' }],
    previewModelId: 'cold'
  });
  assert.equal(result.preview.status, 'fits');
  assert.equal(result.preview.additionalBytes, 8 * GiB);
});

test('a healthy single-model service may still need to allocate its weights', () => {
  const result = map({
    runtimes: {
      a: {
        status: 'running',
        healthy: true,
        memoryGb: 32,
        memoryUsage: { residentBytes: GiB / 8, residencyKnown: false }
      }
    },
    models: [{ id: 'image', runtime: 'a' }],
    previewModelId: 'image'
  });
  assert.equal(result.preview.status, 'fits');
  assert.equal(result.preview.additionalBytes, 31.875 * GiB);
});
