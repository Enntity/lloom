import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restartGatewayService } from '../src/service-control.mjs';
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-service-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sourcePath = path.join(dir, 'config.json');
  const raw = {
    server: { host: '127.0.0.1', port: 8100 },
    cluster: { nodeId: 'media', leaderNode: 'old', nodes: { media: {} } },
    models: [],
    backends: {},
    security: { apiKeys: ['fixture'] }
  };
  await fs.writeFile(sourcePath, JSON.stringify(raw), { mode: 0o600 });
  return { config: { ...raw, sourcePath }, raw, read: async () => JSON.parse(await fs.readFile(sourcePath, 'utf8')) };
}
test('service restart dry-run and missing approval have no side effects', async (t) => {
  const f = await fixture(t);
  const run = () => assert.fail('no process');
  const fetchFn = () => assert.fail('no request');
  assert.equal((await restartGatewayService(f.config, { platform: 'linux', run, fetchFn })).applied, false);
  await assert.rejects(restartGatewayService(f.config, { platform: 'linux', apply: true, run, fetchFn }), /--yes/);
  assert.deepEqual(await f.read(), f.raw);
});
test('service restart refuses a relay pointing at another node', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    restartGatewayService(f.config, {
      platform: 'linux',
      apply: true,
      yes: true,
      fetchFn: async () => ({ ok: true, json: async () => ({ node: { id: 'old' } }) })
    }),
    /identity/
  );
  assert.deepEqual(await f.read(), f.raw);
});
for (const failRestart of [false, true])
  test(`restart drains and restores admission; restart failure=${failRestart}`, async (t) => {
    const f = await fixture(t);
    let active = 2,
      restarts = 0;
    const fetchFn = async (url) => ({
      ok: true,
      json: async () =>
        url.endsWith('/node')
          ? { node: { id: 'media' } }
          : url.endsWith('/status')
            ? { server: (await f.read()).server }
            : { active: active-- > 0 ? [{}] : [] }
    });
    const run = async (cmd, args) => {
      assert.equal(cmd, 'systemctl');
      if (args.includes('show')) return { stdout: 'active\n' };
      assert.equal((await f.read()).server.inferenceEnabled, false);
      assert.ok(active < 0);
      restarts++;
      if (failRestart) throw new Error('fixture restart failure');
      return { stdout: '' };
    };
    const call = restartGatewayService(f.config, {
      platform: 'linux',
      apply: true,
      yes: true,
      fetchFn,
      run,
      pause: async () => {}
    });
    if (failRestart) await assert.rejects(call, /fixture restart failure/);
    else assert.equal((await call).applied, true);
    assert.equal(restarts, 1);
    assert.deepEqual(await f.read(), f.raw);
  });

test('non-local service address is refused before transmitting credentials', async (t) => {
  const f = await fixture(t);
  f.config.server.host = '192.0.2.123';
  await assert.rejects(
    restartGatewayService(f.config, {
      platform: 'linux',
      apply: true,
      yes: true,
      fetchFn: () => assert.fail('credential transmitted')
    }),
    /local interface/
  );
});
