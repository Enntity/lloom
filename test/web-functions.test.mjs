import test from 'node:test';
import assert from 'node:assert/strict';
import { executeWebFunction, webFunctionStatus, validateWebFunctions } from '../src/web-functions.mjs';
import { createLloomServer } from '../src/server.mjs';

const config = {
  web: {
    search: { apiKey: 'PRIVATE_GOOGLE', cx: 'cx', endpoint: 'https://search.example/' },
    read: { apiKey: 'PRIVATE_JINA' }
  }
};

test('search uses operator credentials and normalized results, never caller overrides', async () => {
  const result = await executeWebFunction('search', { q: 'today', apiKey: 'attacker', cx: 'attacker' }, config, {
    fetchFn: async (url) => {
      assert.equal(url.searchParams.get('key'), 'PRIVATE_GOOGLE');
      assert.equal(url.searchParams.get('cx'), 'cx');
      return Response.json({ items: [{ title: 'Result', link: 'https://example.com', snippet: 'Text' }] });
    }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.value[0].url, 'https://example.com');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('page reading is bounded, validates target and masks credential-bearing failures', async () => {
  const result = await executeWebFunction('read', { url: 'https://example.com' }, config, {
    fetchFn: async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer PRIVATE_JINA');
      return new Response('x'.repeat(50000));
    }
  });
  assert.equal(result.body.value[0].content.length, 40000);
  assert.equal(result.body.value[0].truncated, true);
  assert.equal((await executeWebFunction('read', { url: 'file:///etc/passwd' }, config)).status, 400);
  const failed = await executeWebFunction('search', { q: 'query' }, config, {
    fetchFn: async () => {
      throw new Error('url?key=PRIVATE_GOOGLE');
    }
  });
  assert.equal(failed.status, 502);
  assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
  const limited = await executeWebFunction('search', { q: 'query' }, config, {
    fetchFn: async () => new Response('private error', { status: 429, headers: { 'retry-after': '7' } })
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '7');
});

test('unconfigured dependencies are explicit and discovery contains no keys', () => {
  assert.equal(webFunctionStatus({}).search.configured, false);
  assert.equal(webFunctionStatus(config).read.configured, true);
  assert.ok(!JSON.stringify(webFunctionStatus(config)).includes('PRIVATE'));
  assert.equal(validateWebFunctions({ read: { endpoint: 'file:///x' } }).length, 1);
});

test('gateway web routes and capability discovery require the normal inference credential', async (t) => {
  const app = createLloomServer(
    {
      server: { host: '127.0.0.1', port: 0 },
      security: { allowMissingAuth: false, apiKeys: ['client-key'] },
      backends: {},
      models: [],
      runtimes: {}
    },
    { logger: { info() {}, warn() {}, error() {} } }
  );
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close({ stopRuntimes: false }));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(`${base}/v1/capabilities`)).status, 401);
  const discovery = await fetch(`${base}/v1/capabilities`, { headers: { authorization: 'Bearer client-key' } });
  const payload = await discovery.json();
  assert.equal(payload.models.presence, 'enntity-presence');
  assert.equal(payload.web.search.configured, false);
  const search = await fetch(`${base}/v1/web/search`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-key', 'content-type': 'application/json' },
    body: '{"q":"test"}'
  });
  assert.equal(search.status, 503);
});

test('stable Runtime aliases reuse configured routes without inventing a cloud fallback', async () => {
  const { applyRuntimeAliases } = await import('../src/runtime-capabilities.mjs');
  const config = applyRuntimeAliases({
    defaults: { chatModel: 'local', embeddingModel: 'embed' },
    models: [{ id: 'local' }, { id: 'embed' }, { id: 'cloud/openrouter/chat-capable' }]
  });
  assert.deepEqual(config.aliases['enntity-presence'].members, ['local']);
  assert.deepEqual(config.aliases['chat-capable'].members, ['cloud/openrouter/chat-capable']);
  assert.deepEqual(config.aliases.embedding.members, ['embed']);
  assert.equal(
    applyRuntimeAliases({ defaults: { chatModel: 'local' }, models: [{ id: 'local' }] }).aliases['chat-capable'],
    undefined
  );
});

test('multimodal alias uses the declared default or available Gemini and preserves overrides', async () => {
  const { applyRuntimeAliases } = await import('../src/runtime-capabilities.mjs');
  const gemini = { id: 'google/gemini-3.1-flash-lite' };
  assert.deepEqual(applyRuntimeAliases({ models: [gemini] }).aliases.multimodal.members, [gemini.id]);
  assert.deepEqual(
    applyRuntimeAliases({ defaults: { multimodalModel: 'custom' }, models: [gemini, { id: 'custom' }] }).aliases
      .multimodal.members,
    ['custom']
  );
  assert.deepEqual(
    applyRuntimeAliases({ aliases: { multimodal: { members: ['chosen'] } }, models: [gemini] }).aliases.multimodal
      .members,
    ['chosen']
  );
  assert.equal(applyRuntimeAliases({ models: [] }).aliases.multimodal, undefined);
});
