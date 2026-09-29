import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { createLloomServer } from '../src/server.mjs';

// PCM16 LE signed frames: 0, +1, -1 as raw bytes (no container). Keep the
// values inside int16 range so the fixture is a realistic payload.
const pcmA = Buffer.from([0x00, 0x00, 0x01, 0x00, 0xff, 0xff]);
const pcmB = Buffer.from([0x10, 0x27, 0xf0, 0xd8]);
const wavBytes = Buffer.from('RIFFlloom-wav-body');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

// The upstream stands in for the mlx-audio backend: for stream requests it
// emits signed PCM16 with the raw `audio/L16` content type and rate headers.
async function fixture(t, respond) {
  const calls = [];
  const backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks);
    const body = /multipart\/form-data/i.test(req.headers['content-type'] ?? '')
      ? { multipart: true }
      : JSON.parse(rawBody);
    calls.push({ path: req.url, headers: req.headers, body });
    if (body.stream === true && String(body.response_format).toLowerCase() === 'pcm') {
      res.setHeader('content-type', 'audio/pcm; rate=24000; channels=1');
      res.setHeader('x-audio-sample-rate', '24000');
      res.setHeader('x-audio-channels', '1');
      res.setHeader('x-audio-format', 'pcm_s16le');
    } else {
      res.setHeader('content-type', 'audio/wav');
    }
    respond(req, res, body);
  });
  const baseUrl = await listen(backend);
  const config = {
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    logging: { metricsPersistence: false },
    telemetry: { performanceSampler: false },
    defaults: { speechModel: 'speech' },
    backends: { 'synthetic-speech': { type: 'openai', baseUrl: `${baseUrl}/v1`, apiKey: 'fixture-key' } },
    models: [
      {
        id: 'speech',
        backend: 'synthetic-speech',
        upstreamModel: 'upstream-speech',
        kind: 'audio_speech',
        tts: { family: 'qwen3-tts', mode: 'custom_voice' }
      },
      { id: 'chat', backend: 'synthetic-speech', upstreamModel: 'upstream-chat', kind: 'chat' }
    ]
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
    request(body, options = {}) {
      return fetch(gateway + '/v1/audio/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...options
      });
    }
  };
}

test('normal wav speech stays buffered and unchanged', async (t) => {
  const f = await fixture(t, (_req, res) => res.end(wavBytes));
  const response = await f.request({ model: 'speech', input: 'hello', response_format: 'wav' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wavBytes);
  assert.equal(f.calls.at(-1).body.stream ?? false, false);
  assert.equal(f.calls.at(-1).body.response_format, 'wav');
});

test('stream:true + response_format:pcm streams raw bytes before completion', { timeout: 5000 }, async (t) => {
  let finish;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200);
    res.write(pcmA);
    finish = () => res.end(pcmB);
  });
  const response = await f.request({ model: 'speech', input: 'hello', stream: true, response_format: 'pcm' });
  assert.equal(response.status, 200);
  assert.equal(f.calls.at(-1).body.stream, true);
  assert.equal(f.calls.at(-1).body.response_format, 'pcm');
  assert.equal(f.calls.at(-1).headers.authorization, 'Bearer fixture-key');
  // First chunk is readable while the upstream is still open.
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.deepEqual(Buffer.from(first.value), pcmA);
  assert.equal(first.done, false);
  finish();
  const second = await reader.read();
  assert.deepEqual(Buffer.from(second.value), pcmB);
  assert.equal((await reader.read()).done, true);
});

test('stream pcm forwards declared sample-rate and format headers', async (t) => {
  const f = await fixture(t, (_req, res) => res.end(pcmA));
  const response = await f.request({ model: 'speech', input: 'hi', stream: true, response_format: 'pcm' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /audio\/pcm/i);
  assert.equal(response.headers.get('x-audio-sample-rate'), '24000');
  assert.equal(response.headers.get('x-audio-format'), 'pcm_s16le');
  assert.equal(response.headers.get('x-audio-channels'), '1');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pcmA);
});

test('stream request for a non-pcm format falls back to buffered wav', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, (_req, res) => res.end(wavBytes));
  const response = await f.request({ model: 'speech', input: 'hi', stream: true, response_format: 'wav' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wavBytes);
  // Not forwarded as a stream request to the backend.
  assert.notEqual(f.calls.at(-1).body.stream, true);
});

test('stream auth errors and wrong kinds are preserved as JSON', async (t) => {
  const f = await fixture(t, (_req, res) => res.end(pcmA));
  const wrongKind = await f.request({ model: 'chat', input: 'hi', stream: true, response_format: 'pcm' });
  assert.equal(wrongKind.status, 400);
  assert.equal((await wrongKind.json()).error.code, 'wrong_model_kind');
  const unknown = await f.request({ model: 'nope', input: 'hi', stream: true, response_format: 'pcm' });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, 'unknown_model');
  assert.equal(f.calls.length, 0);
});

test('upstream validation error surfaces as buffered JSON, not a truncated stream', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'stream=true requires response_format=pcm', code: 'unsupported_stream_format' }
      })
    );
  });
  const response = await f.request({ model: 'speech', input: 'hi', stream: true, response_format: 'pcm' });
  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal((await response.json()).error.code, 'unsupported_stream_format');
});

test('client cancellation aborts the upstream stream', { timeout: 5000 }, async (t) => {
  let closed;
  const upstreamClosed = new Promise((resolve) => {
    closed = resolve;
  });
  const f = await fixture(t, (_req, res) => {
    res.on('close', closed);
    res.write(pcmA);
  });
  const controller = new AbortController();
  const response = await f.request(
    { model: 'speech', input: 'hi', stream: true, response_format: 'pcm' },
    { signal: controller.signal }
  );
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await upstreamClosed;
});

test('malformed stream JSON is rejected before reaching the backend', async (t) => {
  const f = await fixture(t, (_req, res) => res.end(pcmA));
  const response = await fetch(f.gateway + '/v1/audio/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json'
  });
  assert.ok(response.status >= 400);
  await response.arrayBuffer();
  assert.equal(f.calls.length, 0);
});

test('multipart pcm speech streams before completion', { timeout: 5000 }, async (t) => {
  let finish;
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, {
      'content-type': 'audio/pcm; rate=24000; channels=1',
      'x-audio-format': 'pcm_s16le'
    });
    res.write(pcmA);
    finish = () => res.end(pcmB);
  });
  const form = new FormData();
  form.set('model', 'speech');
  form.set('input', 'hello');
  form.set('response_format', 'pcm');
  form.set('stream', 'true');
  const response = await fetch(f.gateway + '/v1/audio/speech', { method: 'POST', body: form });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.deepEqual(Buffer.from(first.value), pcmA);
  finish();
  assert.deepEqual(Buffer.from((await reader.read()).value), pcmB);
});

test('multipart wav speech stays buffered', async (t) => {
  const f = await fixture(t, (_req, res) => res.end(wavBytes));
  const form = new FormData();
  form.set('model', 'speech');
  form.set('input', 'hello');
  form.set('response_format', 'wav');
  form.set('stream', 'true');
  const response = await fetch(f.gateway + '/v1/audio/speech', { method: 'POST', body: form });
  assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wavBytes);
});

test('named profile embeds only its bounded server-owned reference for container backends', async (t) => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'synthetic');
  await fs.mkdir(directory);
  const reference = Buffer.from('synthetic-reference-bytes');
  await fs.writeFile(path.join(directory, 'reference.wav'), reference);
  await fs.writeFile(
    path.join(directory, 'profile.json'),
    JSON.stringify({
      id: 'synthetic',
      name: 'Synthetic',
      kind: 'voice_clone',
      model: 'speech',
      refAudio: 'reference.wav',
      refText: 'Synthetic reference'
    })
  );
  const f = await fixture(t, (_req, res) => res.end(pcmA));
  f.config.paths = { voicesRoot: root };
  const response = await f.request({ voice: 'synthetic', input: 'hello', stream: true, response_format: 'pcm' });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(f.calls.at(-1).body.ref_audio, 'data:audio/wav;base64,' + reference.toString('base64'));
  const supplied = '/untrusted/client/supplied.wav';
  const explicit = await f.request({ voice: 'synthetic', input: 'hello', ref_audio: supplied });
  await explicit.arrayBuffer();
  assert.equal(f.calls.at(-1).body.ref_audio, supplied, 'gateway must not open caller paths');
});

test('partial binary upstream failure does not append SSE error bytes', async (t) => {
  const f = await fixture(t, (_req, res) => {
    res.write(pcmA);
    setTimeout(() => res.destroy(), 30);
  });
  const response = await f.request({ model: 'speech', input: 'hello', stream: true, response_format: 'pcm' });
  const reader = response.body.getReader();
  assert.deepEqual(Buffer.from((await reader.read()).value), pcmA);
  await assert.rejects(reader.read());
});
