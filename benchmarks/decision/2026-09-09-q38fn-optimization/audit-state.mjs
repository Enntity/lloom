import fs from 'node:fs/promises';
const root = '/home/enntitysparkadmin/.local/lib/node_modules/lloom';
const { loadManagedServiceEnvironment } = await import(root + '/src/managed-environment.mjs');
loadManagedServiceEnvironment();
const c = JSON.parse(await fs.readFile(process.env.HOME + '/.lloom/config.json', 'utf8'));
const headers = { authorization: 'Bearer ' + process.env.LLOOM_API_KEY };
const base = 'http://127.0.0.1:8100';
const [status, metrics] = await Promise.all(
  ['/gateway/status', '/gateway/metrics'].map(async (p) => {
    const r = await fetch(base + p, { headers });
    if (!r.ok) throw new Error('Audit HTTP ' + r.status);
    return r.json();
  })
);
const runtimes = Object.fromEntries(
  Object.entries(status.runtimeManager.runtimes)
    .filter(([k]) => k.startsWith('qwen38-'))
    .map(([k, v]) => [
      k,
      Object.fromEntries(
        ['status', 'healthy', 'loaded', 'activeRequests', 'queuedRequests', 'keepWarm', 'lastIdleAt'].map((f) => [
          f,
          v[f]
        ])
      )
    ])
);
const presence = (metrics.recent || []).filter((x) => x.requestedModel === 'enntity-presence');
const counts = {};
for (const r of presence) {
  const key = [r.resolvedModel, r.backend, r.status].join('|');
  counts[key] = (counts[key] || 0) + 1;
}
console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    chatModel: c.defaults?.chatModel,
    runtimes,
    aliases: Object.fromEntries(['q38fn', 'enntity-presence'].map((k) => [k, c.aliases[k]])),
    recentPresence: counts
  })
);
