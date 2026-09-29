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
for (const matchingConfig of [true, false])
  test(`launchd restart validates configuration and waits for replacement PID; matching=${matchingConfig}`, async (t) => {
    const f = await fixture(t);
    let pid = '10',
      signalled = false,
      observedReplacement = false;
    const fetchFn = async (url) => ({
      ok: true,
      json: async () =>
        url.endsWith('/node')
          ? { node: { id: 'media' } }
          : url.endsWith('/status')
            ? { server: (await f.read()).server }
            : { active: [] }
    });
    const run = async (command, args) => {
      if (command === 'plutil')
        return {
          stdout: args.includes('KeepAlive')
            ? 'true'
            : JSON.stringify([
                'node',
                '/fixture/lloom/bin/lloom.mjs',
                'serve',
                '--config',
                matchingConfig ? f.config.sourcePath : f.config.sourcePath + '.backup'
              ])
        };
      assert.equal(command, 'launchctl');
      assert.equal(args.at(-1), 'gui/501/com.lloom.federation');
      if (args[0] === 'kill') {
        assert.equal(args[1], 'SIGTERM');
        assert.equal((await f.read()).server.inferenceEnabled, false);
        signalled = true;
        return { stdout: '' };
      }
      if (signalled) {
        pid = '11';
        observedReplacement = true;
      }
      return { stdout: `state = running\n pid = ${pid}\n` };
    };
    const call = restartGatewayService(f.config, {
      platform: 'darwin',
      uid: 501,
      serviceLabel: 'com.lloom.federation',
      apply: true,
      yes: true,
      run,
      fetchFn,
      pause: async () => {}
    });
    if (matchingConfig) {
      assert.equal((await call).manager, 'launchd');
      assert.equal(observedReplacement, true);
    } else {
      await assert.rejects(call, /selected configuration/);
      assert.equal(signalled, false);
    }
    assert.deepEqual(await f.read(), f.raw);
  });

test('launchd shell wrapper uses exact configuration argv and LLooM executable', async () => {
  const { launchAgentMatchesConfig: matches } = await import('../src/service-control.mjs');
  const config = '/tmp/Application Support/config.json';
  const cmd =
    "set -a; source /fixture/env; exec /fixture/node /fixture/lloom/bin/lloom.mjs serve --config '" + config + "'";
  assert.equal(matches(['/bin/zsh', '-c', cmd], config), true);
  assert.equal(matches(['/bin/zsh', '-c', cmd.replace("config.json'", "config.json.backup'")], config), false);
  assert.equal(matches(['unrelated', 'serve', '--config', config], config), false);
});

test('listener preview validates local addresses and authenticated public binds', async (t) => {
  const f = await fixture(t);
  const opts = { platform: 'linux', host: '0.0.0.0', fetchFn: () => assert.fail('dry run request') };
  await assert.rejects(restartGatewayService(f.config, opts), /non-loopback/);
  f.config.security.allowNonLoopbackBind = true;
  assert.equal((await restartGatewayService(f.config, opts)).newHost, '0.0.0.0');
  f.config.security.apiKeys = [];
  await assert.rejects(restartGatewayService(f.config, opts), /credential/);
  await assert.rejects(restartGatewayService(f.config, { ...opts, host: '192.0.2.99' }), /non-local/);
});
for (const failure of ['none', 'restart', 'external-change'])
  test(`listener migration preserves disabled inference and rollback ownership: ${failure}`, async (t) => {
    const f = await fixture(t);
    f.raw.server.inferenceEnabled = false;
    f.raw.security.allowNonLoopbackBind = true;
    await fs.writeFile(f.config.sourcePath, JSON.stringify(f.raw));
    f.config.security.allowNonLoopbackBind = true;
    let restarts = 0,
      drained = false;
    const fetchFn = async (url) => ({
      ok: true,
      json: async () => {
        if (url.endsWith('/health')) return { pid: restarts ? 202 : 101 };
        if (url.endsWith('/node')) return { node: { id: 'media' } };
        if (url.endsWith('/status')) return { server: (await f.read()).server };
        drained = true;
        return { active: [] };
      }
    });
    const run = async (cmd, args) => {
      if (args.includes('show')) return { stdout: 'active\n' };
      assert.ok(drained);
      restarts++;
      if (restarts === 1 && failure !== 'none') {
        if (failure === 'external-change') {
          const raw = await f.read();
          raw.server.host = '127.0.0.2';
          await fs.writeFile(f.config.sourcePath, JSON.stringify(raw));
        }
        throw Error('fixture restart failed');
      }
      return { stdout: '' };
    };
    const call = restartGatewayService(f.config, {
      host: '0.0.0.0',
      platform: 'linux',
      apply: true,
      yes: true,
      run,
      fetchFn,
      pause: async () => {}
    });
    if (failure === 'none') assert.equal((await call).applied, true);
    else await assert.rejects(call, failure === 'external-change' ? /externally/ : /fixture restart failed/);
    const raw = await f.read();
    assert.equal(raw.server.inferenceEnabled, false);
    assert.equal(raw.server.host, failure === 'none' ? '0.0.0.0' : failure === 'restart' ? '127.0.0.1' : '127.0.0.2');
    assert.equal(restarts, failure === 'restart' ? 2 : 1);
  });
