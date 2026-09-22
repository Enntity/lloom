import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInstallationJobs } from '../src/installation-jobs.mjs';
import { createDashboardInstallation } from '../src/dashboard-installation.mjs';
import { loadConfig } from '../src/config.mjs';

test('review is read-only; apply is bound, serialized and idempotent across refresh', async () => {
  let release,
    calls = 0,
    clock = 0;
  const barrier = new Promise((resolve) => (release = resolve));
  const jobs = createInstallationJobs({
    now: () => clock,
    ttlMs: 10,
    plan: async (input) => ({ input, view: { summary: 'Review' } }),
    apply: async (prepared, progress) => {
      calls++;
      assert.equal(prepared.input.recipeId, 'vendor');
      progress({ message: 'Downloading' });
      await barrier;
      return { ok: true };
    }
  });
  const a = await jobs.review({ recipeId: 'vendor' });
  const b = await jobs.review({ recipeId: 'vendor' });
  assert.equal(calls, 0);
  assert.throws(() => jobs.start({ planId: a.planId, yes: false }), /reviewed/);
  assert.throws(() => jobs.start({ planId: a.planId, yes: true, recipeId: 'other' }), /reviewed/);
  const first = jobs.start({ planId: a.planId, yes: true });
  assert.equal(jobs.start({ planId: a.planId, yes: true }).id, first.id);
  assert.throws(() => jobs.start({ planId: b.planId, yes: true }), /already/);
  await Promise.resolve();
  assert.equal(jobs.snapshot().detail, 'Downloading');
  release();
  assert.equal((await jobs.wait()).status, 'succeeded');
  assert.equal(calls, 1);
  clock = 11;
  assert.throws(() => jobs.start({ planId: b.planId, yes: true }), /fresh/);
});

test('installation failures remain visible and a fresh reviewed plan can retry', async () => {
  const jobs = createInstallationJobs({
    plan: async () => ({ view: {} }),
    apply: async () => {
      throw new Error('disk full');
    }
  });
  const plan = await jobs.review({});
  jobs.start({ planId: plan.planId, yes: true });
  const failed = await jobs.wait();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'disk full');
  assert.notEqual((await jobs.review({})).planId, plan.planId);
});

test('dashboard installs an unmanaged endpoint without processes and preserves raw secrets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-installation-'));
  try {
    const file = path.join(dir, 'config.json');
    await fs.writeFile(
      file,
      JSON.stringify({ models: [], backends: {}, runtimes: {}, security: { apiKeys: ['${UNEXPANDED_TEST_KEY}'] } })
    );
    let config = await loadConfig(file),
      reloads = 0;
    const jobs = createDashboardInstallation({
      getConfig: () => config,
      reload: async () => {
        config = await loadConfig(file);
        reloads++;
      }
    });
    const input = { modelRef: 'openai:http://127.0.0.1:9999/v1#test-model' };
    const plan = await jobs.review(input);
    jobs.start({ planId: plan.planId, yes: true });
    const result = await jobs.wait();
    assert.equal(result.status, 'succeeded', result.error);
    assert.equal(reloads, 1);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(raw.security.apiKeys[0], '${UNEXPANDED_TEST_KEY}');
    assert.equal(raw.models.length, 1);
    const stale = await jobs.review({ modelRef: 'openai:http://127.0.0.1:9998/v1#another-model' });
    raw.extra = 'concurrent edit';
    await fs.writeFile(file, JSON.stringify(raw));
    jobs.start({ planId: stale.planId, yes: true });
    assert.equal((await jobs.wait()).status, 'failed');
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).extra, 'concurrent edit');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('dashboard installation routes enforce browser origin and publish the reviewed endpoint', async () => {
  const { createLloomServer } = await import('../src/server.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-install-http-'));
  let app;
  try {
    const file = path.join(dir, 'config.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        server: { host: '127.0.0.1', port: 0 },
        security: { allowMissingAuth: true },
        models: [],
        runtimes: {},
        backends: {}
      })
    );
    app = createLloomServer(await loadConfig(file), { logger: { log() {}, error() {} } });
    await app.listen();
    const origin = 'http://127.0.0.1:' + app.server.address().port;
    const post = (suffix, body, site = origin) =>
      fetch(origin + '/gateway/installations' + suffix, {
        method: 'POST',
        headers: { origin: site, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
    const input = { modelRef: 'openai:http://127.0.0.1:9999/v1#http-test' };
    assert.equal((await post('/plan', input, 'https://foreign.example')).status, 403);
    const response = await post('/plan', input);
    assert.equal(response.status, 200);
    const plan = await response.json();
    assert.equal((await post('', { planId: plan.planId, yes: true })).status, 202);
    let job;
    for (let i = 0; i < 50; i++) {
      job = (await fetch(origin + '/gateway/installations', { headers: { origin } }).then((r) => r.json())).job;
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.status, 'succeeded', job.error);
    const catalog = await fetch(origin + '/gateway/models', { headers: { origin } }).then((r) => r.json());
    assert(catalog.models.some((model) => model.id === 'http-test'));
  } finally {
    if (app) await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
