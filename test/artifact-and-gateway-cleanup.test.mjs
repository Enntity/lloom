import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { applyArtifactCleanup } from '../src/artifact-cleanup.mjs';
import { replaceModelRoute } from '../src/model-route-replacement.mjs';
import { loadConfig } from '../src/config.mjs';
import { recordGatewayProcess, cleanupGatewayProcesses } from '../src/gateway-process-ownership.mjs';

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-cleanup-proof-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('artifact registry preserves shared blobs and requires a current exact preview', async (t) => {
  const dir = await fixture(t);
  const config = path.join(dir, 'config.json');
  const root = path.join(dir, 'legacy-cache');
  await fs.mkdir(root);
  const obsolete = path.join(root, 'obsolete.bin'),
    shared = path.join(root, 'shared.bin');
  await fs.writeFile(obsolete, 'abc');
  await fs.writeFile(shared, 'keep');
  await fs.writeFile(config, JSON.stringify({ models: [{ id: 'remaining' }] }));
  const manifest = path.join(dir, 'manifest.json');
  await fs.writeFile(
    manifest,
    JSON.stringify({
      schema: 1,
      roots: [root],
      configs: [config],
      artifacts: [
        { path: obsolete, models: ['removed'] },
        { path: shared, models: ['removed', 'remaining'] }
      ]
    })
  );
  const plan = await applyArtifactCleanup(manifest);
  assert.deepEqual(
    plan.artifacts.map((a) => a.remove),
    [true, false]
  );
  await assert.rejects(
    applyArtifactCleanup(manifest, { apply: true, yes: true, expectedDigest: 'stale' }),
    /current preview/
  );
  const result = await applyArtifactCleanup(manifest, { apply: true, yes: true, expectedDigest: plan.digest });
  assert.equal(result.reclaimedBytes, 3);
  assert.equal(await fs.readFile(shared, 'utf8'), 'keep');
  await assert.rejects(fs.access(obsolete));
});

test('artifact registry refuses symlink escapes before deletion', async (t) => {
  const dir = await fixture(t);
  const root = path.join(dir, 'root');
  await fs.mkdir(root);
  const config = path.join(dir, 'config.json');
  await fs.writeFile(config, '{"models":[]}');
  const secret = path.join(dir, 'unrelated.bin');
  await fs.writeFile(secret, 'keep');
  const link = path.join(root, 'link');
  await fs.symlink(secret, link);
  const manifest = path.join(dir, 'manifest.json');
  await fs.writeFile(
    manifest,
    JSON.stringify({ schema: 1, roots: [root], configs: [config], artifacts: [{ path: link, models: ['removed'] }] })
  );
  await assert.rejects(applyArtifactCleanup(manifest), /symlink/);
  assert.equal(await fs.readFile(secret, 'utf8'), 'keep');
});

test('route replacement retains logical identity, aliases, defaults, credentials and old runtime', async (t) => {
  const dir = await fixture(t),
    file = path.join(dir, 'config.json');
  const raw = {
    server: { host: '127.0.0.1', port: 8100 },
    security: { apiKeys: ['${TEST_KEY}'] },
    backends: { endpoint: { type: 'openai', baseUrl: 'http://127.0.0.1:9999/v1' } },
    models: [{ id: 'logical', backend: 'endpoint', runtime: 'legacy', kind: 'chat' }],
    runtimes: { legacy: { enabled: false, command: '/bin/true' } },
    aliases: { stable: 'logical' },
    defaults: { chat: 'logical' },
    clientCatalog: { modelOrder: ['logical'] }
  };
  await fs.writeFile(file, JSON.stringify(raw), { mode: 0o600 });
  const config = await loadConfig(file);
  await replaceModelRoute(config, {
    modelId: 'logical',
    backendId: 'endpoint',
    upstreamModel: 'remote',
    apply: true,
    yes: true
  });
  const updated = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(updated.models[0].runtime, undefined);
  assert.equal(updated.models[0].upstreamModel, 'remote');
  for (const field of ['aliases', 'defaults', 'clientCatalog', 'runtimes', 'security'])
    assert.deepEqual(updated[field], raw[field]);
});

test('orphan cleanup proves command, launch identity and listener after config removal', async (t) => {
  const dir = await fixture(t),
    cli = path.join(dir, 'gateway.mjs'),
    config = path.join(dir, 'config.json');
  await fs.writeFile(config, '{}');
  await fs.writeFile(
    cli,
    "import http from 'node:http'; const s=http.createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port));process.on('SIGTERM',()=>s.close(()=>process.exit(0)));\n"
  );
  const child = spawn(process.execPath, [cli, 'serve', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  const [chunk] = await once(child.stdout, 'data');
  const receipt = recordGatewayProcess({
    pid: child.pid,
    executable: process.execPath,
    cliPath: cli,
    configPath: config,
    port: Number(chunk.toString().trim())
  });
  t.after(() => fs.rm(receipt.receiptPath, { force: true }));
  assert.equal(cleanupGatewayProcesses({ configPath: config, apply: true, yes: true })[0].signalled, false);
  await fs.unlink(config);
  const exits = once(child, 'exit');
  const report = cleanupGatewayProcesses({ configPath: config, apply: true, yes: true });
  assert.equal(report[0].owned, true);
  assert.equal(report[0].signalled, true);
  await exits;
});
