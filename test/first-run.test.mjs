import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFirstRunServer, shouldOpenSetup } from '../src/first-run.mjs';
import { recipeSupportsWorkload, createReviewedSetupRunner } from '../src/browser-setup.mjs';
import { applyInit } from '../src/init.mjs';

async function fixture(overrides = {}) {
  let applications = 0;
  const app = createFirstRunServer({
    planBuilder: async ({ workloadId, recipeId }) => {
      if (recipeId && recipeId !== 'safe-recipe') throw new Error('Unknown recipe');
      return {
        plan: { configPath: '/owned/config', marker: 'reviewed' },
        view: { workloadId, selected: { id: 'safe-recipe' } }
      };
    },
    applyRunner: async (plan) => {
      applications++;
      assert.equal(plan.marker, 'reviewed');
      return { ok: true, configPath: plan.configPath };
    },
    gatewayStarter: async () => ({ status: 'started', url: 'http://127.0.0.1:8100' }),
    gatewayProbe: async () => ({ healthy: true, inferenceVerified: true }),
    logger: { error() {} },
    ...overrides
  });
  await app.listen();
  const bootstrap = new URL(app.bootstrapUrl()),
    origin = bootstrap.origin;
  const token = new URLSearchParams(bootstrap.hash.slice(1)).get('setup');
  const headers = { authorization: 'Bearer ' + token, origin, 'content-type': 'application/json' };
  const get = async (suffix) => {
    const response = await fetch(origin + '/gateway/first-run/' + suffix, { headers });
    return { response, body: await response.json() };
  };
  const post = async (body) => {
    const response = await fetch(origin + '/gateway/first-run/apply', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    return { response, body: await response.json() };
  };
  return { app, origin, headers, get, post, applications: () => applications };
}
test('browser setup remains optional for scripts and explicit CLI plans', () => {
  assert.equal(shouldOpenSetup([], { interactive: true }), true);
  assert.equal(shouldOpenSetup(['--browser']), true);
  for (const flag of ['--json', '--offline', '--no-browser', '--go', '--apply', '--recipe', '--format'])
    assert.equal(shouldOpenSetup(['--browser', flag], { interactive: true }), false);
  assert.equal(shouldOpenSetup(['--browser'], { installed: true }), false);
});
test('workload filters do not recommend chat recipes for images or unsupported hardware intents', () => {
  const chat = { capabilities: ['chat', 'tools'] };
  assert.equal(recipeSupportsWorkload(chat, 'code'), true);
  assert.equal(recipeSupportsWorkload(chat, 'images'), false);
  assert.equal(recipeSupportsWorkload({ capabilities: ['audio-transcription'] }, 'voice'), true);
});
test('fresh bootstrap token, exact origin and host protect all setup data and writes', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.origin + '/gateway/first-run/job')).status, 401);
    assert.equal(
      (await fetch(f.origin + '/gateway/first-run/job', { headers: { ...f.headers, origin: 'https://evil.example' } }))
        .status,
      403
    );
    const reboundStatus = await new Promise((resolve, reject) => {
      http
        .get(f.origin + '/', { headers: { host: 'rebound.example' } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        })
        .on('error', reject);
    });
    assert.equal(reboundStatus, 403);
    const html = await fetch(f.origin + '/').then((r) => r.text());
    assert(!html.includes(f.headers.authorization.split(' ')[1]));
    assert.equal((await f.post({ planId: 'x', yes: false })).response.status, 400);
    assert.equal(f.applications(), 0);
  } finally {
    await f.app.close();
  }
});
test('apply binds the reviewed plan and repeated clicks run once; gateway starts after install', async () => {
  const calls = [];
  let release;
  const barrier = new Promise((resolve) => (release = resolve));
  const f = await fixture({
    applyRunner: async (plan) => {
      calls.push('apply');
      assert.equal(plan.marker, 'reviewed');
      await barrier;
      return { ok: true, configPath: plan.configPath };
    },
    gatewayStarter: async () => {
      calls.push('gateway');
      return { status: 'started' };
    }
  });
  try {
    const plan = (await f.get('plan?workload=code')).body.plan;
    assert.equal((await f.post({ planId: plan.planId, yes: true, configPath: '/attacker' })).response.status, 400);
    assert.equal((await f.post({ planId: plan.planId, yes: true, workloadId: 'voice' })).response.status, 409);
    const started = await f.post({ planId: plan.planId, yes: true, workloadId: 'code' });
    assert.equal(started.response.status, 202);
    const duplicate = await f.post({ planId: plan.planId, yes: true });
    assert.equal(duplicate.body.job.id, started.body.job.id);
    assert.deepEqual(calls, ['apply']);
    assert.equal((await f.get('plan?workload=chat')).response.status, 409);
    release();
    await f.app.close();
    assert.deepEqual(calls, ['apply', 'gateway']);
  } finally {
    release();
    if (f.app.server.listening) await f.app.close();
  }
});
test('expired plans and unknown recipe selections cannot install', async () => {
  let clock = 100;
  const f = await fixture({ now: () => clock, planTtlMs: 10 });
  try {
    const plan = (await f.get('plan')).body.plan;
    clock = 111;
    assert.equal((await f.post({ planId: plan.planId, yes: true })).response.status, 410);
    assert.equal((await f.get('plan?recipe=unknown')).response.status, 500);
    assert.equal(f.applications(), 0);
  } finally {
    await f.app.close();
  }
});
test('health alone never marks inference ready; install failure never starts the gateway', async () => {
  for (const fail of [false, true]) {
    let started = false;
    const f = await fixture({
      applyRunner: async () => {
        if (fail) throw new Error('disk full');
        return { ok: true };
      },
      gatewayStarter: async () => {
        started = true;
        return { status: 'started' };
      },
      gatewayProbe: async () => ({ healthy: true, inferenceVerified: false, detail: 'Model still loading' })
    });
    try {
      const plan = (await f.get('plan')).body.plan;
      await f.post({ planId: plan.planId, yes: true });
      const job = (await f.get('job')).body.job;
      assert.equal(job.ready, false);
      assert.equal(job.inferenceVerified, false);
      assert.equal(started, !fail);
      if (fail) {
        assert.equal(job.status, 'failed');
        assert.match(job.error, /disk full/);
      }
    } finally {
      await f.app.close();
    }
  }
});

test('first-run resumes only its unchanged configuration after a partial bootstrap failure', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-first-run-owned-'));
  const file = path.join(dir, 'config.json');
  const raw = { models: [], runtimes: {}, backends: {} };
  const evidence = { recipe: { id: 'reviewed' }, backendCatalog: {} };
  const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const plan = {
    configPath: file,
    modelRoot: path.join(dir, 'models'),
    selectedRecipe: { id: 'reviewed' },
    setup: { phases: { init: { config: raw } } },
    browserSetup: { fingerprint: fingerprint(evidence), options: {} }
  };
  let applies = 0,
    bootstraps = 0;
  const run = createReviewedSetupRunner(
    {},
    {
      evidence: async () => evidence,
      apply: async (_config, options) => {
        applies++;
        assert.equal(options.reviewedPlan, plan.setup);
        assert.equal(options.exclusiveConfig, true);
        await fs.writeFile(file, JSON.stringify(raw), { flag: 'wx' });
        await options.onConfigWritten(file, raw);
        throw new Error('download interrupted');
      },
      bootstrap: async () => {
        bootstraps++;
        return { ok: true };
      }
    }
  );
  try {
    await assert.rejects(run(plan, {}), /download interrupted/);
    assert.equal((await run(plan, {})).ok, true);
    assert.equal(applies, 1);
    assert.equal(bootstraps, 1);
    await fs.writeFile(file, JSON.stringify({ ...raw, changed: true }));
    await assert.rejects(run(plan, {}), /will not overwrite/);
    evidence.recipe.id = 'changed';
    await assert.rejects(run(plan, {}), /recipe or backend catalog changed/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('exclusive first-run publication cannot replace a file created after review', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-first-run-exclusive-'));
  const file = path.join(dir, 'config.json');
  try {
    await fs.writeFile(file, 'original');
    await assert.rejects(
      applyInit(
        {},
        { dryRun: false, yes: true, exclusiveConfig: true, reviewedPlan: { configPath: file, config: { models: [] } } }
      ),
      { code: 'EEXIST' }
    );
    assert.equal(await fs.readFile(file, 'utf8'), 'original');
    assert.deepEqual(await fs.readdir(dir), ['config.json']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('failed HTTP setup retries reuse the immutable reviewed plan instead of a fresh timestamp', async () => {
  let plans = 0,
    attempts = 0;
  const f = await fixture({
    planBuilder: async ({ workloadId }) => ({
      plan: { configPath: '/owned/config', generatedAt: ++plans },
      view: { workloadId, selected: { id: 'safe-recipe' } }
    }),
    applyRunner: async (plan) => {
      assert.equal(plan.generatedAt, 1);
      if (++attempts === 1) throw new Error('interrupted download');
      return { ok: true, configPath: plan.configPath };
    }
  });
  try {
    const first = (await f.get('plan')).body.plan;
    await f.post({ planId: first.planId, yes: true });
    assert.equal((await f.get('job')).body.job.status, 'failed');
    const retry = (await f.get('plan')).body.plan;
    assert.notEqual(retry.planId, first.planId);
    assert.equal(plans, 1);
    await f.post({ planId: retry.planId, yes: true });
    assert.equal((await f.get('job')).body.job.status, 'succeeded');
    await f.post({ planId: retry.planId, yes: true });
    assert.equal(attempts, 2, 'completed apply remains idempotent');
  } finally {
    await f.app.close();
  }
});

test('reviewed bootstrap executes pinned step plans without reopening source catalogs', async () => {
  const { applyBootstrap } = await import('../src/bootstrap.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-frozen-bootstrap-'));
  const reviewed = {
    reviewedRecipe: { id: 'frozen', name: 'Frozen recipe', backend: { id: 'frozen-backend' } },
    reviewedBackend: { id: 'frozen-backend', name: 'Frozen backend' },
    modelRoot: path.join(dir, 'models'),
    backend: {
      platformSupported: true,
      steps: [{ id: 'approved-backend', action: 'command', command: ['approved', 'backend'] }]
    },
    recipe: {
      validationErrors: [],
      steps: [{ id: 'approved-model', action: 'command', command: ['approved', 'model'] }]
    }
  };
  try {
    const result = await applyBootstrap(
      { server: { host: '127.0.0.1', port: 8100 }, security: {}, models: [], runtimes: {} },
      {
        reviewedPlan: reviewed,
        dryRun: true,
        home: dir,
        statePath: path.join(dir, 'state.json'),
        recipesRoot: '/must-not-reopen-recipes',
        backendCatalogPath: '/must-not-reopen-catalog',
        clientId: 'all'
      }
    );
    assert.deepEqual(result.backend.results[0].command, ['approved', 'backend']);
    assert.deepEqual(result.recipe.results[0].command, ['approved', 'model']);
    assert.equal(result.selectedRecipe.id, 'frozen');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('reviewed downloads retain their executable when the environment changes', async () => {
  const { pinDownloadCommands, applyRecipe } = await import('../src/installer.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-reviewed-download-'));
  try {
    const executable = path.join(dir, 'reviewed-hf');
    await fs.writeFile(
      executable,
      '#!/bin/sh\nfor last do :; done\nmkdir -p "$last"\nprintf "{}" > "$last/config.json"\nprintf "weights" > "$last/model.safetensors"\n',
      { mode: 0o755 }
    );
    const destination = path.join(dir, 'model');
    const reviewed = await pinDownloadCommands(
      {
        validationErrors: [],
        steps: [
          {
            id: 'download',
            action: 'download-model',
            provider: 'huggingface',
            model: 'test/model',
            destination,
            command: ['hf', 'download', 'test/model', '--local-dir', destination]
          }
        ]
      },
      { env: { ...process.env, LLOOM_HF_BIN: executable } }
    );
    assert.equal(reviewed.steps[0].command[0], executable);
    const report = await applyRecipe(
      { id: 'reviewed-test' },
      {},
      {
        reviewedPlan: reviewed,
        dryRun: false,
        yes: true,
        statePath: path.join(dir, 'state.json'),
        env: { ...process.env, LLOOM_HF_BIN: '/must-not-run', HF_HUB_CLI: '/must-not-run' }
      }
    );
    assert.equal(report.results[0].status, 'completed', JSON.stringify(report.results));
    assert.equal(report.results[0].command[0], executable);
    assert.equal(await fs.readFile(path.join(destination, 'model.safetensors'), 'utf8'), 'weights');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
