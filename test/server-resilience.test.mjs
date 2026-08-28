import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createLloomServer, estimateRequestPromptTokens, retryRuntimeActionAfterConfigReload } from '../src/server.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// A recipe/profile reload may supersede an overlapping admin start. Wait for
// that reconciliation and retry once instead of reporting a false failure
// while the backend continues cycling in the background.
{
  const events = [];
  let attempts = 0;
  const result = await retryRuntimeActionAfterConfigReload(
    async () => {
      attempts += 1;
      events.push(`start:${attempts}`);
      if (attempts === 1) throw new Error('lifecycle superseded by config reload');
      return { started: true, healthy: true };
    },
    async () => {
      events.push('reload');
    }
  );
  assert.deepEqual(result, { started: true, healthy: true });
  assert.deepEqual(events, ['start:1', 'reload', 'start:2']);

  await assert.rejects(
    retryRuntimeActionAfterConfigReload(
      async () => {
        throw new Error('backend failed');
      },
      async () => {
        throw new Error('reload should not run');
      }
    ),
    /backend failed/
  );
}

// Prompt admission counts visual tokens, not opaque base64 bytes.
{
  const encoded = 'a'.repeat(2_000_000);
  const chatEstimate = estimateRequestPromptTokens({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${encoded}`, detail: 'high' } },
          { type: 'text', text: 'Describe this image.' }
        ]
      }
    ]
  });
  assert(chatEstimate >= 4096 && chatEstimate < 5000);

  const responsesEstimate = estimateRequestPromptTokens({
    input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${encoded}` }] }]
  });
  assert.equal(responsesEstimate, 4096);

  const anthropicEstimate = estimateRequestPromptTokens({
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: encoded } }]
      }
    ]
  });
  assert.equal(anthropicEstimate, 4096);
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
  assert.equal(app.server.requestTimeout, 0, 'gateway must defer inference deadlines to the backend contract');
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

// Completed model requests feed runtime-scoped evidence to the watchdog hook.
{
  const upstream = http.createServer((_req, res) => {
    const body = JSON.stringify({
      id: 'completion-1',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  const upstreamPort = await listen(upstream);
  const outcomes = [];
  const runtimeManager = {
    ensure: async () => ({ healthy: true }),
    withSlot: async (_runtimeId, fn) => fn(),
    noteRequestOutcome(runtimeId, outcome) {
      outcomes.push({ runtimeId, outcome });
    }
  };
  const config = {
    name: 'watchdog-observation-test',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    defaults: { chatModel: 'test-model' },
    backends: {
      local: {
        type: 'openai',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        timeoutMs: 5000
      }
    },
    models: [
      {
        id: 'test-model',
        backend: 'local',
        upstreamModel: 'upstream-model',
        runtime: 'test-runtime',
        kind: 'chat',
        contextWindow: 8192,
        maxPromptTokens: 1000
      }
    ],
    runtimes: {
      'test-runtime': { enabled: true }
    }
  };
  const app = createLloomServer(config, { runtimeManager, logger: { error() {}, warn() {} } });
  const port = await listen(app.server);
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 8
    })
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].runtimeId, 'test-runtime');
  assert.equal(outcomes[0].outcome.ok, true);
  assert(outcomes[0].outcome.responseBytes > 0);

  await close(app.server);
  await close(upstream);
}

// An admitted streaming request that produces no bytes is reported before the
// backend's much longer transport timeout, so a runtime watchdog can recover a
// livelock.
{
  const upstream = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          id: 'completion-stalled',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }]
        })}\n\n`
      );
      res.end('data: [DONE]\n\n');
    }, 80);
  });
  const upstreamPort = await listen(upstream);
  const outcomes = [];
  const runtimeManager = {
    ensure: async () => ({ healthy: true }),
    withSlot: async (_runtimeId, fn) => fn(),
    noteRequestOutcome(runtimeId, outcome) {
      outcomes.push({ runtimeId, outcome });
    }
  };
  const config = {
    name: 'watchdog-live-stall-test',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    defaults: { chatModel: 'test-model' },
    backends: { local: { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, timeoutMs: 5000 } },
    models: [
      {
        id: 'test-model',
        backend: 'local',
        upstreamModel: 'upstream-model',
        runtime: 'test-runtime',
        kind: 'chat',
        contextWindow: 8192,
        maxPromptTokens: 1000
      }
    ],
    runtimes: {
      'test-runtime': {
        enabled: true,
        watchdog: { enabled: true, failureThreshold: 1, minNoProgressMs: 30 }
      }
    }
  };
  const app = createLloomServer(config, { runtimeManager, logger: { error() {}, warn() {} } });
  const port = await listen(app.server);
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 8,
      stream: true
    })
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(
    outcomes.some(({ outcome }) => outcome.stalled === true && outcome.status === 504),
    true
  );
  assert.equal(outcomes.at(-1).outcome.ok, true);

  await close(app.server);
  await close(upstream);
}

// LLooM owns structured-output backend translation for both public text protocols.
{
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    requests.push(request);
    const body = JSON.stringify({
      id: `completion-${requests.length}`,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: request.tools
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    type: 'function',
                    function: { name: 'answer', arguments: '{"answer":"ok"}' }
                  }
                ]
              }
            : { role: 'assistant', content: '{"answer":"ok"}' },
          finish_reason: request.tools ? 'tool_calls' : 'stop'
        }
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  const upstreamPort = await listen(upstream);
  const config = {
    name: 'structured-output-test',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    defaults: { chatModel: 'test-model' },
    backends: {
      local: {
        type: 'openai',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        timeoutMs: 5000,
        structuredOutput: { requireParameters: true }
      }
    },
    models: [
      {
        id: 'test-model',
        backend: 'local',
        upstreamModel: 'upstream-model',
        kind: 'chat',
        supportsTools: true,
        capabilities: ['chat', 'tools'],
        contextWindow: 8192,
        maxPromptTokens: 1000
      }
    ],
    runtimes: {}
  };
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { answer: { type: 'string' } },
    required: ['answer']
  };
  const app = createLloomServer(config, { logger: { error() {}, warn() {} } });
  const port = await listen(app.server);

  const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      lloom: { outputSchema: { name: 'answer', schema, strict: true } }
    })
  });
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).choices[0].message.content, '{"answer":"ok"}');

  const responses = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      input: 'hello',
      lloom: { outputSchema: { name: 'answer', schema, strict: true } }
    })
  });
  assert.equal(responses.status, 200);
  assert.equal((await responses.json()).output_text, '{"answer":"ok"}');

  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.lloom, undefined);
    assert.equal(request.response_format, undefined);
    assert.equal(request.tools[0].function.name, 'answer');
    assert.deepEqual(request.tools[0].function.parameters, schema);
    assert.deepEqual(request.tool_choice, {
      type: 'function',
      function: { name: 'answer' }
    });
    assert.deepEqual(request.provider, { require_parameters: true });
  }

  const invalid = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      lloom: { outputSchema: { name: 'answer' } }
    })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'invalid_structured_output');
  assert.equal(requests.length, 2);

  await close(app.server);
  await close(upstream);
}

console.log('server-resilience tests passed');

// A validated catalog reload is visible immediately even when physical runtime
// reconciliation is still blocked on a long distributed lifecycle operation.
{
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-catalog-reload-'));
  const configPath = path.join(temporaryRoot, 'config.json');
  let finishReconfigure;
  const reconfigureBlocked = new Promise((resolve) => {
    finishReconfigure = resolve;
  });
  const runtimeManager = {
    clusterCoordinator: null,
    startKeepWarm: async () => {},
    stopAll: async () => {},
    reconfigure: async () => {
      await reconfigureBlocked;
      return { changed: [] };
    }
  };
  const base = {
    server: { host: '127.0.0.1', port: 8100 },
    security: { allowMissingAuth: true, apiKeys: [] },
    defaults: {},
    backends: { test: { type: 'openai', baseUrl: 'http://127.0.0.1:9/v1' } },
    models: [{ id: 'old-model', backend: 'test', upstreamModel: 'old-model' }],
    runtimes: {}
  };
  await fs.writeFile(configPath, `${JSON.stringify(base, null, 2)}\n`);
  const liveConfig = { ...structuredClone(base), sourcePath: configPath };
  liveConfig.server.port = 0;
  const app = createLloomServer(liveConfig, { runtimeManager, logger: { error() {}, warn() {}, info() {} } });
  await app.listen();
  const port = app.server.address().port;
  const next = {
    ...base,
    models: [
      ...base.models,
      { id: 'new-model', backend: 'test', upstreamModel: 'new-model' }
    ]
  };
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`);

  let advertised = [];
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/gateway/models`);
    const payload = await response.json();
    advertised = (payload.models ?? []).map((model) => model.id);
    if (advertised.includes('new-model')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(advertised.includes('new-model'), 'catalog reload must not wait for runtime reconciliation');
  finishReconfigure();
  await app.close({ stopRuntimes: false });
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

// Setup's authoritative keep-warm request reloads the just-written config
// before it can report health or start against the previous runtime snapshot.
{
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-keep-warm-reload-'));
  const configPath = path.join(temporaryRoot, 'config.json');
  const events = [];
  const runtimeManager = {
    clusterCoordinator: null,
    keepWarmRuntimeIds: () => ['next'],
    startKeepWarm: async () => {
      events.push('keep-warm');
      return [{ runtimeId: 'next', started: true }];
    },
    stopAll: async () => {},
    reconfigure: async () => {
      events.push('reconfigure');
      return { changed: ['next'] };
    }
  };
  const base = {
    server: { host: '127.0.0.1', port: 8100 },
    security: { allowMissingAuth: true, apiKeys: [] },
    defaults: {},
    backends: {},
    models: [],
    runtimes: {}
  };
  await fs.writeFile(configPath, `${JSON.stringify(base, null, 2)}\n`);
  const liveConfig = { ...structuredClone(base), sourcePath: configPath };
  liveConfig.server.port = 0;
  const app = createLloomServer(liveConfig, { runtimeManager, logger: { error() {}, warn() {}, info() {} } });
  await app.listen();
  events.length = 0;
  await fs.writeFile(configPath, `${JSON.stringify({ ...base, runtimes: { next: { enabled: true } } }, null, 2)}\n`);
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/gateway/runtimes/keep-warm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reloadConfig: true })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(events.slice(0, 2), ['reconfigure', 'keep-warm']);
  await app.close({ stopRuntimes: false });
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}

// Gateway shutdown can leave managed runtimes alive for a fast service upgrade.
{
  let stopAllCalls = 0;
  const runtimeManager = {
    startKeepWarm: async () => {},
    stopAll: async () => {
      stopAllCalls += 1;
    }
  };
  const config = {
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    defaults: {},
    backends: {},
    models: [],
    runtimes: {}
  };
  const app = createLloomServer(config, { runtimeManager, logger: { error() {}, warn() {} } });
  await app.listen();
  await app.close({ stopRuntimes: false });
  assert.equal(stopAllCalls, 0);
}

// An incomplete or long-lived HTTP client cannot block service shutdown forever.
{
  const runtimeManager = { startKeepWarm: async () => {}, stopAll: async () => {} };
  const config = {
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    defaults: {},
    backends: {},
    models: [],
    runtimes: {}
  };
  const app = createLloomServer(config, { runtimeManager, logger: { error() {}, warn() {} } });
  await app.listen();
  const socket = net.createConnection(app.server.address().port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\n');
  const startedAt = Date.now();
  await app.close({ stopRuntimes: false, httpGraceMs: 25 });
  assert(Date.now() - startedAt < 1000);
  socket.destroy();
}
