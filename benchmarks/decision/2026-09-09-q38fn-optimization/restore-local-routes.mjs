// Run after canonical strict-local canaries. Existing cloud calls may finish.
import assert from 'node:assert/strict';
const root = '/home/enntitysparkadmin/.local/lib/node_modules/lloom';
const { loadManagedServiceEnvironment } = await import(root + '/src/managed-environment.mjs');
const { loadConfig } = await import(root + '/src/config.mjs');
loadManagedServiceEnvironment();
const c = await loadConfig(process.env.HOME + '/.lloom/config.json');
const base = process.env.GATEWAY_URL || 'http://127.0.0.1:8100';
const aliases = (process.env.RESTORE_ALIASES || 'q38fn,enntity-presence').split(',');
assert(aliases.every((x) => ['q38fn', 'enntity-presence'].includes(x)));
const headers = {
  authorization: 'Bearer ' + (c.security.adminApiKeys?.[0] || c.security.apiKeys[0]),
  'content-type': 'application/json'
};
assert(
  (await fetch('http://10.100.16.2:8889/health', { signal: AbortSignal.timeout(5000) })).ok,
  'Canonical backend not healthy'
);
for (const alias of aliases) {
  console.log(JSON.stringify({ alias, resume: 'qwen3.8-flash-next', apply: process.argv.includes('--apply') }));
  if (process.argv.includes('--apply')) {
    const r = await fetch(
      base + '/gateway/routes/' + encodeURIComponent(alias) + '/members/qwen3.8-flash-next/suspension',
      { method: 'POST', headers, body: JSON.stringify({ suspended: false }), signal: AbortSignal.timeout(30000) }
    );
    const d = await r.json();
    assert(r.ok, JSON.stringify(d));
    console.log(JSON.stringify(d));
  }
}
