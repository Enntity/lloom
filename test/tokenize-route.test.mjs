import assert from 'node:assert/strict';
import http from 'node:http';
import { createLloomServer } from '../src/server.mjs';

// `/v1/tokenize` exists so an exact-count client can ask the backend that will
// actually serve a request how many tokens that request renders to. The gateway
// must therefore forward the body untouched (bar the upstream model name) and
// return the backend's own answer rather than re-deriving a count.

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function harness({ status = 200, baseUrlSuffix = '/v1' } = {}) {
  const state = { seen: [] };
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    state.seen.push({ url: req.url, method: req.method, body: JSON.parse(raw || '{}') });
    if (status !== 200) {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `backend status ${status}` } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tokens: [11, 22, 33], count: 3 }));
  });
  const upstreamPort = await listen(upstream);
  const config = {
    name: 'tokenize-test',
    server: { host: '127.0.0.1', port: 0, inferenceEnabled: true },
    security: { allowMissingAuth: true, apiKeys: [] },
    logging: { metricsPersistence: false },
    cluster: { routingStatusCacheMs: 0 },
    defaults: { chatModel: 'atlas-chat' },
    backends: {
      atlas: { type: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}${baseUrlSuffix}`, timeoutMs: 5000 }
    },
    models: [
      {
        id: 'atlas-chat',
        kind: 'chat',
        backend: 'atlas',
        upstreamModel: 'glm-5.3-flash-atlas',
        contextWindow: 262144,
        maxOutputTokens: 131072
      }
    ]
  };
  const app = createLloomServer(config, { logger: { error() {}, warn() {} } });
  const port = await listen(app.server);
  return {
    state,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await close(app.server);
      await close(upstream);
    }
  };
}

{
  const context = await harness();
  try {
    const messages = [{ role: 'user', content: 'hello world' }];
    const response = await postJson(`${context.base}/v1/tokenize`, {
      model: 'atlas-chat',
      messages,
      chat_template_kwargs: { thinking: false, enable_thinking: false }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { tokens: [11, 22, 33], count: 3 });

    assert.equal(context.state.seen.length, 1);
    // The Atlas engine serves token counting at the bare `/tokenize` while its
    // OpenAI surface lives under `/v1`. The backend baseUrl already ends in
    // `/v1`, so the handler resolves the backend origin explicitly; routing this
    // through the ordinary baseUrl join would request `/v1/tokenize` and 404.
    assert.equal(context.state.seen[0].url, '/tokenize');
    assert.equal(context.state.seen[0].method, 'POST');
    // The upstream model replaces the requested id, and the template kwargs are
    // preserved: changing them would change the very count being reported.
    assert.equal(context.state.seen[0].body.model, 'glm-5.3-flash-atlas');
    assert.deepEqual(context.state.seen[0].body.messages, messages);
    assert.deepEqual(context.state.seen[0].body.chat_template_kwargs, {
      thinking: false,
      enable_thinking: false
    });
  } finally {
    await context.close();
  }
}

{
  // A raw `prompt` is the other accepted input and must reach the backend too.
  const context = await harness();
  try {
    const response = await postJson(`${context.base}/v1/tokenize`, {
      model: 'atlas-chat',
      prompt: 'count me'
    });
    assert.equal(response.status, 200);
    assert.equal(context.state.seen[0].body.prompt, 'count me');
  } finally {
    await context.close();
  }
}

{
  // A baseUrl without `/v1` resolves to the same bare route.
  const context = await harness({ baseUrlSuffix: '' });
  try {
    const response = await postJson(`${context.base}/v1/tokenize`, {
      model: 'atlas-chat',
      prompt: 'count me'
    });
    assert.equal(response.status, 200);
    assert.equal(context.state.seen[0].url, '/tokenize');
  } finally {
    await context.close();
  }
}

{
  // A baseUrl with a deeper path still resolves to the backend's origin route
  // rather than inheriting that prefix.
  const context = await harness({ baseUrlSuffix: '/v1/openai' });
  try {
    const response = await postJson(`${context.base}/v1/tokenize`, {
      model: 'atlas-chat',
      prompt: 'count me'
    });
    assert.equal(response.status, 200);
    assert.equal(context.state.seen[0].url, '/tokenize');
  } finally {
    await context.close();
  }
}

{
  // Neither input is a client error, and must not reach the backend.
  const context = await harness();
  try {
    const response = await postJson(`${context.base}/v1/tokenize`, { model: 'atlas-chat' });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'missing_input');
    assert.equal(context.state.seen.length, 0);
  } finally {
    await context.close();
  }
}

{
  // An unresolvable model is a client error, not a silent pass-through.
  const context = await harness();
  try {
    const response = await postJson(`${context.base}/v1/tokenize`, {
      model: 'no-such-model',
      prompt: 'x'
    });
    assert.ok(response.status >= 400, `expected a client error, got ${response.status}`);
    assert.equal(context.state.seen.length, 0);
  } finally {
    await context.close();
  }
}

{
  // A backend rejection reaches the client with the backend's own status.
  const context = await harness({ status: 400 });
  try {
    const response = await postJson(`${context.base}/v1/tokenize`, { model: 'atlas-chat', prompt: 'x' });
    assert.equal(response.status, 400);
  } finally {
    await context.close();
  }
}

console.log('tokenize route tests passed');
