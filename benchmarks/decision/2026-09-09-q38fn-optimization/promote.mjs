// Apply only after the isolated candidate is stopped and its gates pass.
// Keeps route suspension until canonical local canaries are complete.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const root = '/home/enntitysparkadmin/.local/lib/node_modules/lloom';
const { loadManagedServiceEnvironment } = await import(root + '/src/managed-environment.mjs');
const { loadConfig } = await import(root + '/src/config.mjs');
loadManagedServiceEnvironment();
const batch = process.env.TARGET_BATCH;
assert(['4096', '8192'].includes(batch), 'Explicit qualified TARGET_BATCH required');
const file = process.env.HOME + '/.lloom/config.json',
  c = JSON.parse(await fs.readFile(file, 'utf8'));
for (const suffix of ['head', 'worker', 'cluster']) {
  const r = c.runtimes['qwen38-flash-next-' + suffix];
  assert.equal(r.recipe?.version, 6);
  r.recipe.version = 7;
  if (r.bootstrap) {
    assert.deepEqual(r.bootstrap.command, ['/opt/lloom/qwen-resident/entrypoint.sh']);
    for (const [key, value] of Object.entries({
      ENABLE_PREFIX_CACHING: '1',
      PREFIX_CACHE_RETENTION_INTERVAL: '1600',
      MAX_NUM_BATCHED_TOKENS: batch
    })) {
      const i = r.bootstrap.createArgs.findIndex((x) => x.startsWith(key + '='));
      if (i >= 0) r.bootstrap.createArgs[i] = key + '=' + value;
      else r.bootstrap.createArgs.push('-e', key + '=' + value);
    }
    assert(r.bootstrap.createArgs.some((x) => x.includes('nvidia-e962733e-resident:/opt/lloom/qwen-resident:ro')));
    r.bootstrap.createArgs = r.bootstrap.createArgs.map((x) =>
      x.replace(
        'nvidia-e962733e-resident:/opt/lloom/qwen-resident:ro',
        'nvidia-e962733e-prefix:/opt/lloom/qwen-prefix:ro'
      )
    );
    r.bootstrap.command = ['/opt/lloom/qwen-prefix/entrypoint.sh'];
  }
  delete c.runtimes['qwen38-prefix-test-' + suffix];
}
c.models = c.models.filter((x) => x.id !== 'qwen3.8-flash-next-prefix-test');
delete c.backends['qwen38-prefix-test'];
delete c.aliases['q38fn-prefix-test'];
console.log(
  JSON.stringify({
    canonical: 'qwen38-flash-next-cluster',
    version: 7,
    batch,
    retention: 1600,
    removeIsolatedCandidate: true,
    routeSuspensionPreserved: true,
    apply: process.argv.includes('--apply')
  })
);
if (process.argv.includes('--apply')) {
  const stat = await fs.stat(file),
    tmp = file + '.q38-promote.tmp';
  await fs.copyFile(file, file + '.before-q38-v7-' + Date.now());
  await fs.writeFile(tmp, JSON.stringify(c, null, 2) + '\n', { mode: stat.mode });
  await loadConfig(tmp);
  await fs.rename(tmp, file);
}
