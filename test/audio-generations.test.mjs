import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { createLloomServer } from '../src/server.mjs';

const bytes = Buffer.from([82, 73, 70, 70, 0, 255, 128, 10]);
async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, respond = (_req, res) => res.end(bytes)) {
  const calls = [];
  const backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
    res.setHeader('content-type', 'audio/wav');
    respond(req, res);
  });
  const baseUrl = await listen(backend);
  const config = {
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    logging: { metricsPersistence: false },
    telemetry: { performanceSampler: false },
    defaults: { audioGenerationModel: 'music' },
    aliases: { song: { members: ['music'] } },
    backends: { media: { type: 'openai', baseUrl: `${baseUrl}/v1`, apiKey: 'fixture-key' } },
    models: ['music', 'speech', 'chat'].map((id) => ({
      id,
      backend: 'media',
      upstreamModel: `upstream-${id}`,
      kind: id === 'music' ? 'audio_generation' : id === 'speech' ? 'audio_speech' : 'chat'
    }))
  };
  const app = createLloomServer(config, { logger: { error() {}, warn() {} } });
  const gateway = await listen(app.server);
  t.after(async () => {
    app.server.closeAllConnections();
    backend.closeAllConnections();
    await app.close({ stopRuntimes: false });
    await new Promise((resolve) => backend.close(resolve));
  });
  return {
    calls,
    config,
    metrics: app.metrics,
    gateway,
    request(body, route = '/v1/audio/generations', options = {}) {
      return fetch(gateway + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...options
      });
    }
  };
}

test('generation preserves binary bytes, payload, alias resolution, authorization and default', async (t) => {
  const f = await fixture(t);
  for (const model of ['music', 'song', undefined]) {
    const response = await f.request({ model, prompt: 'instrumental', lyrics: 'hello' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/wav');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    assert.deepEqual(f.calls.at(-1).body, { model: 'upstream-music', prompt: 'instrumental', lyrics: 'hello' });
    assert.equal(f.calls.at(-1).headers.authorization, 'Bearer fixture-key');
    assert.equal(f.calls.at(-1).path, '/v1/audio/generations');
  }
});

test('invalid kinds, unknown and missing models never reach the backend', async (t) => {
  const f = await fixture(t);
  for (const [body, route, status, code] of [
    [{ model: 'speech' }, '/v1/audio/generations', 400, 'wrong_model_kind'],
    [{ model: 'chat' }, '/v1/audio/generations', 400, 'wrong_model_kind'],
    [{ model: 'music', input: 'hello' }, '/v1/audio/speech', 400, 'wrong_model_kind'],
    [{ model: 'unknown' }, '/v1/audio/generations', 404, 'unknown_model']
  ]) {
    const response = await f.request(body, route);
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
  }
  delete f.config.defaults.audioGenerationModel;
  const missing = await f.request({ prompt: 'hello' });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'missing_model');
  assert.equal(f.calls.length, 0);
});

test('catalog contains only generation models and GET inference is absent', async (t) => {
  const f = await fixture(t);
  const result = await (await fetch(f.gateway + '/v1/audio/generations/models')).json();
  assert.equal(result.object, 'audio.generation.catalog');
  assert.equal(result.defaultModel, 'music');
  assert.deepEqual(
    result.models.map((m) => m.id),
    ['music', 'song']
  );
  assert.equal((await fetch(f.gateway + '/v1/audio/generations')).status, 404);
});

test('first binary chunk arrives while upstream remains open', { timeout: 5000 }, async (t) => {
  let finish;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(202);
    res.write(bytes);
    finish = () => res.end(Buffer.from([0, 254, 129]));
  });
  const response = await f.request({ model: 'music' });
  assert.equal(response.status, 202);
  const reader = response.body.getReader();
  assert.deepEqual(Buffer.from((await reader.read()).value), bytes);
  finish();
  assert.deepEqual(Buffer.from((await reader.read()).value), Buffer.from([0, 254, 129]));
  assert.equal((await reader.read()).done, true);
});

test('client cancellation closes the upstream connection', { timeout: 5000 }, async (t) => {
  let closed;
  const upstreamClosed = new Promise((resolve) => {
    closed = resolve;
  });
  const f = await fixture(t, (_req, res) => {
    res.on('close', closed);
    res.write(bytes);
  });
  const controller = new AbortController();
  const response = await f.request({ model: 'music' }, undefined, { signal: controller.signal });
  await response.body.getReader().read();
  controller.abort();
  await upstreamClosed;
});

test('mid-body upstream reset terminates binary output without an SSE suffix', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200);
    res.write(bytes);
    setTimeout(() => res.destroy(), 25);
  });
  const response = await f.request({ model: 'music' });
  const reader = response.body.getReader();
  const chunks = [];
  await assert.rejects(async () => {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
  });
  const received = Buffer.concat(chunks);
  assert.deepEqual(received, bytes);
  assert.equal(received.includes(Buffer.from('data:')), false);
  assert.equal(received.includes(Buffer.from('[DONE]')), false);
});

test('pre-header cancellation is not recorded as an observable generation stall', { timeout: 5000 }, async (t) => {
  let arrived;
  const ready = new Promise((resolve) => {
    arrived = resolve;
  });
  const f = await fixture(t, () => arrived());
  const controller = new AbortController();
  const response = f.request({ model: 'music' }, undefined, { signal: controller.signal });
  await ready;
  controller.abort();
  await assert.rejects(response);
  for (let i = 0; i < 100 && !f.metrics.snapshot().recent.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const outcome = f.metrics.snapshot().recent.at(-1);
  assert.equal(outcome.status, 499);
  assert.equal(outcome.stream, false);
  assert.equal(outcome.responseBytes, 0);
});

test('upstream error status and body pass through unchanged', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
    res.end(JSON.stringify({ error: { code: 'busy' } }));
  });
  const response = await f.request({ model: 'music' });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'busy');
});
