import assert from 'node:assert/strict';
import { Agent, MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createLloomServer } from '../src/server.mjs';
import {
  applyOpenRouterProviderPolicy,
  isOpenRouterBackend,
  normalizeOpenRouterProviderPolicy
} from '../src/protocol/openrouter-provider.mjs';

// The gateway consults this for its long-running upstream dispatcher while a
// mock session is active.
let gatewayDispatcher = null;

// ---------------------------------------------------------------------------
// Pure policy unit coverage
// ---------------------------------------------------------------------------

const openRouterBackend = (extra = {}) => ({
  id: 'openrouter-lane',
  type: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  ...extra
});

function testLookalikeHosts() {
  assert.equal(isOpenRouterBackend(openRouterBackend()), true);
  assert.equal(isOpenRouterBackend({ baseUrl: 'https://openrouter.ai/api/v1' }), true);
  for (const baseUrl of [
    'https://openrouter.ai.evil.example/api/v1',
    'https://notopenrouter.ai/api/v1',
    'https://openrouter.ai.example.com/api/v1',
    'https://api.openrouter.ai/api/v1',
    'http://127.0.0.1:8200/v1',
    'not a url',
    '',
    undefined
  ]) {
    assert.equal(isOpenRouterBackend({ baseUrl }), false, `expected lookalike to be rejected: ${baseUrl}`);
  }
}

function testNoConfigLeavesBodyUntouched() {
  const body = {
    model: 'z-ai/glm-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    provider: { order: ['together'], allow_fallbacks: true }
  };
  const frozen = JSON.parse(JSON.stringify(body));
  // No policy key at all.
  assert.equal(applyOpenRouterProviderPolicy(body, openRouterBackend()), body);
  // Policy explicitly null is "not configured", not malformed.
  assert.equal(applyOpenRouterProviderPolicy(body, openRouterBackend({ openrouterProvider: null })), body);
  // Non-OpenRouter host is untouched. A policy there is never enforced, so a
  // plain (not-openrouter) backend must not be rejected for carrying one.
  const local = { id: 'local', baseUrl: 'http://127.0.0.1:8201/v1', openrouterProvider: { only: ['z-ai'] } };
  assert.equal(applyOpenRouterProviderPolicy(body, local), body);
  assert.deepEqual(body, frozen);
}

function testValidPolicyEnforced() {
  const body = { model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'hi' }] };
  const applied = applyOpenRouterProviderPolicy(body, openRouterBackend({ openrouterProvider: { only: ['z-ai'] } }));
  assert.deepEqual(applied.provider, { only: ['z-ai'], allow_fallbacks: false });
  // Default allow_fallbacks is false (fail closed) when omitted.
  assert.equal(applied.provider.allow_fallbacks, false);
  // Original body is not mutated.
  assert.equal(body.provider, undefined);

  const explicit = applyOpenRouterProviderPolicy(
    body,
    openRouterBackend({ openrouterProvider: { only: ['z-ai', 'z-ai-intl'], allow_fallbacks: true } })
  );
  assert.deepEqual(explicit.provider, { only: ['z-ai', 'z-ai-intl'], allow_fallbacks: true });

  // Whitespace is trimmed and surrounding body fields are preserved.
  const trimmed = applyOpenRouterProviderPolicy(
    { model: 'z-ai/glm-5.2', temperature: 0.4, provider: { order: ['x'] } },
    openRouterBackend({ openrouterProvider: { only: [' z-ai '] } })
  );
  assert.deepEqual(trimmed.provider.only, ['z-ai']);
  assert.equal(trimmed.temperature, 0.4);
  // Caller provider fields survive alongside the enforced keys.
  assert.deepEqual(trimmed.provider.order, ['x']);
}

function testCallerOverrideAttemptsLose() {
  const backend = openRouterBackend({ openrouterProvider: { only: ['z-ai'], allow_fallbacks: false } });
  const cases = [
    { provider: { only: ['openai'], allow_fallbacks: true } },
    { provider: { allow_fallbacks: true } },
    { provider: { only: [] } },
    { provider: { only: ['any'] } }
  ];
  for (const extra of cases) {
    const applied = applyOpenRouterProviderPolicy({ model: 'm', messages: [], ...extra }, backend);
    assert.deepEqual(applied.provider, { only: ['z-ai'], allow_fallbacks: false }, JSON.stringify(extra));
  }

  const permissive = openRouterBackend({ openrouterProvider: { only: ['z-ai'], allow_fallbacks: true } });
  const applied = applyOpenRouterProviderPolicy({ provider: { allow_fallbacks: false } }, permissive);
  assert.deepEqual(applied.provider, { only: ['z-ai'], allow_fallbacks: true });
}

function testNonObjectBodyUntouched() {
  const backend = openRouterBackend({ openrouterProvider: { only: ['z-ai'] } });
  for (const body of [null, undefined, 'not-an-object', 42, ['array']]) {
    assert.equal(applyOpenRouterProviderPolicy(body, backend), body);
  }
}

function testMalformedPoliciesThrow() {
  const base = { id: 'openrouter-lane', baseUrl: 'https://openrouter.ai/api/v1' };
  const malformed = [
    {}, // only is required
    { only: [] },
    { only: 'z-ai' },
    { only: ['z-ai', ''] },
    { only: ['z-ai', '   '] },
    { only: [null] },
    { only: ['z-ai'], allow_fallbacks: 'no' },
    { only: ['z-ai'], allow_fallbacks: 1 },
    { only: ['z-ai'], order: ['x'] }, // unknown key
    { only: ['z-ai'], allow_fallbacks: false, ignore: ['a'] },
    { only: ['z-ai'], dataCollection: 'deny' },
    'z-ai',
    ['z-ai'],
    42
  ];
  for (const openrouterProvider of malformed) {
    assert.throws(
      () => normalizeOpenRouterProviderPolicy(openrouterProvider, { backendId: 'openrouter-lane' }),
      /openrouterProvider/,
      `expected malformed policy to throw: ${JSON.stringify(openrouterProvider)}`
    );
    assert.throws(
      () => applyOpenRouterProviderPolicy({ model: 'm' }, { ...base, openrouterProvider }),
      /openrouterProvider/,
      `expected apply to fail closed for: ${JSON.stringify(openrouterProvider)}`
    );
  }
  // No configured value (undefined/null) is not malformed.
  assert.equal(normalizeOpenRouterProviderPolicy(undefined), null);
  assert.equal(normalizeOpenRouterProviderPolicy(null), null);
}

// ---------------------------------------------------------------------------
// Gateway integration: the whole /v1/chat/completions path is exercised with a
// mocked undici dispatcher so no network or TLS egress occurs.
// ---------------------------------------------------------------------------

function gatewayConfig(backend) {
  return {
    server: { host: '127.0.0.1', port: 0 },
    security: { allowMissingAuth: true, apiKeys: [] },
    defaults: { chatModel: 'z-ai/glm-5.2' },
    backends: { 'openrouter-lane': backend },
    models: [
      {
        id: 'z-ai/glm-5.2',
        backend: 'openrouter-lane',
        upstreamModel: 'z-ai/glm-5.2',
        kind: 'chat',
        contextWindow: 200000,
        maxPromptTokens: 100000
      }
    ],
    runtimes: {}
  };
}

async function withMockedDispatcher(startGatewayFn, fn) {
  // The gateway's upstream calls go through its long-running undici Agent.
  // Undici 8 composes mocks by wrapping that agent instead of patching
  // prototypes, so the composed dispatcher is installed as the package global
  // (the package fetch consults it) and handed to the gateway explicitly.
  // Loopback stays open so client requests to the local gateway pass through.
  const previous = getGlobalDispatcher();
  const longRunningAgent = new Agent({ headersTimeout: 1800000, bodyTimeout: 1800000 });
  const mockAgent = new MockAgent({ agent: longRunningAgent });
  mockAgent.disableNetConnect();
  mockAgent.enableNetConnect(
    (host) => typeof host === 'string' && (host.startsWith('127.0.0.1') || host.startsWith('localhost'))
  );
  setGlobalDispatcher(mockAgent);
  gatewayDispatcher = mockAgent;
  try {
    await startGatewayFn();
    return await fn(mockAgent);
  } finally {
    gatewayDispatcher = null;
    setGlobalDispatcher(previous);
    await mockAgent.close();
  }
}

async function readRequestBody(body) {
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') return body;
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function intercept(mockAgent, { status = 200, contentType = 'application/json', payload, onBody }) {
  const pool = mockAgent.get('https://openrouter.ai');
  return pool.intercept({ path: '/api/v1/chat/completions', method: 'POST' }).reply(
    status,
    async (opts) => {
      onBody(await readRequestBody(opts.body));
      return payload;
    },
    { headers: { 'content-type': contentType } }
  );
}

const openAiChatPayload = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
};

const openAiStreamPayload = [
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
  '',
  'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
  ''
].join('\n');

let gatewayServer;
let gatewayPort;

async function startGateway(backend) {
  const app = createLloomServer(gatewayConfig(backend), {
    logger: { error() {}, warn() {}, info() {}, log() {} },
    upstreamDispatcher: gatewayDispatcher ?? undefined
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  gatewayServer = app.server;
  gatewayPort = app.server.address().port;
  return gatewayPort;
}

async function stopGateway() {
  if (!gatewayServer) return;
  const server = gatewayServer;
  gatewayServer = null;
  await new Promise((resolve) => server.close(resolve));
}

async function testGatewayChatBuffered() {
  const seen = [];
  try {
    await withMockedDispatcher(
      async () => startGateway(openRouterBackend({ openrouterProvider: { only: ['z-ai'], allow_fallbacks: false } })),
      async (mockAgent) => {
      intercept(mockAgent, { payload: openAiChatPayload, onBody: (body) => seen.push(body) });
      const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'z-ai/glm-5.2',
          messages: [{ role: 'user', content: 'hi' }],
          provider: { only: ['openai'], allow_fallbacks: true, order: ['x'] }
        })
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.choices[0].message.content, 'ok');
    });
    assert.equal(seen.length, 1, 'expected exactly one upstream chat call');
    const outbound = JSON.parse(seen[0]);
    // Caller override attempt is defeated; other caller provider fields survive.
    assert.deepEqual(outbound.provider, { order: ['x'], only: ['z-ai'], allow_fallbacks: false });
    assert.equal(outbound.model, 'z-ai/glm-5.2');
    assert.deepEqual(outbound.messages, [{ role: 'user', content: 'hi' }]);
  } finally {
    await stopGateway();
  }
}

async function testGatewayChatStream() {
  const seen = [];
  try {
    await withMockedDispatcher(
      async () => startGateway(openRouterBackend({ openrouterProvider: { only: ['z-ai'] } })),
      async (mockAgent) => {
      intercept(mockAgent, {
        contentType: 'text/event-stream',
        payload: openAiStreamPayload,
        onBody: (body) => seen.push(body)
      });
      const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'z-ai/glm-5.2',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true
        })
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /data: \[DONE\]/);
    });
    assert.equal(seen.length, 1);
    const outbound = JSON.parse(seen[0]);
    assert.deepEqual(outbound.provider, { only: ['z-ai'], allow_fallbacks: false });
    assert.equal(outbound.stream, true);
  } finally {
    await stopGateway();
  }
}

async function testGatewayResponsesBridge(stream = false) {
  const seen = [];
  try {
    await withMockedDispatcher(
      async () => startGateway(openRouterBackend({ openrouterProvider: { only: ['z-ai'] } })),
      async (mockAgent) => {
      intercept(mockAgent, {
        payload: stream ? openAiStreamPayload : openAiChatPayload,
        contentType: stream ? 'text/event-stream' : 'application/json',
        onBody: (body) => seen.push(body)
      });
      const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream, model: 'z-ai/glm-5.2', input: 'hi', provider: { only: ['openai'] } })
      });
      assert.equal(res.status, 200);
      if (stream) assert.match(await res.text(), /response.completed/);
      else assert.equal((await res.json()).object, 'response');
    });
    assert.equal(seen.length, 1);
    const outbound = JSON.parse(seen[0]);
    assert.deepEqual(outbound.provider, { only: ['z-ai'], allow_fallbacks: false });
  } finally {
    await stopGateway();
  }
}

async function testGatewayAnthropicBridge(stream = false) {
  const seen = [];
  try {
    await withMockedDispatcher(
      async () => startGateway(openRouterBackend({ openrouterProvider: { only: ['z-ai'], allow_fallbacks: true } })),
      async (mockAgent) => {
      intercept(mockAgent, {
        payload: stream ? openAiStreamPayload : openAiChatPayload,
        contentType: stream ? 'text/event-stream' : 'application/json',
        onBody: (body) => seen.push(body)
      });
      const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          stream,
          model: 'z-ai/glm-5.2',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'hi' }]
        })
      });
      assert.equal(res.status, 200);
      if (stream) assert.match(await res.text(), /message_stop/);
      else assert.equal((await res.json()).type, 'message');
    });
    assert.equal(seen.length, 1);
    const outbound = JSON.parse(seen[0]);
    assert.deepEqual(outbound.provider, { only: ['z-ai'], allow_fallbacks: true });
  } finally {
    await stopGateway();
  }
}

async function testGatewayMalformedPolicyFailsClosed() {
  // The gateway must not silently send an unconstrained request to OpenRouter.
  try {
    await withMockedDispatcher(
      async () => startGateway(openRouterBackend({ openrouterProvider: { only: [] } })),
      async () => {
      const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'hi' }] })
      });
      assert.notEqual(res.status, 200);
      await res.text();
    });
  } finally {
    await stopGateway();
  }
}

async function testGatewayNoPolicyUntouched() {
  const seen = [];
  try {
    await withMockedDispatcher(
      async () => startGateway({ id: 'openrouter-lane', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }),
      async (mockAgent) => {
      intercept(mockAgent, { payload: openAiChatPayload, onBody: (body) => seen.push(body) });
      const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'z-ai/glm-5.2',
          messages: [{ role: 'user', content: 'hi' }],
          provider: { only: ['openai'], allow_fallbacks: true }
        })
      });
      assert.equal(res.status, 200);
      await res.text();
    });
    const outbound = JSON.parse(seen[0]);
    assert.deepEqual(outbound.provider, { only: ['openai'], allow_fallbacks: true });
  } finally {
    await stopGateway();
  }
}

async function testGatewayLookalikeHostUntouched() {
  const seen = [];
  const previous = getGlobalDispatcher();
  const longRunningAgent = new Agent({ headersTimeout: 1800000, bodyTimeout: 1800000 });
  const mockAgent = new MockAgent({ agent: longRunningAgent });
  mockAgent.disableNetConnect();
  mockAgent.enableNetConnect(
    (host) => typeof host === 'string' && (host.startsWith('127.0.0.1') || host.startsWith('localhost'))
  );
  setGlobalDispatcher(mockAgent);
  gatewayDispatcher = mockAgent;
  try {
    mockAgent
      .get('https://notopenrouter.ai')
      .intercept({ path: '/api/v1/chat/completions', method: 'POST' })
      .reply(
        200,
        async (opts) => {
          seen.push(await readRequestBody(opts.body));
          return openAiChatPayload;
        },
        { headers: { 'content-type': 'application/json' } }
      );
    await startGateway({
      id: 'openrouter-lane',
      type: 'openai',
      baseUrl: 'https://notopenrouter.ai/api/v1',
      openrouterProvider: { only: ['z-ai'] }
    });
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'z-ai/glm-5.2', messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(res.status, 200);
    await res.text();
  } finally {
    gatewayDispatcher = null;
    setGlobalDispatcher(previous);
    await mockAgent.close();
    await stopGateway();
  }
  const outbound = JSON.parse(seen[0]);
  // Lookalike host never receives the OpenRouter provider policy.
  assert.equal(outbound.provider, undefined);
}

// ---------------------------------------------------------------------------

testLookalikeHosts();
testNoConfigLeavesBodyUntouched();
testValidPolicyEnforced();
testCallerOverrideAttemptsLose();
testNonObjectBodyUntouched();
testMalformedPoliciesThrow();

await testGatewayChatBuffered();
await testGatewayChatStream();
await testGatewayResponsesBridge();
await testGatewayResponsesBridge(true);
await testGatewayAnthropicBridge();
await testGatewayAnthropicBridge(true);
await testGatewayMalformedPolicyFailsClosed();
await testGatewayNoPolicyUntouched();
await testGatewayLookalikeHostUntouched();

console.log('openrouter-provider: ok');
