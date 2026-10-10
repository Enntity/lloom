import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ClusterDeploymentCoordinator,
  DeploymentJournal,
  DeploymentPlanError,
  JournalLockError,
  StaleGenerationError,
  normalizeDeploymentPlan
} from '../src/cluster-deployment.mjs';

const OLD = '1'.repeat(64);
const OLD_MANIFEST = '2'.repeat(64);
const NEXT = '3'.repeat(64);
const NEXT_MANIFEST = '4'.repeat(64);
const CONFIG = '5'.repeat(64);
const DEPENDENCY = '6'.repeat(64);
const CONTRACT = '7'.repeat(64);
const SNAPSHOT = '8'.repeat(64);

function plan(overrides = {}) {
  return {
    scope: { platform: 'linux', serviceManager: 'systemd', mode: 'gateway' },
    gatewayProtocol: 1,
    reviewedArtifact: {
      id: 'release-next',
      sha256: NEXT,
      manifestSha256: NEXT_MANIFEST,
      reviewed: true
    },
    targetNodes: [
      { id: 'worker-1', role: 'worker', order: 10 },
      { id: 'leader', role: 'leader', order: 20 }
    ],
    expectedOldIdentity: { releaseId: 'release-old', artifactSha256: OLD, manifestSha256: OLD_MANIFEST },
    canary: { gatewayModelId: 'atlas/local', runtimeId: 'atlas-runtime' },
    ...overrides
  };
}

function identity(next = true, overrides = {}) {
  return next
    ? {
        releaseId: 'release-next',
        artifactSha256: NEXT,
        manifestSha256: NEXT_MANIFEST,
        configSha256: CONFIG,
        dependencyDigest: DEPENDENCY,
        runtimeContractDigest: CONTRACT,
        ...overrides
      }
    : {
        releaseId: 'release-old',
        artifactSha256: OLD,
        manifestSha256: OLD_MANIFEST,
        configSha256: CONFIG,
        dependencyDigest: DEPENDENCY,
        runtimeContractDigest: CONTRACT,
        ...overrides
      };
}

function receipt(phase, nodeId, context, extra = {}) {
  return {
    operationId: context.operationId,
    generation: context.generation,
    nodeId,
    phase,
    status: 'ok',
    observedAt: '2026-10-10T17:00:00.000Z',
    ...extra
  };
}

function makeTransport(options = {}) {
  const calls = [];
  const state = { old: new Set(['worker-1', 'leader']) };
  const fault = options.fault ?? null;
  const adapter = {
    calls,
    async call(phase, nodeId, context, body = {}) {
      calls.push({ phase, nodeId, context });
      const key = `${phase}:${nodeId}`;
      if (fault?.at === key || fault?.at === phase || fault?.at === `before:${key}`) {
        const error = new Error('Authorization: Bearer secret should never be persisted');
        error.code = fault.code ?? 'injected_failure';
        throw error;
      }
      if (fault?.after === key) {
        state.old.delete(nodeId);
        throw Object.assign(new Error('connection dropped after mutation'), { code: 'disconnect' });
      }
      return receipt(phase, nodeId, context, body);
    },
    async preflight(nodeId, context) {
      return this.call('preflight', nodeId, context, {
        platform: 'linux',
        serviceManager: 'systemd',
        gatewayProtocol: options.gatewayProtocol ?? 1,
        fenceProtocolVersion: options.fenceProtocolVersion ?? 1,
        atomicLayout: options.atomicLayout ?? 'atomic',
        currentIdentity: options.drift ? identity(false, { releaseId: 'drifted' }) : identity(false)
      });
    },
    async stage(nodeId, context) {
      return this.call('stage', nodeId, context, {
        staged: true,
        artifactSha256: options.stageMismatch ? OLD : NEXT,
        manifestSha256: NEXT_MANIFEST
      });
    },
    async prepare(nodeId, context) {
      return this.call('prepare', nodeId, context, {
        fenced: true,
        drained: true,
        backup: { id: `backup-${nodeId}`, sha256: SNAPSHOT },
        snapshot: { id: `snapshot-${nodeId}`, sha256: SNAPSHOT }
      });
    },
    async swap(nodeId, context) {
      state.old.delete(nodeId);
      return this.call('swap', nodeId, context, {
        applied: true,
        identity: identity(true),
        snapshot: { id: `snapshot-${nodeId}`, sha256: SNAPSHOT }
      });
    },
    async restart(nodeId, context) {
      return this.call('restart', nodeId, context, {
        serviceRestarted: true,
        healthy: true,
        identity: identity(true, options.identityDrift ? { configSha256: '9'.repeat(64) } : {}),
        snapshot: { id: `snapshot-${nodeId}`, sha256: SNAPSHOT }
      });
    },
    async verify(nodeId, context) {
      return this.call('verify', nodeId, context, {
        verified: true,
        identity: identity(true),
        snapshot: { id: `snapshot-${nodeId}`, sha256: SNAPSHOT }
      });
    },
    async canary(nodeId, context) {
      return this.call('canary', nodeId, context, {
        healthy: !options.badCanary,
        gatewayModelId: options.badCanary ? 'wrong-model' : 'atlas/local',
        runtimeId: 'atlas-runtime',
        fenced: true,
        privileged: true,
        aliasUsed: false,
        cloudFallback: false,
        source: 'local'
      });
    },
    async promote(nodeId, context) {
      return this.call('promote', nodeId, context, {
        promoted: true,
        identity: identity(true),
        snapshot: { id: `snapshot-${nodeId}`, sha256: SNAPSHOT }
      });
    },
    async release(nodeId, context) {
      return this.call('release', nodeId, context, { released: true, fenced: false });
    },
    async reprepare(nodeId, context) {
      return this.call('reprepare', nodeId, context, { fenced: true, drained: true });
    },
    async rollback(nodeId, context) {
      state.old.add(nodeId);
      return this.call('rollback', nodeId, context, {
        restored: true,
        fenced: true,
        identity: identity(false)
      });
    },
    async discardStage(nodeId, context) {
      return this.call('discard-stage', nodeId, context, { stageDiscarded: true });
    }
  };
  if (options.badSwapIdentity) {
    const original = adapter.swap;
    adapter.swap = async (nodeId, context) => {
      const value = await original.call(adapter, nodeId, context);
      return { ...value, identity: { ...identity(true), artifactSha256: OLD } };
    };
  }
  if (options.rollbackFailure) {
    const original = adapter.rollback;
    adapter.rollback = async (nodeId, context) => {
      if (nodeId === options.rollbackFailure) {
        calls.push({ phase: 'rollback', nodeId, context });
        throw Object.assign(new Error('rollback transport lost'), { code: 'rollback_disconnect' });
      }
      return original.call(adapter, nodeId, context);
    };
  }
  return adapter;
}

async function tempJournal(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-coordinator-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return new DeploymentJournal(path.join(directory, 'deployment.json'));
}

function coordinator(journal, transport) {
  return new ClusterDeploymentCoordinator({
    journal,
    transport,
    operationIdFactory: () => 'op-test',
    clock: () => new Date('2026-10-10T17:00:00.000Z')
  });
}

async function rejected(promise, type = null) {
  try {
    await promise;
    assert.fail('operation unexpectedly succeeded');
  } catch (error) {
    if (type) assert(error instanceof type, `expected ${type.name}, got ${error?.constructor?.name}`);
    return error;
  }
}

test('runs workers before leader and persists a complete public-safe journal', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport();
  const result = await coordinator(journal, transport).deploy(plan());
  assert.equal(result.operationState, 'completed');
  assert.deepEqual(
    Object.values(result.nodes).map((node) => node.state),
    ['released', 'released']
  );
  const mutating = transport.calls
    .filter(({ phase }) => ['swap', 'restart', 'promote', 'release'].includes(phase))
    .map(({ phase, nodeId }) => `${phase}:${nodeId}`);
  assert.deepEqual(mutating, [
    'swap:worker-1',
    'restart:worker-1',
    'swap:leader',
    'restart:leader',
    'promote:worker-1',
    'promote:leader',
    'release:worker-1',
    'release:leader'
  ]);
  const onDisk = JSON.stringify(await journal.load());
  assert.doesNotMatch(onDisk, /Bearer|secret|Authorization/);
  assert.equal(result.planHash.length, 64);
});

test('holds the prepare barrier when any node fails stage verification', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport({ stageMismatch: true });
  const error = await rejected(coordinator(journal, transport).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'prepare'),
    false
  );
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'swap'),
    false
  );
  assert.equal(transport.calls.filter(({ phase }) => phase === 'discard-stage').length, 1);
});

test('refuses preflight drift and never fences a node', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport({ drift: true });
  const error = await rejected(coordinator(journal, transport).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'stage'),
    false
  );
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'prepare'),
    false
  );
});

test('rolls back prepared nodes in reverse order after a prepare timeout', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport({ fault: { at: 'prepare:leader', code: 'timeout' } });
  const error = await rejected(coordinator(journal, transport).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'swap'),
    false
  );
  const rollbackNodes = transport.calls.filter(({ phase }) => phase === 'rollback').map(({ nodeId }) => nodeId);
  assert.deepEqual(rollbackNodes, ['leader', 'worker-1']);
});

test('treats a disconnect after swap as uncertain and attempts every rollback', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport({ fault: { after: 'swap:worker-1' } });
  const error = await rejected(coordinator(journal, transport).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.deepEqual(
    transport.calls.filter(({ phase }) => phase === 'rollback').map(({ nodeId }) => nodeId),
    ['leader', 'worker-1']
  );
  assert.equal(
    transport.calls.some(({ phase, nodeId }) => phase === 'swap' && nodeId === 'leader'),
    false
  );
});

test('treats a pre-apply swap disconnect as uncertain and rolls back the node', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport({ fault: { at: 'swap:worker-1', code: 'disconnect' } });
  const error = await rejected(coordinator(journal, transport).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.deepEqual(
    transport.calls.filter(({ phase }) => phase === 'rollback').map(({ nodeId }) => nodeId),
    ['leader', 'worker-1']
  );
  assert.equal(error.report.nodes['worker-1'].state, 'rolled-back');
});

test('rolls back when restart fails before health is affirmed', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport({ fault: { at: 'restart:worker-1', code: 'restart_failed' } });
  const error = await rejected(coordinator(journal, transport).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'promote' || phase === 'release'),
    false
  );
});

test('rejects a bad apply identity and does not promote', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport({ badSwapIdentity: true });
  const error = await rejected(coordinator(journal, transport).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'promote'),
    false
  );
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'release'),
    false
  );
});

test('keeps public fencing when the canary fails', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport({ badCanary: true });
  const error = await rejected(coordinator(journal, transport).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'release'),
    false
  );
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'reprepare'),
    false
  );
});

test('re-fences and drains every promoted node before rolling back a partial release', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport({ fault: { at: 'release:leader', code: 'release_failed' } });
  const error = await rejected(coordinator(journal, transport).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.deepEqual(
    transport.calls.filter(({ phase }) => phase === 'reprepare').map(({ nodeId }) => nodeId),
    ['leader', 'worker-1']
  );
  assert.deepEqual(
    transport.calls.filter(({ phase }) => phase === 'rollback').map(({ nodeId }) => nodeId),
    ['leader', 'worker-1']
  );
});

test('reports rollback failure and manual intervention without swallowing it', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport({ fault: { at: 'restart:worker-1' }, rollbackFailure: 'leader' });
  const error = await rejected(coordinator(journal, transport).deploy(plan()));
  assert.equal(error.report.operationState, 'rollback-failed');
  assert.equal(error.report.rollback.manualIntervention, true);
  assert.ok(error.report.rollback.failures.some((failure) => failure.nodeId === 'leader'));
});

test('does not duplicate mutations when status or resume is repeated', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport();
  const instance = coordinator(journal, transport);
  const first = await instance.deploy(plan());
  const before = transport.calls.length;
  assert.deepEqual(await instance.status('op-test'), first);
  const repeated = await instance.resume('op-test', { generation: first.generation });
  assert.equal(repeated.operationState, 'completed');
  assert.equal(transport.calls.length, before);
  await rejected(instance.resume('op-test', { generation: first.generation - 1 }), StaleGenerationError);
});

test('rejects unsupported gateway scope before creating a journal', async (t) => {
  const journal = await tempJournal(t);
  const instance = coordinator(journal, makeTransport());
  await rejected(
    instance.deploy(plan({ scope: { platform: 'darwin', serviceManager: 'launchd', mode: 'gateway' } })),
    DeploymentPlanError
  );
  assert.equal(await journal.load(), null);
});

test('refuses an old protocol or non-atomic node before staging', async (t) => {
  for (const option of [{ gatewayProtocol: 0 }, { atomicLayout: false }]) {
    const journal = await tempJournal(t);
    const transport = makeTransport(option);
    const error = await rejected(coordinator(journal, transport).deploy(plan()));
    assert.equal(error.report.operationState, 'rolled-back');
    assert.equal(
      transport.calls.some(({ phase }) => phase === 'stage'),
      false
    );
    assert.equal(
      transport.calls.some(({ phase }) => phase === 'prepare'),
      false
    );
  }
});

test('rejects a receipt containing private or unknown fields without persisting it', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport();
  const original = transport.stage;
  transport.stage = async (...args) => ({
    ...(await original.apply(transport, args)),
    requestBody: 'private request content'
  });
  const error = await rejected(coordinator(journal, transport).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.doesNotMatch(JSON.stringify(await journal.load()), /private request content/);
});

test('uses a local operation lock for concurrent coordinators', async (t) => {
  const journal = await tempJournal(t);
  const entered = new Promise((resolve) => {
    const transport = makeTransport();
    const original = transport.preflight;
    transport.preflight = async (...args) => {
      resolve();
      await new Promise((release) => setTimeout(release, 20));
      return original.apply(transport, args);
    };
    t.context = { transport };
  });
  const transport = t.context?.transport ?? makeTransport();
  const instance = coordinator(journal, transport);
  const running = instance.deploy(plan());
  await entered;
  await rejected(
    instance.deploy(
      plan({
        reviewedArtifact: { id: 'other', sha256: '9'.repeat(64), manifestSha256: 'a'.repeat(64), reviewed: true }
      })
    ),
    JournalLockError
  );
  await running;
});

test('fails closed when a receipt write or finalization write fails', async (t) => {
  const base = await tempJournal(t);
  let failed = false;
  const journal = {
    async load() {
      return base.load();
    },
    async save(document) {
      if (!failed && document.events.some((event) => event.type === 'receipt' && event.phase === 'swap')) {
        failed = true;
        throw new Error('simulated receipt write failure');
      }
      return base.save(document);
    },
    acquire: (...args) => base.acquire(...args),
    release: (...args) => base.release(...args)
  };
  const error = await rejected(coordinator(journal, makeTransport()).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.equal(error.report.rollback.manualIntervention, false);
});

test('fails closed when final completed-state journal write fails', async (t) => {
  const base = await tempJournal(t);
  let failed = false;
  const journal = {
    async load() {
      return base.load();
    },
    async save(document) {
      if (!failed && document.events.some((event) => event.type === 'completed')) {
        failed = true;
        throw new Error('simulated finalization write failure');
      }
      return base.save(document);
    },
    acquire: (...args) => base.acquire(...args),
    release: (...args) => base.release(...args)
  };
  const error = await rejected(coordinator(journal, makeTransport()).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.equal(error.report.rollback.manualIntervention, false);
  assert.equal(error.report.nodes['worker-1'].state, 'rolled-back');
});

test('recovers a pending action as unknown and never repeats its mutation', async (t) => {
  const journal = await tempJournal(t);
  const transport = makeTransport();
  const instance = coordinator(journal, transport);
  const first = await instance.deploy(plan());
  assert.equal(first.operationState, 'completed');
  const document = await journal.load();
  document.operationState = 'running';
  document.phase = 'swap';
  document.nodes['worker-1'].state = 'mutating';
  document.nodes['worker-1'].pendingAction = 'swap';
  document.nodes['worker-1'].possiblyMutated = true;
  delete document.nodes['worker-1'].receipts.swap;
  await journal.save(document);
  transport.calls.length = 0;
  const error = await rejected(instance.resume('op-test', { generation: document.generation }));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'swap'),
    false
  );
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'restart'),
    false
  );
  assert.equal(
    transport.calls.some(({ phase }) => phase === 'rollback'),
    true
  );
});

test('requires exact old release identity and supports node-specific old identities', () => {
  assert.throws(
    () => normalizeDeploymentPlan(plan({ expectedOldIdentity: { configSha256: CONFIG } })),
    DeploymentPlanError
  );
  const normalized = normalizeDeploymentPlan(
    plan({
      expectedOldIdentityByNode: {
        'worker-1': { releaseId: 'old-worker', artifactSha256: OLD, manifestSha256: OLD_MANIFEST },
        leader: { releaseId: 'old-leader', artifactSha256: OLD, manifestSha256: OLD_MANIFEST }
      }
    })
  );
  assert.equal(normalized.expectedOldIdentityByNode.leader.releaseId, 'old-leader');
});

test('rejects new identity drift between swap and restart', async (t) => {
  const journal = await tempJournal(t);
  const error = await rejected(coordinator(journal, makeTransport({ identityDrift: true })).deploy(plan()));
  assert.equal(error.report.operationState, 'rolled-back');
  assert.equal(error.report.nodes['worker-1'].state, 'rolled-back');
});
