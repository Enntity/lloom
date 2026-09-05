import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { isFederatedGatewayBackend, materializeFederatedNodes } from '../src/cluster.mjs';
import { RuntimeManager } from '../src/runtime-manager.mjs';
import { createLloomServer } from '../src/server.mjs';

const logger = { error() {}, warn() {} };
async function waitFor(predicate, label, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, { holdStream = false, providerStatus = 200, rawFallback = false } = {}) {
  const hits = [];
  const fallbackHits = [];
  const streamResponses = [];
  const aborts = [];
  const releases = [];
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = req.headers['content-type']?.includes('application/json') ? JSON.parse(raw) : {};
    hits.push({ headers: req.headers, body, raw, path: req.url });
    if (providerStatus !== 200) {
      res.writeHead(providerStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'synthetic unavailable provider' } }));
      return;
    }
    if (req.url === '/v1/chat/completions' && body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'chat', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello.' }, finish_reason: null }] })}\n\n`
      );
      if (holdStream) {
        streamResponses.push(res);
        return;
      }
      res.end('data: [DONE]\n\n');
    } else if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'fixture',
          object: 'chat.completion',
          model: 'chat',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }]
        })
      );
    } else if (req.url === '/v1/audio/speech') {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end('synthetic audio');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          req.url === '/v1/embeddings'
            ? { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [1, 0] }] }
            : { text: 'Hello.' }
        )
      );
    }
  });
  const providerUrl = await listen(provider);
  const fallback = rawFallback
    ? http.createServer((req, res) => {
        req.resume();
        fallbackHits.push(req.headers);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0, 1] }] }));
      })
    : null;
  const fallbackUrl = fallback ? await listen(fallback) : null;
  const config = {
    name: 'federated-priority-serving',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: false, apiKeys: ['serving-fixture-key'] },
    logging: { metricsPersistence: false },
    defaults: { chatModel: 'chat', embeddingModel: 'memory' },
    backends: { provider: { type: 'openai', baseUrl: `${providerUrl}/v1`, apiKey: 'provider-fixture-key' } },
    models: [
      { id: 'memory', kind: 'embedding' },
      { id: 'chat', kind: 'chat' },
      { id: 'speech', kind: 'audio_speech' },
      { id: 'transcription', kind: 'audio_transcription' }
    ].map((model) => ({ ...model, backend: 'provider', runtime: 'limited', upstreamModel: model.id })),
    runtimes: { limited: { enabled: true, maxConcurrency: 2, interactiveReservedSlots: 1 } }
  };
  const manager = new RuntimeManager(config, { logger });
  // Serving process lifecycle is explicitly outside this synthetic queue test.
  manager.isHealthy = async () => true;
  const serving = createLloomServer(config, { runtimeManager: manager, logger });
  const servingUrl = await listen(serving.server);
  const frontConfig = {
    name: 'federated-priority-front',
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: false, apiKeys: ['front-fixture-key'] },
    logging: { metricsPersistence: false },
    cluster: {
      nodeId: 'front',
      nodes: {
        serving: {
          endpoint: servingUrl,
          proxy: { backend: 'serving-gateway', models: config.models.map(({ id, kind }) => ({ id, kind })) }
        }
      }
    },
    backends: { 'serving-gateway': { type: 'openai', baseUrl: `${servingUrl}/v1`, apiKey: 'serving-fixture-key' } },
    runtimes: {},
    models: []
  };
  materializeFederatedNodes(frontConfig);
  if (fallback) {
    frontConfig.backends.fallback = { type: 'openai', baseUrl: `${fallbackUrl}/v1`, apiKey: 'fallback-fixture-key' };
    frontConfig.models.push({ id: 'fallback-memory', kind: 'embedding', backend: 'fallback', upstreamModel: 'memory' });
    frontConfig.aliases = { 'serving/memory': { members: ['serving/memory', 'fallback-memory'] } };
  }
  const front = createLloomServer(frontConfig, { logger });
  const frontUrl = await listen(front.server);
  t.after(async () => {
    aborts.forEach((controller) => controller.abort());
    releases.forEach((release) => release());
    streamResponses.forEach((response) => response.end());
    await front.close({ stopRuntimes: false });
    await serving.close({ stopRuntimes: false });
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    if (fallback) {
      fallback.closeAllConnections();
      await new Promise((resolve) => fallback.close(resolve));
    }
  });
  return {
    hits,
    fallbackHits,
    streamClosed: () => streamResponses.length > 0 && streamResponses.every((response) => response.destroyed),
    manager,
    front,
    serving,
    frontConfig,
    async holdBackground() {
      const release = await manager.acquireSlot('limited');
      releases.push(release);
      return release;
    },
    request({
      route = '/v1/embeddings',
      model = 'memory',
      body = {},
      requestClass = 'interactive',
      auth = 'front-fixture-key',
      multipart = false
    } = {}) {
      const controller = new AbortController();
      aborts.push(controller);
      let payload;
      if (multipart) {
        payload = new FormData();
        payload.set('model', `serving/${model}`);
        payload.set('file', new Blob(['synthetic recording'], { type: 'audio/wav' }), 'recording.wav');
      } else payload = JSON.stringify({ model: `serving/${model}`, input: ['synthetic recall'], ...body });
      const response = fetch(`${frontUrl}${route}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${auth}`,
          'x-lloom-request-class': requestClass,
          ...(!multipart ? { 'content-type': 'application/json' } : {})
        },
        body: payload
      });
      response.catch(() => {});
      return { response, controller };
    }
  };
}

const pathways = [
  ['embeddings', {}],
  [
    'buffered chat',
    { route: '/v1/chat/completions', model: 'chat', body: { messages: [{ role: 'user', content: 'Hello' }] } }
  ],
  [
    'streamed chat',
    {
      route: '/v1/chat/completions',
      model: 'chat',
      body: { stream: true, messages: [{ role: 'user', content: 'Hello' }] }
    }
  ],
  ['Responses', { route: '/v1/responses', model: 'chat', body: { input: 'Hello' } }],
  [
    'Anthropic',
    { route: '/v1/messages', model: 'chat', body: { max_tokens: 32, messages: [{ role: 'user', content: 'Hello' }] } }
  ],
  ['speech', { route: '/v1/audio/speech', model: 'speech', body: { input: 'Hello', voice: 'alloy' } }],
  ['multipart transcription', { route: '/v1/audio/transcriptions', model: 'transcription', multipart: true }]
];
for (const [name, pathway] of pathways) {
  test(
    `federated ${name} uses serving-node reserved capacity without forwarding provider credentials`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t);
      const release = await f.holdBackground();
      const standard = f.request({ requestClass: 'standard' });
      await waitFor(() => f.manager.stateFor('limited').queuedRequests === 1, 'standard request at serving queue');
      const interactive = f.request(pathway);
      await waitFor(() => f.hits.length === 1, 'interactive provider request while background remains queued');
      const response = await interactive.response;
      assert.equal(response.status, 200, await response.clone().text());
      assert.ok((await response.text()).length > 0);
      assert.equal(f.manager.stateFor('limited').queuedRequests, 1);
      await waitFor(() => f.serving.metrics.snapshot().recent.length === 1, 'serving completion metrics');
      assert.equal(f.serving.metrics.snapshot().recent[0].requestClass, 'interactive');
      assert.equal(f.hits[0].headers.authorization, 'Bearer provider-fixture-key');
      assert.equal(f.hits[0].headers['x-lloom-request-class'], undefined);
      release();
      assert.equal((await standard.response).status, 200);
    }
  );
}

test('canceling a federated queued request removes it at the serving gateway', { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  await f.holdBackground();
  const interactiveRelease = await f.manager.acquireSlot('limited', { requestClass: 'interactive' });
  t.after(interactiveRelease);
  const pending = f.request();
  await waitFor(() => f.manager.stateFor('limited').queuedRequests === 1, 'interactive request queued');
  pending.controller.abort();
  await assert.rejects(pending.response, { name: 'AbortError' });
  await waitFor(() => f.manager.stateFor('limited').queuedRequests === 0, 'cancellation reaching serving queue');
  assert.equal(f.hits.length, 0);
  assert.equal(f.manager.stateFor('limited').activeInteractiveRequests, 1);
});

test(
  'canceling a federated stream releases its interactive slot and upstream connection',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { holdStream: true });
    await f.holdBackground();
    const pending = f.request({
      route: '/v1/chat/completions',
      model: 'chat',
      body: { stream: true, messages: [{ role: 'user', content: 'Hello' }] }
    });
    const response = await pending.response;
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /Hello/);
    assert.equal(f.manager.stateFor('limited').activeInteractiveRequests, 1);
    pending.controller.abort();
    await waitFor(
      () => f.manager.stateFor('limited').activeInteractiveRequests === 0,
      'stream cancellation releasing capacity'
    );
    assert.equal(f.manager.stateFor('limited').activeRequests, 1);
    await waitFor(f.streamClosed, 'upstream stream connection closed');
  }
);

test('federated failover recalculates forwarding for the selected raw provider', { timeout: 10000 }, async (t) => {
  const f = await fixture(t, { providerStatus: 503, rawFallback: true });
  const response = await f.request().response;
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data[0].embedding, [0, 1]);
  assert.equal(f.hits.length, 1);
  assert.equal(f.fallbackHits.length, 1);
  assert.equal(f.fallbackHits[0].authorization, 'Bearer fallback-fixture-key');
  assert.equal(f.fallbackHits[0]['x-lloom-request-class'], undefined);
  assert.equal(f.serving.metrics.snapshot().recent[0].requestClass, 'interactive');
});

test(
  'priority cannot bypass federation authentication and unknown classes stay standard',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const denied = await f.request({ auth: 'invalid' }).response;
    assert.equal(denied.status, 401);
    assert.equal(f.hits.length, 0);
    const release = await f.holdBackground();
    const unknown = f.request({ requestClass: 'interactive, urgent' });
    await waitFor(() => f.manager.stateFor('limited').queuedRequests === 1, 'unknown class waiting as standard');
    assert.equal(f.hits.length, 0);
    release();
    assert.equal((await unknown.response).status, 200);
    await waitFor(() => f.serving.metrics.snapshot().recent.length === 1, 'unknown class completion');
    assert.equal(f.serving.metrics.snapshot().recent[0].requestClass, 'standard');
  }
);

test('only explicit enabled inference proxies identify gateway backends', () => {
  const config = {
    cluster: {
      nodes: {
        mac: { endpoint: 'http://mac.invalid', proxy: { models: ['embed'] } },
        other: { endpoint: 'http://other.invalid', proxy: { backend: 'custom', models: ['chat'] } },
        raw: { endpoint: 'http://raw.invalid' },
        disabled: { endpoint: 'http://disabled.invalid', proxy: { enabled: false, models: ['chat'] } }
      }
    }
  };
  assert.equal(isFederatedGatewayBackend(config, 'lloom-node-mac'), true);
  assert.equal(isFederatedGatewayBackend(config, 'custom'), true);
  assert.equal(isFederatedGatewayBackend(config, 'lloom-node-raw'), false);
  assert.equal(isFederatedGatewayBackend(config, 'lloom-node-disabled'), false);
  assert.equal(isFederatedGatewayBackend(config, 'provider'), false);
});
