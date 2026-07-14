import assert from 'node:assert/strict';
import http from 'node:http';
import { createLloomServer } from '../src/server.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Upstream dies after opening an SSE stream: gateway must not crash, must end response.
{
  let upstreamSockets = 0;
  const upstream = http.createServer((req, res) => {
    upstreamSockets += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({
        id: 'chunk1',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }]
      })}\n\n`
    );
    // Kill the connection mid-stream (simulates Metal/backend abort).
    setTimeout(() => {
      res.destroy();
    }, 20);
  });
  const upPort = await listen(upstream);

  const config = {
    name: 'resilience-test',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    defaults: { chatModel: 'test-model' },
    backends: {
      local: {
        type: 'openai',
        baseUrl: `http://127.0.0.1:${upPort}/v1`,
        timeoutMs: 5000
      }
    },
    models: [
      {
        id: 'test-model',
        backend: 'local',
        upstreamModel: 'upstream-model',
        kind: 'chat',
        contextWindow: 8192,
        maxPromptTokens: 1000
      }
    ],
    runtimes: {}
  };

  const app = createLloomServer(config, { logger: { error() {}, warn() {} } });
  const port = await listen(app.server);

  // Prompt-too-large rejected cleanly
  const tooBig = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'x'.repeat(20000) }],
      max_tokens: 8
    })
  });
  assert.equal(tooBig.status, 400);
  const tooBigJson = await tooBig.json();
  assert.equal(tooBigJson.error.code, 'prompt_too_large');

  // Mid-stream upstream death should not kill the process; client gets a finished stream.
  const streamRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: true
    })
  });
  assert.equal(streamRes.status, 200);
  const text = await streamRes.text();
  assert(text.includes('data:'), 'expected SSE payload');
  // Gateway stays healthy afterward.
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal(upstreamSockets >= 1, true);

  await close(app.server);
  await close(upstream);
}

console.log('server-resilience tests passed');

// Gateway shutdown can leave managed runtimes alive for a fast service upgrade.
{
  let stopAllCalls = 0;
  const runtimeManager = {
    startKeepWarm: async () => {},
    stopAll: async () => { stopAllCalls += 1; }
  };
  const config = {
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    defaults: {}, backends: {}, models: [], runtimes: {}
  };
  const app = createLloomServer(config, { runtimeManager, logger: { error() {}, warn() {} } });
  await app.listen();
  await app.close({ stopRuntimes: false });
  assert.equal(stopAllCalls, 0);
}
