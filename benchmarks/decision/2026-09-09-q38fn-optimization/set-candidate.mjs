import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = '/home/enntitysparkadmin/.local/lib/node_modules/lloom';
const { loadManagedServiceEnvironment } = await import(root + '/src/managed-environment.mjs');
const { loadConfig } = await import(root + '/src/config.mjs');
loadManagedServiceEnvironment();
const retention = process.env.RETENTION || '1600',
  batch = process.env.BATCH || '8192';
assert(['0', '1600'].includes(retention));
assert(['4096', '8192'].includes(batch));
const file = process.env.HOME + '/.lloom/config.json',
  c = JSON.parse(await fs.readFile(file, 'utf8'));
for (const suffix of ['head', 'worker']) {
  const r = c.runtimes['qwen38-prefix-test-' + suffix];
  assert(r?.bootstrap);
  for (const [key, value] of Object.entries({
    PREFIX_CACHE_RETENTION_INTERVAL: retention,
    MAX_NUM_BATCHED_TOKENS: batch
  })) {
    const i = r.bootstrap.createArgs.findIndex((x) => x.startsWith(key + '='));
    if (i >= 0) r.bootstrap.createArgs[i] = key + '=' + value;
    else r.bootstrap.createArgs.push('-e', key + '=' + value);
  }
}
console.log(JSON.stringify({ candidateOnly: true, retention, batch, apply: process.argv.includes('--apply') }));
if (process.argv.includes('--apply')) {
  const tmp = file + '.candidate.tmp',
    stat = await fs.stat(file);
  await fs.copyFile(file, file + '.before-candidate-settings-' + Date.now());
  await fs.writeFile(tmp, JSON.stringify(c, null, 2) + '\n', { mode: stat.mode });
  await loadConfig(tmp);
  await fs.rename(tmp, file);
}
