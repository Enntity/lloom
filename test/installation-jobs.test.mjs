import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInstallationJobs } from '../src/installation-jobs.mjs';
import { createDashboardInstallation } from '../src/dashboard-installation.mjs';
import { loadConfig } from '../src/config.mjs';
import { installImportedModelAssets } from '../src/model-installation.mjs';
import { MODEL_ACQUISITION_MANIFEST } from '../src/model-acquisition.mjs';

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

test('browser imports require an immutable Hugging Face revision before creating a plan', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-import-review-'));
  try {
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, JSON.stringify({ models: [], runtimes: {}, paths: { modelRoot: dir } }));
    const config = await loadConfig(file);
    const executable = path.join(dir, 'hf');
    const jobs = createDashboardInstallation({
      getConfig: () => config,
      reload: async () => {},
      env: { PATH: dir, LLOOM_HF_BIN: executable }
    });
    for (const modelRef of ['owner/model-gguf', 'https://huggingface.co/owner/model-gguf/tree/main'])
      await assert.rejects(jobs.review({ modelRef }), /pinned to a commit/);
    const revision = '1234567890abcdef1234567890abcdef12345678';
    await assert.rejects(
      jobs.review({ modelRef: 'https://huggingface.co/owner/model-gguf/resolve/' + revision + '/model.gguf' }),
      /downloader is not installed/
    );
    await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const reviewed = await jobs.review({
      modelRef: 'https://huggingface.co/owner/model-gguf/resolve/' + revision + '/model.gguf'
    });
    assert.equal(reviewed.details.download.acquisition.revision, revision);
    assert.deepEqual(reviewed.details.download.acquisition.include, ['model.gguf']);
    assert(path.isAbsolute(reviewed.details.download.command[0]));
    assert.deepEqual(
      (await fs.readdir(dir)).sort(),
      ['config.json', 'hf'],
      'review must not create download directories'
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('import acquisition keeps failed payloads staged and verifies before publishing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-import-acquisition-'));
  try {
    const destination = path.join(dir, 'model');
    const executable = path.join(dir, 'hf');
    const revision = '1234567890abcdef1234567890abcdef12345678';
    const acquisition = {
      provider: 'huggingface',
      model: 'owner/model',
      revision,
      destination,
      include: ['model.gguf']
    };
    const command = [
      executable,
      'download',
      acquisition.model,
      '--revision',
      revision,
      '--include',
      'model.gguf',
      '--local-dir',
      destination
    ];
    const plan = { additions: {}, reference: { type: 'huggingface' }, download: { command, acquisition } };
    // A successful subprocess that writes the wrong payload must not publish it.
    await fs.writeFile(executable, '#!/bin/sh\nfor last do :; done\nprintf "partial" > "$last/wrong.gguf"\n', {
      mode: 0o755
    });
    await assert.rejects(installImportedModelAssets(plan), /verification failed/);
    await assert.rejects(fs.access(destination), { code: 'ENOENT' });
    await fs.access(destination + '.incomplete/wrong.gguf');
    await fs.writeFile(executable, '#!/bin/sh\nfor last do :; done\nprintf "weights" > "$last/model.gguf"\n', {
      mode: 0o755
    });
    await installImportedModelAssets(plan);
    await assert.rejects(fs.access(destination + '.incomplete'), { code: 'ENOENT' });
    const manifest = JSON.parse(await fs.readFile(path.join(destination, MODEL_ACQUISITION_MANIFEST), 'utf8'));
    assert.equal(manifest.revision, revision);
    assert.deepEqual(manifest.include, ['model.gguf']);
    assert.equal(await fs.readFile(path.join(destination, 'model.gguf'), 'utf8'), 'weights');
    // Verified data is reusable even after the original downloader disappears.
    await fs.unlink(executable);
    await installImportedModelAssets(plan);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
