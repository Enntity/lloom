// Additive local experiment: preserve the installed baseline and unrelated config.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.env.LLOOM_ROOT || '/home/enntitysparkadmin/.local/lib/node_modules/lloom';
const { loadManagedServiceEnvironment } = await import(root + '/src/managed-environment.mjs');
const { loadConfig } = await import(root + '/src/config.mjs');
loadManagedServiceEnvironment();
const configPath = path.join(process.env.HOME, '.lloom/config.json');
const c = JSON.parse(await fs.readFile(configPath, 'utf8'));
const from = 'qwen38-flash-next',
  to = 'qwen38-prefix-test';
const modelFrom = 'qwen3.8-flash-next',
  modelTo = 'qwen3.8-flash-next-prefix-test';
function clone(v) {
  return JSON.parse(
    JSON.stringify(v)
      .replaceAll(from, to)
      .replaceAll(modelFrom, modelTo)
      .replaceAll('qwen38-resident', 'qwen38-prefix-test')
      .replaceAll('8889', '8894')
      .replaceAll('50000', '50004')
  );
}
assert(!c.runtimes[to + '-cluster'], 'Candidate already exists; inspect instead of overwriting');
for (const suffix of ['worker', 'head', 'cluster']) {
  const r = clone(c.runtimes[from + '-' + suffix]);
  assert(r);
  r.keepWarm = false;
  r.watchdog = { enabled: false };
  r.recipe = { id: 'qwen38-prefix-test-e962733e', version: 1 };
  if (r.bootstrap) {
    r.bootstrap.createArgs = r.bootstrap.createArgs.map((x) =>
      x === 'ENABLE_PREFIX_CACHING=0' ? 'ENABLE_PREFIX_CACHING=1' : x
    );
    r.bootstrap.createArgs.push('-v', root + '/backends/qwen38-vllm/nvidia-e962733e-prefix:/opt/lloom/qwen-prefix:ro');
    r.bootstrap.command = ['/opt/lloom/qwen-prefix/entrypoint.sh'];
  }
  c.runtimes[to + '-' + suffix] = r;
}
c.backends[to] = clone(c.backends[from]);
const m = clone(c.models.find((x) => x.id === modelFrom));
assert(m);
m.advertise = false;
m.name += ' prefix-cache test';
c.models.push(m);
c.aliases['q38fn-prefix-test'] = {
  members: [modelTo],
  advertise: false,
  description: 'Strict local prefix-cache experiment; no cloud fallback.'
};
console.log(
  JSON.stringify({
    action: 'add',
    runtime: to + '-cluster',
    model: modelTo,
    port: 8894,
    keepWarm: false,
    changes: 'Two guarded prefix-cache corrections and align-mode caching; baseline preserved.'
  })
);
if (process.argv.includes('--apply')) {
  const stat = await fs.stat(configPath),
    tmp = configPath + '.q38opt.tmp';
  await fs.copyFile(configPath, configPath + '.before-prefix-candidate-' + Date.now());
  await fs.writeFile(tmp, JSON.stringify(c, null, 2) + '\n', { mode: stat.mode });
  await loadConfig(tmp);
  await fs.rename(tmp, configPath);
  console.log('applied');
}
