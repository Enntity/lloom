import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createRegistry } from '../src/registry.mjs';
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

function completion(model, content = 'ok') {
  return JSON.stringify({
    id: `completion-${model}`,
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  });
}

async function createFixture({ primaryStatus = 503, runtimeStatus = 'running' } = {}) {
  const hits = { primary: 0, cloud: 0, ensures: 0 };
  const primary = http.createServer((_req, res) => {
    hits.primary += 1;
    const body =
      primaryStatus === 200
        ? completion('local-upstream', 'local')
        : JSON.stringify({ error: { message: `primary status ${primaryStatus}` } });
    res.writeHead(primaryStatus, { 'content-type': 'application/json' });
    res.end(body);
  });
  const cloud = http.createServer(async (req, res) => {
    hits.cloud += 1;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw || '{}');
    if (request.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          id: 'cloud-stream',
          object: 'chat.completion.chunk',
          model: 'cloud-upstream',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'cloud' }, finish_reason: null }]
        })}\n\n`
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    const body = completion('cloud-upstream', 'cloud');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  });
  const primaryPort = await listen(primary);
  const cloudPort = await listen(cloud);
  const config = {
    name: 'model-failover-test',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    logging: { metricsPersistence: false },
    cluster: { routingStatusCacheMs: 0 },
    defaults: { chatModel: 'stable-chat' },
    aliases: {
      'stable-chat': {
        target: 'stable-chat',
        fallbacks: ['cloud-chat'],
        advertise: false
      }
    },
    backends: {
      primary: { type: 'openai', baseUrl: `http://127.0.0.1:${primaryPort}/v1`, timeoutMs: 5000 },
      cloud: { type: 'openai', baseUrl: `http://127.0.0.1:${cloudPort}/v1`, timeoutMs: 5000 }
    },
    models: [
      {
        id: 'stable-chat',
        kind: 'chat',
        backend: 'primary',
        runtime: 'primary-runtime',
        upstreamModel: 'local-upstream',
        contextWindow: 8192,
        maxOutputTokens: 1024
      },
      {
        id: 'cloud-chat',
        kind: 'chat',
        backend: 'cloud',
        upstreamModel: 'cloud-upstream',
        contextWindow: 8192,
        maxOutputTokens: 1024
      }
    ],
    runtimes: { 'primary-runtime': { enabled: true } }
  };
  const runtimeManager = {
    ensure: async () => {
      hits.ensures += 1;
      return { healthy: true };
    },
    withSlot: async (_runtimeId, fn) => fn(),
    noteRequestOutcome() {},
    async status() {
      return {
        runtimes: {
          'primary-runtime': { status: runtimeStatus, healthy: runtimeStatus === 'running' }
        }
      };
    }
  };
  const logs = [];
  const app = createLloomServer(config, {
    runtimeManager,
    logger: {
      error() {},
      warn(message) {
        logs.push(message);
      }
    }
  });
  const gatewayPort = await listen(app.server);
  return {
    app,
    hits,
    logs,
    url: `http://127.0.0.1:${gatewayPort}`,
    async close() {
      await close(app.server);
      await close(primary);
      await close(cloud);
    }
  };
}

async function chat(url, body = {}) {
  return fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'stable-chat',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 8,
      ...body
    })
  });
}

// Alias chains resolve in order, including an alias that intentionally shadows
// its primary model ID.
{
  const registry = createRegistry({
    aliases: { local: { target: 'local', fallbacks: ['cloud'] } },
    backends: { local: {}, cloud: {} },
    runtimes: { local: { enabled: true } },
    models: [
      { id: 'local', backend: 'local', runtime: 'local', kind: 'chat' },
      { id: 'cloud', backend: 'cloud', kind: 'chat' }
    ]
  });
  assert.deepEqual(
    registry.resolveCandidates('local').map((candidate) => candidate.resolvedId),
    ['local', 'cloud']
  );
  assert.equal(registry.catalogModels({ includeAliases: true }).filter((model) => model.id === 'local').length, 1);
}

// Config validation catches unknown, duplicate, and cross-kind fallback targets.
{
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lloom-alias-validation-'));
  const configPath = path.join(directory, 'config.json');
  const base = {
    backends: { chat: { baseUrl: 'http://127.0.0.1:1/v1' }, image: { baseUrl: 'http://127.0.0.1:2/v1' } },
    models: [
      { id: 'chat', kind: 'chat', backend: 'chat' },
      { id: 'image', kind: 'image', backend: 'image' }
    ],
    aliases: { stable: { target: 'chat', fallbacks: ['missing'] } }
  };
  await writeFile(configPath, JSON.stringify(base));
  await assert.rejects(loadConfig(configPath), /targets unknown model missing/);
  base.aliases.stable.fallbacks = ['chat'];
  await writeFile(configPath, JSON.stringify(base));
  await assert.rejects(loadConfig(configPath), /has duplicate targets/);
  base.aliases.stable.fallbacks = ['image'];
  await writeFile(configPath, JSON.stringify(base));
  await assert.rejects(loadConfig(configPath), /models with different kinds/);
  await rm(directory, { recursive: true, force: true });
}

// A retryable primary response fails over, while preserving the requested alias
// in the OpenAI response and recording both attempts.
{
  const fixture = await createFixture({ primaryStatus: 503 });
  const response = await chat(fixture.url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, 'stable-chat');
  assert.equal(body.choices[0].message.content, 'cloud');
  assert.deepEqual(fixture.hits, { primary: 1, cloud: 1, ensures: 1 });
  const recent = fixture.app.metrics.snapshot().recent;
  assert.equal(recent.length, 2);
  assert.equal(recent[0].resolvedModel, 'stable-chat');
  assert.equal(recent[0].status, 503);
  assert.equal(recent[1].resolvedModel, 'cloud-chat');
  assert.equal(recent[1].failedOver, true);
  assert(fixture.logs.some((line) => line.includes('stable-chat -> cloud-chat')));
  await fixture.close();
}

// Streaming may change targets only before gateway headers or content are sent.
{
  const fixture = await createFixture({ primaryStatus: 503 });
  const response = await chat(fixture.url, { stream: true });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert(text.includes('"model":"stable-chat"'));
  assert(text.includes('"content":"cloud"'));
  assert.deepEqual(fixture.hits, { primary: 1, cloud: 1, ensures: 1 });
  await fixture.close();
}

// The same alias chain is honored by the Responses and Anthropic bridges.
{
  const fixture = await createFixture({ primaryStatus: 503 });
  const responses = await fetch(`${fixture.url}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'stable-chat', input: 'hello', max_output_tokens: 8 })
  });
  assert.equal(responses.status, 200);
  const responsesBody = await responses.json();
  assert.equal(responsesBody.model, 'stable-chat');
  assert.deepEqual(fixture.hits, { primary: 1, cloud: 1, ensures: 1 });
  await fixture.close();
}

{
  const fixture = await createFixture({ primaryStatus: 503 });
  const messages = await fetch(`${fixture.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'stable-chat',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 8
    })
  });
  assert.equal(messages.status, 200);
  const messagesBody = await messages.json();
  assert.equal(messagesBody.model, 'stable-chat');
  assert.deepEqual(fixture.hits, { primary: 1, cloud: 1, ensures: 1 });
  await fixture.close();
}

// Ordinary request errors are returned from the primary without trying cloud.
{
  const fixture = await createFixture({ primaryStatus: 400 });
  const response = await chat(fixture.url);
  assert.equal(response.status, 400);
  assert.deepEqual(fixture.hits, { primary: 1, cloud: 0, ensures: 1 });
  await fixture.close();
}

// New work bypasses a runtime that LLooM already knows is upgrading/warming.
{
  const fixture = await createFixture({ primaryStatus: 200, runtimeStatus: 'warming' });
  const response = await chat(fixture.url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'cloud');
  assert.deepEqual(fixture.hits, { primary: 0, cloud: 1, ensures: 0 });
  assert(fixture.logs.some((line) => line.includes('is warming')));
  await fixture.close();
}

console.log('model failover tests passed');
