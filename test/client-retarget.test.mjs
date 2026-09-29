import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rewriteClientEndpoints, retargetClientFile } from '../src/client-retarget.mjs';
const from = 'http://old-head:8100',
  to = 'http://new-head:8100';
test('retarget keeps endpoint suffixes, role choices, credentials and unrelated values', () => {
  const source = {
    baseUrl: from + '/v1',
    roles: { chat: { baseUrl: from + '/v1', model: 'same' } },
    apiKey: 'fixture-key',
    other: from + '.example/v1',
    homepage: from,
    callback: from + '/v1',
    metadata: [from]
  };
  const next = rewriteClientEndpoints(JSON.stringify(source), { from, to, format: 'json' });
  assert.equal(next.count, 2);
  assert.deepEqual(JSON.parse(next.text), {
    ...source,
    baseUrl: to + '/v1',
    roles: { chat: { baseUrl: to + '/v1', model: 'same' } }
  });
});
test('OMP YAML and env preserve unrelated formatting and values', () => {
  const text = `providers:\n  local:\n    baseUrl: ${from}/v1\n    apiKey: fixture\nmodel: local/omp:low\n`;
  assert.equal(rewriteClientEndpoints(text, { from, to, format: 'yml' }).text, text.replace(from, to));
  const env = `export OPENAI_BASE_URL="${from}/v1" # keep\nexport SECRET=fixture\n`;
  assert.equal(rewriteClientEndpoints(env, { from, to, format: 'env' }).text, env.replace(from, to));
  assert.throws(
    () => rewriteClientEndpoints(text, { from: 'http://user:secret@host', to, format: 'yml' }),
    /credentials/
  );
});
test('apply requires review hash, preserves mode and retains private exact backup', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-client-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'client.json');
  const original = JSON.stringify({ baseUrl: from + '/v1' });
  await fs.writeFile(file, original, { mode: 0o600 });
  const plan = await retargetClientFile({ file, from, to });
  assert.equal(await fs.readFile(file, 'utf8'), original);
  await assert.rejects(retargetClientFile({ file, from, to, apply: true, yes: true }), /expect-file/);
  const report = await retargetClientFile({ file, from, to, apply: true, yes: true, expectedHash: plan.originalHash });
  assert.equal(report.applied, true);
  assert.equal(await fs.readFile(report.backupPath, 'utf8'), original);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).baseUrl, to + '/v1');
  assert.equal((await retargetClientFile({ file, from, to })).replacements, 0);
});

test('generated LLooM integration endpoint fields all migrate', () => {
  for (const key of ['LLOOM_GATEWAY_URL', 'LLOOM_OPENAI_BASE_URL', 'LLOOM_ANTHROPIC_BASE_URL']) {
    const text = `${key}=${from}/v1\n`;
    assert.equal(rewriteClientEndpoints(text, { from, to, format: 'env' }).text, text.replace(from, to));
  }
  for (const key of ['openAIBaseUrl', 'anthropicBaseUrl']) {
    const result = rewriteClientEndpoints(JSON.stringify({ [key]: from + '/v1' }), { from, to, format: 'json' });
    assert.equal(JSON.parse(result.text)[key], to + '/v1');
  }
});
