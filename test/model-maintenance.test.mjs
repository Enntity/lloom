import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runtimeMaintenance,
  maintenanceBlocksRouting,
  maintenanceBlocksStart,
  planModelMaintenance
} from '../src/model-maintenance.mjs';

// Standalone base config: rt-a is NOT contained by any group by default.
function baseConfig(overrides = {}) {
  return {
    models: [
      { id: 'alpha', runtime: 'rt-a' },
      { id: 'beta', runtime: 'rt-b' },
      { id: 'gamma', runtime: 'rt-g' },
      { id: 'cloud', provider: 'external' }
    ],
    runtimes: {
      'rt-a': { enabled: true },
      'rt-b': { enabled: true },
      'rt-g': { enabled: true }
    },
    aliases: {
      local: { members: ['alpha'] },
      mixed: { members: ['alpha', 'cloud'] },
      nested: { members: ['local', 'beta'] }
    },
    ...overrides
  };
}

function groupedConfig(overrides = {}) {
  const config = baseConfig();
  config.runtimes['group-1'] = {
    enabled: true,
    placement: { members: [{ runtime: 'rt-a', node: 'n1', role: 'leader' }] }
  };
  Object.assign(config, overrides);
  return config;
}

test('runtimeMaintenance returns own record for valid states', () => {
  const config = baseConfig();
  config.runtimes['rt-a'].maintenance = { state: 'suspended', requestedModel: 'alpha', since: 1 };
  const record = runtimeMaintenance(config, 'rt-a');
  assert.equal(record.state, 'suspended');
  assert.equal(record.requestedModel, 'alpha');
});

test('runtimeMaintenance ignores invalid state and unknown runtime', () => {
  const config = baseConfig();
  config.runtimes['rt-a'].maintenance = { state: 'bogus' };
  assert.equal(runtimeMaintenance(config, 'rt-a'), null);
  assert.equal(runtimeMaintenance(config, 'missing'), null);
  assert.equal(runtimeMaintenance(null, 'rt-a'), null);
});

test('runtimeMaintenance finds containing group maintenance for a member', () => {
  const config = groupedConfig();
  config.runtimes['group-1'].maintenance = { state: 'resuming', requestedModel: 'alpha', since: 2 };
  const record = runtimeMaintenance(config, 'rt-a');
  assert.equal(record.state, 'resuming');
});

test('runtimeMaintenance prefers suspended over resuming when multiple records apply', () => {
  const config = groupedConfig();
  config.runtimes['rt-a'].maintenance = { state: 'resuming', requestedModel: 'alpha', since: 2 };
  config.runtimes['group-1'].maintenance = { state: 'suspended', requestedModel: 'alpha', since: 3 };
  const record = runtimeMaintenance(config, 'rt-a');
  assert.equal(record.state, 'suspended');
});

test('runtimeMaintenance returns own resuming while containing group is suspended', () => {
  const config = groupedConfig();
  config.runtimes['rt-a'].maintenance = { state: 'resuming', requestedModel: 'alpha', since: 2 };
  config.runtimes['group-1'].maintenance = { state: 'suspended', requestedModel: 'alpha', since: 3 };
  const record = runtimeMaintenance(config, 'rt-a');
  assert.equal(record.state, 'suspended');
  assert.equal(record.since, 3);
});

test('maintenanceBlocksRouting and maintenanceBlocksStart derive from state', () => {
  const config = baseConfig();
  assert.equal(maintenanceBlocksRouting(config, 'rt-a'), false);
  config.runtimes['rt-a'].maintenance = { state: 'resuming', requestedModel: 'alpha', since: 1 };
  assert.equal(maintenanceBlocksRouting(config, 'rt-a'), true);
  assert.equal(maintenanceBlocksStart(config, 'rt-a'), false);
  config.runtimes['rt-a'].maintenance = { state: 'suspended', requestedModel: 'alpha', since: 1 };
  assert.equal(maintenanceBlocksStart(config, 'rt-a'), true);
});

test('planModelMaintenance handles exact managed model id (standalone runtime)', () => {
  const plan = planModelMaintenance(baseConfig(), 'alpha', 'suspend');
  assert.equal(plan.requestedModel, 'alpha');
  assert.equal(plan.action, 'suspend');
  assert.deepEqual(plan.runtimeIds, ['rt-a']);
});

test('planModelMaintenance selects exact runtime id even without a model mapping', () => {
  const config = baseConfig();
  config.runtimes['rt-orphan'] = { enabled: true };
  const plan = planModelMaintenance(config, 'rt-orphan', 'suspend');
  assert.equal(plan.requestedModel, 'rt-orphan');
  assert.deepEqual(plan.runtimeIds, ['rt-orphan']);
});

test('planModelMaintenance resolves real local+cloud alias ignoring cloud leaf', () => {
  const plan = planModelMaintenance(baseConfig(), 'mixed', 'suspend');
  assert.equal(plan.requestedModel, 'mixed');
  assert.deepEqual(plan.runtimeIds, ['rt-a']);
});

test('planModelMaintenance resolves string alias member through nested alias', () => {
  const config = baseConfig();
  config.aliases['stringlink'] = 'local';
  config.aliases['wraps'] = { members: ['stringlink'] };
  const plan = planModelMaintenance(config, 'stringlink', 'suspend');
  assert.deepEqual(plan.runtimeIds, ['rt-a']);
});

test('planModelMaintenance includes string alias when reporting affected aliases', () => {
  const config = baseConfig();
  config.aliases['stringlink'] = 'alpha';
  config.aliases['wraps'] = { members: ['stringlink'] };
  const plan = planModelMaintenance(config, 'alpha', 'suspend');
  assert.ok(plan.affectedAliases.includes('stringlink'));
  assert.ok(plan.affectedAliases.includes('wraps'));
});

test('planModelMaintenance resolves nested alias leaves', () => {
  const config = baseConfig();
  config.models.push({ id: 'delta', runtime: 'rt-b' });
  config.aliases['nested2'] = { members: ['nested', 'delta'] };
  assert.throws(() => planModelMaintenance(config, 'nested2', 'suspend'), /multiple managed models/);
});

test('planModelMaintenance preserves manual suspension flags', () => {
  const config = baseConfig();
  config.aliases['local'].suspendedMembers = ['alpha'];
  const plan = planModelMaintenance(config, 'local', 'suspend');
  assert.deepEqual(plan.runtimeIds, ['rt-a']);
});

test('planModelMaintenance handles target-array model shape', () => {
  const config = baseConfig();
  config.models = [{ id: 'alpha', targets: [{ runtime: 'rt-a' }] }];
  const plan = planModelMaintenance(config, 'alpha', 'resume');
  assert.deepEqual(plan.runtimeIds, ['rt-a']);
});

test('planModelMaintenance targets override model.runtime', () => {
  const config = baseConfig();
  config.models = [{ id: 'alpha', runtime: 'rt-missing', targets: [{ runtime: 'rt-a' }] }];
  const plan = planModelMaintenance(config, 'alpha', 'resume');
  assert.deepEqual(plan.runtimeIds, ['rt-a']);
});

test('planModelMaintenance rejects named missing runtime target', () => {
  const config = baseConfig();
  config.models[0] = { id: 'alpha', runtime: 'rt-missing' };
  assert.throws(() => planModelMaintenance(config, 'alpha', 'suspend'), /not configured/);
});

test('planModelMaintenance rejects unmanaged runtime', () => {
  const config = baseConfig();
  config.runtimes['rt-a'].management = 'unmanaged';
  assert.throws(() => planModelMaintenance(config, 'alpha', 'suspend'), /unmanaged/);
});

test('planModelMaintenance rejects disabled runtime', () => {
  const config = baseConfig();
  config.runtimes['rt-a'].enabled = false;
  assert.throws(() => planModelMaintenance(config, 'alpha', 'suspend'), /not enabled/);
});

test('planModelMaintenance normalizes owner member to containing group', () => {
  const config = groupedConfig();
  const plan = planModelMaintenance(config, 'rt-a', 'suspend');
  assert.deepEqual(plan.runtimeIds, ['group-1']);
});

test('planModelMaintenance normalizes model-owned member through its group', () => {
  const config = groupedConfig();
  const plan = planModelMaintenance(config, 'alpha', 'suspend');
  assert.deepEqual(plan.runtimeIds, ['group-1']);
});

test('planModelMaintenance rejects model targeting disabled owner group with enabled child', () => {
  const config = groupedConfig();
  config.runtimes['group-1'].enabled = false;
  assert.throws(() => planModelMaintenance(config, 'alpha', 'suspend'), /not enabled/);
});

test('planModelMaintenance refuses ambiguous alias with multiple managed models', () => {
  const config = baseConfig();
  config.aliases['ambiguous'] = { members: ['alpha', 'beta'] };
  assert.throws(() => planModelMaintenance(config, 'ambiguous', 'suspend'), /multiple managed models/);
});

test('planModelMaintenance refuses multiply contained runtime', () => {
  const config = groupedConfig();
  config.runtimes['group-2'] = {
    enabled: true,
    placement: { members: [{ runtime: 'rt-a', node: 'n2', role: 'follower' }] }
  };
  assert.throws(() => planModelMaintenance(config, 'rt-a', 'suspend'), /contained by multiple groups/);
});

test('planModelMaintenance refuses nested group containment', () => {
  const config = groupedConfig();
  config.runtimes['group-2'] = {
    enabled: true,
    placement: { members: [{ runtime: 'group-1', node: 'n2', role: 'follower' }] }
  };
  assert.throws(() => planModelMaintenance(config, 'rt-a', 'suspend'), /containment cycle|multiple groups/);
});

test('planModelMaintenance rejects group self-cycle', () => {
  const config = groupedConfig();
  config.runtimes['group-1'].placement.members.push({ runtime: 'group-1', node: 'n1', role: 'follower' });
  assert.throws(() => planModelMaintenance(config, 'rt-a', 'suspend'), /containment cycle|multiple groups|self/);
});

test('planModelMaintenance enumerates siblings sharing a runtime including disabled ones', () => {
  const config = baseConfig();
  config.models.push({ id: 'delta', runtime: 'rt-a', enabled: false });
  const plan = planModelMaintenance(config, 'alpha', 'suspend');
  assert.ok(plan.affectedModelIds.includes('delta'));
});

test('planModelMaintenance keeps shared-model impact when sibling runtime is disabled', () => {
  const config = groupedConfig();
  config.models.push({ id: 'delta', runtime: 'rt-a', enabled: false });
  const plan = planModelMaintenance(config, 'alpha', 'suspend');
  assert.ok(plan.affectedModelIds.includes('delta'));
});

test('planModelMaintenance reports state snapshot without backend keys', () => {
  const config = baseConfig();
  config.runtimes['rt-a'].maintenance = {
    state: 'suspended',
    requestedModel: 'alpha',
    since: 5,
    operationId: 'op-1',
    backend: 'secret',
    env: { A: '1' },
    extra: 'nope'
  };
  const plan = planModelMaintenance(config, 'alpha', 'suspend');
  assert.deepEqual(plan.state, {
    'rt-a': { state: 'suspended', requestedModel: 'alpha', since: 5, operationId: 'op-1' }
  });
  assert.equal(Object.hasOwn(plan, 'commands'), false);
  assert.equal(Object.hasOwn(plan, 'env'), false);
});

test('planModelMaintenance rejects unknown action and unknown id', () => {
  assert.throws(() => planModelMaintenance(baseConfig(), 'alpha', 'restart'), /unsupported/);
  assert.throws(() => planModelMaintenance(baseConfig(), 'nope', 'suspend'), /unknown/);
});

test('planModelMaintenance surfaces alias cycles', () => {
  const config = baseConfig();
  config.aliases['cycle-a'] = { members: ['cycle-b'] };
  config.aliases['cycle-b'] = { members: ['cycle-a'] };
  assert.throws(() => planModelMaintenance(config, 'cycle-a', 'suspend'), /alias cycle/);
});

test('planModelMaintenance does not mutate the input config', () => {
  const config = baseConfig();
  config.runtimes['rt-a'].maintenance = { state: 'suspended', requestedModel: 'alpha', since: 1 };
  const before = JSON.stringify(config);
  planModelMaintenance(config, 'alpha', 'resume');
  assert.equal(JSON.stringify(config), before);
});

test('runtimeMaintenance prefers suspended when own is resuming and group suspended', () => {
  const config = groupedConfig();
  config.runtimes['rt-a'].maintenance = { state: 'resuming', requestedModel: 'alpha', since: 2 };
  config.runtimes['group-1'].maintenance = { state: 'suspended', requestedModel: 'alpha', since: 4 };
  const record = runtimeMaintenance(config, 'rt-a');
  assert.equal(record.state, 'suspended');
  assert.equal(record.since, 4);
});

test('planModelMaintenance handles alias name missing runtime as not cloud when mixed', () => {
  const config = baseConfig();
  config.models.push({ id: 'ghost', runtime: 'rt-missing' });
  config.aliases['mixedmissing'] = { members: ['ghost', 'cloud'] };
  assert.throws(() => planModelMaintenance(config, 'mixedmissing', 'suspend'), /not configured/);
});
