import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSetupStatus } from '../src/setup-status.mjs';
import { createModelMaintenanceController } from '../src/model-maintenance-control.mjs';
import { createAccordEffects } from '../src/accord-effects.mjs';
import { createAccordWorkloadReporter } from '../src/accord-workload-report.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseConfig() {
  return {
    runtimes: {
      'local-main': { enabled: true, keepWarm: true, provider: 'local' },
      'cloud-fallback': { enabled: true, keepWarm: false, provider: 'cloud' }
    },
    models: [
      { id: 'local-model', runtime: 'local-main' },
      { id: 'cloud-model', runtime: 'cloud-fallback' }
    ],
    aliases: { chat: { members: ['local-model'] } },
    profiles: { default: {} }
  };
}

function maintenanceHarness() {
  let config = baseConfig();
  const store = { raw: JSON.parse(JSON.stringify(config)) };
  const state = Object.fromEntries(Object.keys(store.raw.runtimes).map((id) => [id, false]));
  const manager = {
    assertRuntimeControl() {},
    async drainRuntime() {},
    async stop(id) {
      state[id] = false;
      return undefined;
    },
    async resumeRuntime() {},
    async pauseRuntime() {},
    async isHealthy(id) {
      return state[id];
    },
    runtimeAppearsLoaded(id) {
      return state[id];
    }
  };
  let tick = 0;
  const controller = createModelMaintenanceController({
    getConfig: () => config,
    mutateSource(mutate) {
      const draft = JSON.parse(JSON.stringify(store.raw));
      mutate(draft);
      store.raw = draft;
    },
    async reload() {
      config = JSON.parse(JSON.stringify(store.raw));
    },
    manager,
    async admit(id) {
      state[id] = true;
    },
    now: () => new Date(1700000000000 + tick++ * 1000).toISOString()
  });
  return { controller, store };
}

test('setup-status reports a selected recipe that is not in this catalog instead of failing', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lloom-status-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const recipesRoot = path.join(dir, 'recipes');
  await fsp.mkdir(recipesRoot, { recursive: true });
  const status = await createSetupStatus(
    {
      sourcePath: path.join(dir, 'config.json'),
      server: { host: '127.0.0.1', port: 8100 },
      models: [],
      aliases: {},
      runtimes: {},
      paths: { modelRoot: path.join(dir, 'models') }
    },
    {
      recipeId: 'linux-nvidia-gb10-parakeet-nemo',
      recipesRoot,
      includeRuntimes: false,
      home: dir,
      generatedRoot: path.join(dir, 'generated'),
      statePath: path.join(dir, 'install-state.json')
    }
  );
  assert.equal(status.ok, false);
  assert.equal(status.recipe.id, 'linux-nvidia-gb10-parakeet-nemo');
  assert.equal(status.recipe.inCatalog, false);
  assert.equal(status.recipe.note, 'recipe linux-nvidia-gb10-parakeet-nemo is not in this catalog');
  assert.deepEqual(status.recipe.validationErrors, ['recipe linux-nvidia-gb10-parakeet-nemo is not in this catalog']);
  assert.equal(status.selectedRecipe.id, 'linux-nvidia-gb10-parakeet-nemo');
  assert.ok(status.integrations);
  assert.ok(status.next);
});

test('maintenance markers keep by and a capped history', async () => {
  const h = maintenanceHarness();
  await h.controller.run('local-main', 'suspend', { apply: true, yes: true });
  let runtime = h.store.raw.runtimes['local-main'];
  assert.equal(runtime.maintenance.by, 'cli');
  assert.deepEqual(
    runtime.maintenanceHistory.map((entry) => entry.state),
    ['suspended']
  );
  await h.controller.run('local-main', 'resume', { apply: true, yes: true, requestedBy: 'accord:tessera' });
  runtime = h.store.raw.runtimes['local-main'];
  assert.equal(runtime.maintenance, undefined);
  assert.deepEqual(
    runtime.maintenanceHistory.map((entry) => [entry.state, entry.by]),
    [
      ['suspended', 'cli'],
      ['resuming', 'accord:tessera'],
      ['resumed', 'accord:tessera']
    ]
  );
  for (let i = 0; i < 10; i++) {
    await h.controller.run('local-main', 'suspend', { apply: true, yes: true });
    await h.controller.run('local-main', 'resume', { apply: true, yes: true });
  }
  runtime = h.store.raw.runtimes['local-main'];
  assert.equal(runtime.maintenanceHistory.length, 20);
  assert.equal(runtime.maintenanceHistory.at(-1).state, 'resumed');
});

test('Accord effects attribute maintenance to the holder label or claim', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lloom-effects-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const config = {
    sourcePath: path.join(dir, 'config.json'),
    reservations: { resources: { gpu: { suspend: ['resident'] } } }
  };
  const requested = [];
  const effects = createAccordEffects({
    statePath: path.join(dir, 'effects.json'),
    getConfig: () => config,
    actions: {
      isSuspended: async () => false,
      suspend: async (x) => requested.push(x.requestedBy),
      resume: async (x) => requested.push(x.requestedBy)
    }
  });
  const fence = { authority: 'host', claimId: 'claim-1', generation: 1 };
  await effects.handle('gpu', 'prepare', { ...fence, holder: { label: 'tessera', address: 'host/tessera' } });
  assert.deepEqual(requested, ['accord:tessera']);
  requested.length = 0;
  await effects.handle('gpu', 'stop', fence);
  await effects.handle('gpu', 'restore', fence);
  assert.deepEqual(requested, ['accord:claim-1']);
});

function reporterHarness({ clientImpl } = {}) {
  const config = {
    runtimes: {
      'local-main': { enabled: true, containerName: 'lloom-local-main' },
      'worker-gpu': {
        enabled: true,
        node: 'ennspark04',
        maintenance: {
          state: 'suspended',
          requestedModel: 'worker-model',
          since: '2026-11-18T20:33:00.000Z',
          operationId: 'op-9',
          by: 'accord:tessera'
        }
      },
      'off-lane': { enabled: false },
      'docker-lane': { enabled: true, container: { name: 'lloom-docker-lane' } }
    },
    models: [
      { id: 'local-model', runtime: 'local-main' },
      { id: 'worker-model', runtime: 'worker-gpu' }
    ]
  };
  const sent = [];
  const errors = [];
  const client = clientImpl ?? {
    collaborate: async (operation, args) => {
      sent.push({ operation, args });
      return {};
    }
  };
  const manager = {
    status: async () => ({
      runtimes: {
        'local-main': { status: 'running', statusSince: '2026-11-18T20:00:00.000Z' },
        'worker-gpu': { status: 'stopped' },
        'docker-lane': { status: 'starting' }
      }
    })
  };
  const reporter = createAccordWorkloadReporter({
    getConfig: () => config,
    manager,
    logger: { error: (m) => errors.push(m) },
    clientFor: () => client,
    intervalMs: 3600000,
    debounceMs: 10,
    ttlMs: 180000
  });
  return { reporter, sent, errors, config };
}

test('reporter sends one runtime item per enabled configured runtime', async () => {
  const { reporter, sent } = reporterHarness();
  await reporter.sendNow();
  assert.equal(sent.length, 1);
  const { operation, args } = sent[0];
  assert.equal(operation, 'workload-report');
  assert.equal(args.source, 'lloom');
  assert.equal(args.ttlMs, 180000);
  const byId = Object.fromEntries(args.items.map((item) => [item.id, item]));
  assert.deepEqual(Object.keys(byId).sort(), ['docker-lane', 'local-main', 'worker-gpu']);
  assert.deepEqual(byId['local-main'], {
    id: 'local-main',
    kind: 'runtime',
    state: 'running',
    container: 'lloom-local-main',
    model: 'local-model',
    since: Date.parse('2026-11-18T20:00:00.000Z')
  });
  assert.equal(byId['worker-gpu'].state, 'suspended');
  assert.equal(byId['worker-gpu'].node, 'ennspark04');
  assert.equal(byId['worker-gpu'].by, 'accord:tessera');
  assert.equal(byId['worker-gpu'].operationId, 'op-9');
  assert.equal(byId['worker-gpu'].since, Date.parse('2026-11-18T20:33:00.000Z'));
  assert.equal(byId['docker-lane'].container, 'lloom-docker-lane');
  assert.equal(byId['docker-lane'].state, 'starting');
});

test('change notifications debounce into a single report', async () => {
  const { reporter, sent } = reporterHarness();
  reporter.notifyChanged();
  reporter.notifyChanged();
  reporter.notifyChanged();
  await delay(50);
  assert.equal(sent.length, 1);
  await reporter.stop();
});

test('report failures are logged once per distinct error and never thrown', async () => {
  let calls = 0;
  const { reporter, sent, errors } = reporterHarness({
    clientImpl: {
      collaborate: async () => {
        calls++;
        throw new Error('unknown operation workload-report');
      }
    }
  });
  await reporter.sendNow();
  await reporter.sendNow();
  assert.equal(calls, 2);
  assert.equal(sent.length, 0);
  assert.equal(errors.length, 1);
  const missing = reporterHarness({ clientImpl: undefined });
  missing.reporter = createAccordWorkloadReporter({
    getConfig: () => missing.config,
    manager: { status: async () => ({ runtimes: {} }) },
    logger: { error: (m) => missing.errors.push(m) },
    clientFor: () => {
      throw new Error('no local Accord');
    }
  });
  await missing.reporter.sendNow();
  assert.equal(missing.errors.length, 1);
});

test('stop clears the interval and pending debounce', async () => {
  const { reporter, sent } = reporterHarness();
  reporter.notifyChanged();
  await reporter.stop();
  await delay(40);
  assert.equal(sent.length, 0);
});
