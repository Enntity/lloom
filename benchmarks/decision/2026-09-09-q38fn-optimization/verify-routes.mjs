import assert from 'node:assert/strict';
const root = '/home/enntitysparkadmin/.local/lib/node_modules/lloom';
const { loadManagedServiceEnvironment } = await import(root + '/src/managed-environment.mjs');
const { loadConfig } = await import(root + '/src/config.mjs');
loadManagedServiceEnvironment();
const c = await loadConfig(process.env.HOME + '/.lloom/config.json');
const base = process.env.GATEWAY_URL || 'http://127.0.0.1:8100';
const aliases = (process.env.VERIFY_ALIASES || 'q38fn,enntity-presence').split(',');
const caller = 'q38-restored-' + Date.now();
const headers = {
  authorization: 'Bearer ' + (c.security.adminApiKeys?.[0] || c.security.apiKeys[0]),
  'content-type': 'application/json',
  'x-lloom-client': caller
};
for (const model of aliases) {
  const start = performance.now();
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly Q38_LOCAL_READY.' }],
      temperature: 0,
      max_tokens: 128,
      chat_template_kwargs: { enable_thinking: false }
    }),
    signal: AbortSignal.timeout(120000)
  });
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.equal(d.choices[0].message.content.trim(), 'Q38_LOCAL_READY');
  console.log(
    JSON.stringify({
      alias: model,
      status: r.status,
      responseModel: d.model,
      content: d.choices[0].message.content,
      elapsedMs: performance.now() - start
    })
  );
}
const r = await fetch(base + '/gateway/metrics', { headers });
assert(r.ok);
const m = await r.json(),
  attribution = m.recent
    .filter((x) => x.caller === caller)
    .map((x) =>
      Object.fromEntries(
        ['requestedModel', 'resolvedModel', 'upstreamModel', 'backend', 'status', 'routeSelectionReason'].map((k) => [
          k,
          x[k]
        ])
      )
    );
assert.equal(attribution.length, aliases.length);
assert(attribution.every((x) => x.status === 200 && x.resolvedModel === 'qwen3.8-flash-next'));
console.log(JSON.stringify({ at: new Date().toISOString(), caller, chatModel: c.defaults.chatModel, attribution }));
