import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildServiceUnit,
  systemdQuoteArg,
  serviceUnitPath,
  installGatewayService,
  doctorGatewayService,
  stopGatewayService,
  uninstallGatewayService
} from '../src/service-install.mjs';

async function fixture(t, overrides = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-service-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = {
    sourcePath: path.join(home, 'gateway.json'),
    server: { host: '127.0.0.1', port: 8100 },
    cluster: { nodeId: 'node-a' },
    security: { adminApiKeys: ['fixture-secret'] },
    runtimes: {}
  };
  await fs.writeFile(config.sourcePath, JSON.stringify(config));
  const calls = [];
  const state = {
    active: false,
    enabled: false,
    linger: true,
    pid: 42,
    restart: 'on-failure',
    nodeId: 'node-a',
    fail: null,
    failedOnce: false,
    ...overrides
  };
  const run = async (exe, args) => {
    calls.push([exe, ...args]);
    const action = args[0] === '--user' ? args[1] : args[0];
    if (action === 'enable') state.enabled = true;
    if (action === 'disable') state.enabled = false;
    if (action === 'start') state.active = true;
    if (action === 'stop') state.active = false;
    if (action === 'enable-linger') state.linger = true;
    if (state.fail === action && !state.failedOnce) {
      state.failedOnce = true;
      throw new Error('injected failure');
    }
    if (action === 'show') {
      const installed = await fs.stat(serviceUnitPath(home)).catch(() => null);
      if (!installed) return { stdout: 'LoadState=not-found\n' };
      return {
        stdout: `LoadState=loaded\nActiveState=${state.active ? 'active' : 'inactive'}\nUnitFileState=${state.enabled ? 'enabled' : 'disabled'}\nRestart=${state.restart}\nRestartUSec=5s\nMainPID=${state.pid}\nFragmentPath=${serviceUnitPath(home)}\nDropInPaths=${state.dropIns ?? ''}\nNeedDaemonReload=no\n`
      };
    }
    if (action === 'show-user') return { stdout: state.linger === null ? '' : state.linger ? 'yes\n' : 'no\n' };
    if (exe === 'docker') return { stdout: '29.0.0\n' };
    return { stdout: '' };
  };
  const options = {
    home,
    nodePath: '/usr/bin/node',
    entryPath: '/opt/lloom/bin/lloom.mjs',
    platform: 'linux',
    uid: 1001,
    run,
    env: {},
    interfaces: new Set(['127.0.0.1']),
    fetchImpl: async (url, request) => {
      calls.push(['http', new URL(url).pathname, request.headers.authorization]);
      return Response.json(
        new URL(url).pathname === '/health' ? { ok: true, pid: state.pid } : { node: { id: state.nodeId } }
      );
    }
  };
  const writeUnit = async (
    text = buildServiceUnit({ nodePath: options.nodePath, entryPath: options.entryPath, configPath: config.sourcePath })
  ) => {
    await fs.mkdir(path.dirname(serviceUnitPath(home)), { recursive: true });
    await fs.writeFile(serviceUnitPath(home), text);
  };
  return { home, config, state, calls, options, writeUnit };
}
const apply = { apply: true, yes: true };

test('dry runs do not write or invoke commands; mutation flags must be paired', async (t) => {
  const f = await fixture(t);
  for (const action of [installGatewayService, stopGatewayService, uninstallGatewayService]) {
    const result = await action(f.config, f.options);
    assert.equal(result.applied, false);
    for (const flags of [{ apply: true }, { yes: true }])
      await assert.rejects(action(f.config, { ...f.options, ...flags }), /requires|both/);
  }
  assert.deepEqual(f.calls, []);
  await assert.rejects(fs.stat(serviceUnitPath(f.home)), { code: 'ENOENT' });
});

test('systemd quoting has literal argv, specifiers and no shell or inline secrets', () => {
  const odd = '/tmp/a b"$HOME%u`x`;q';
  assert.equal(systemdQuoteArg(odd), '"/tmp/a b\\"$$HOME%%u`x`;q"');
  const unit = buildServiceUnit({
    nodePath: '/usr/bin/node',
    entryPath: odd,
    configPath: '/tmp/config',
    environmentFile: '/tmp/$env%u'
  });
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /StartLimitIntervalSec=0/);
  assert.match(unit, /EnvironmentFile="\/tmp\/\$env%%u"/);
  assert.doesNotMatch(unit, /Environment=|\/bin\/sh|sudo/);
  for (const bad of ['\n', '\r', '\0', '\t']) assert.throws(() => systemdQuoteArg('/tmp/' + bad), /control character/);
});

test('fresh installation verifies persistent service and gateway identity without Docker', async (t) => {
  const f = await fixture(t);
  const r = await installGatewayService(f.config, { ...f.options, ...apply });
  assert.equal(r.applied, true);
  assert.equal(r.verification.ok, true);
  assert.equal(f.state.enabled, true);
  assert.equal(f.state.active, true);
  assert.equal(
    f.calls.some((c) => c[0] === 'docker'),
    false
  );
  assert.equal(
    f.calls.some((c) => c.includes('restart')),
    false
  );
  assert.deepEqual(
    f.calls.find((c) => c[0] === 'loginctl'),
    ['loginctl', 'show-user', '1001', '--property=Linger', '--value']
  );
  assert.equal(
    f.calls.filter((c) => c[0] === 'http').every((c) => c[2] === 'Bearer fixture-secret'),
    true
  );
});

test('linger must be verified or explicitly enabled; unknown/permission failures stay failures', async (t) => {
  const f = await fixture(t, { linger: false });
  await assert.rejects(installGatewayService(f.config, { ...f.options, ...apply }), /enable-linger/);
  assert.equal(
    f.calls.some((c) => c.includes('enable')),
    false
  );
  const r = await installGatewayService(f.config, { ...f.options, ...apply, enableLinger: true });
  assert.equal(r.linger.enabled, true);
  assert.ok(f.calls.some((c) => c.join(' ') === 'loginctl enable-linger 1001'));
  const g = await fixture(t, { linger: false, fail: 'enable-linger' });
  await assert.rejects(
    installGatewayService(g.config, { ...g.options, ...apply, enableLinger: true }),
    /authorized login session/
  );
  await assert.rejects(fs.stat(serviceUnitPath(g.home)), { code: 'ENOENT' });
  const h = await fixture(t, { linger: null });
  const d = await doctorGatewayService(h.config, h.options);
  assert.equal(d.ok, false);
  assert.equal(d.linger.enabled, null);
});

test('unowned, symlink, missing environment file, stale plan and active changed unit are refused', async (t) => {
  const f = await fixture(t);
  await f.writeUnit('[Service]\nExecStart=/bin/custom\n');
  for (const action of [installGatewayService, stopGatewayService, uninstallGatewayService])
    await assert.rejects(action(f.config, { ...f.options, ...apply }), /unowned/);
  assert.deepEqual(f.calls, []);
  await f.writeUnit();
  await assert.rejects(
    installGatewayService(f.config, { ...f.options, ...apply, expectedUnitHash: 'stale' }),
    /reviewed plan/
  );
  await assert.rejects(
    installGatewayService(f.config, { ...f.options, environmentFile: '/not/a/file' }),
    /does not exist/
  );
  await f.writeUnit((await fs.readFile(serviceUnitPath(f.home), 'utf8')) + '# old\n');
  f.state.active = true;
  await assert.rejects(installGatewayService(f.config, { ...f.options, ...apply }), /drain and stop/);
  await fs.unlink(serviceUnitPath(f.home));
  await fs.symlink(f.config.sourcePath, serviceUnitPath(f.home));
  await assert.rejects(installGatewayService(f.config, f.options), /non-regular/);
});

for (const failedStep of ['daemon-reload', 'enable', 'start'])
  test(`failed ${failedStep} restores prior file and enable/active state, including possibly applied failures`, async (t) => {
    const f = await fixture(t, { enabled: true, fail: failedStep });
    await f.writeUnit();
    const before = (await fs.readFile(serviceUnitPath(f.home), 'utf8')) + '# prior\n';
    await f.writeUnit(before);
    await assert.rejects(installGatewayService(f.config, { ...f.options, ...apply }), (e) => {
      assert.equal(e.receipt.failedStep, failedStep);
      assert.equal(e.receipt.rollbackComplete, true);
      return true;
    });
    assert.equal(await fs.readFile(serviceUnitPath(f.home), 'utf8'), before);
    assert.equal(f.state.active, false);
    assert.equal(f.state.enabled, true);
    assert.equal(
      f.calls.some((c) => c.includes('disable')),
      false
    );
  });

test('failed fresh start stops possibly started service and removes new unit', async (t) => {
  const f = await fixture(t, { fail: 'start' });
  await assert.rejects(installGatewayService(f.config, { ...f.options, ...apply }), (e) => e.receipt.rollbackComplete);
  assert.equal(f.state.active, false);
  assert.equal(f.state.enabled, false);
  await assert.rejects(fs.stat(serviceUnitPath(f.home)), { code: 'ENOENT' });
});

test('concurrent edits survive rollback; uncertain recovery retains a failure receipt', async (t) => {
  const f = await fixture(t);
  const run = async (exe, args) => {
    if (args.includes('start')) {
      await f.writeUnit('# operator replacement\n');
      throw new Error('lost response');
    }
    return f.options.run(exe, args);
  };
  await assert.rejects(installGatewayService(f.config, { ...f.options, ...apply, run }), (e) => {
    assert.equal(e.receipt.rollbackComplete, false);
    assert.ok(e.receipt.recoveryFailures.includes('restore-unit'));
    return true;
  });
  assert.equal(await fs.readFile(serviceUnitPath(f.home), 'utf8'), '# operator replacement\n');
});

test('exclusive lock refuses concurrent or crashed operation without guessing age', async (t) => {
  const f = await fixture(t);
  await f.writeUnit();
  await fs.writeFile(serviceUnitPath(f.home) + '.lock', '{}');
  await assert.rejects(stopGatewayService(f.config, { ...f.options, ...apply }), /lock exists/);
  assert.deepEqual(f.calls, []);
});

test('explicit stop and uninstall only affect gateway service, preserve linger and failures retain unit', async (t) => {
  const f = await fixture(t, { active: true, enabled: true });
  await f.writeUnit();
  const stopped = await stopGatewayService(f.config, { ...f.options, ...apply });
  assert.equal(stopped.stopped, true);
  assert.equal(f.state.enabled, true);
  f.state.fail = 'disable';
  await assert.rejects(
    uninstallGatewayService(f.config, { ...f.options, ...apply }),
    (e) => e.receipt.failedStep === 'disable'
  );
  assert.ok(await fs.stat(serviceUnitPath(f.home)));
  const r = await uninstallGatewayService(f.config, { ...f.options, ...apply });
  assert.equal(r.removed, true);
  assert.equal(r.lingerUnchanged, true);
  assert.equal(
    f.calls.some((c) => c[0] !== 'systemctl'),
    false
  );
  assert.equal(f.state.linger, true);
});

test('doctor rejects wrong node/PID, missing interface, missing telemetry and auth failures', async (t) => {
  const f = await fixture(t, { active: true, enabled: true, nodeId: 'wrong-node' });
  await f.writeUnit();
  assert.equal((await doctorGatewayService(f.config, f.options)).ok, false);
  const wrongPid = await doctorGatewayService(f.config, {
    ...f.options,
    fetchImpl: async () => Response.json({ ok: true, pid: 9000, node: { id: 'node-a' } })
  });
  assert.equal(wrongPid.gateway.pidMatches, false);
  const noPid = await doctorGatewayService(f.config, {
    ...f.options,
    fetchImpl: async () => Response.json({ ok: true, node: { id: 'node-a' } })
  });
  assert.equal(noPid.ok, false);
  f.calls.length = 0;
  const absent = await doctorGatewayService({ ...f.config, server: { host: '10.1.2.3', port: 8100 } }, f.options);
  assert.equal(absent.bind.interfaceAvailable, false);
  assert.equal(
    f.calls.some((c) => c[0] === 'http'),
    false
  );
  const unauthorized = await doctorGatewayService(f.config, {
    ...f.options,
    fetchImpl: async () => Response.json({ error: { message: 'fixture-secret' } }, { status: 401 })
  });
  assert.equal(unauthorized.gateway.code, 'gateway_auth_failed');
  assert.equal(unauthorized.ok, false);
  assert.doesNotMatch(JSON.stringify(unauthorized), /fixture-secret/);
});

test('doctor checks Docker only for enabled local managed Docker runtimes and forwards selected key', async (t) => {
  const f = await fixture(t, { active: true, enabled: true });
  await f.writeUnit();
  f.config.runtimes = { model: { containerName: 'lloom-model' }, disabled: { enabled: false, containerName: 'off' } };
  const d = await doctorGatewayService(f.config, {
    ...f.options,
    adminKeyEnvName: 'SERVICE_KEY',
    env: { SERVICE_KEY: 'selected-service-key' }
  });
  assert.deepEqual(d.docker.runtimeIds, ['model']);
  assert.ok(f.calls.some((c) => c[0] === 'docker'));
  assert.equal(
    f.calls.filter((c) => c[0] === 'http').every((c) => c[2] === 'Bearer selected-service-key'),
    true
  );
});

test('post-start verification failure compensates the new service', async (t) => {
  const f = await fixture(t, { nodeId: 'wrong' });
  await assert.rejects(installGatewayService(f.config, { ...f.options, ...apply }), (e) => {
    assert.equal(e.receipt.failedStep, 'verify');
    assert.equal(e.receipt.rollbackComplete, true);
    assert.equal(e.receipt.verification.gateway.nodeIdMatch, false);
    return true;
  });
  assert.equal(f.state.active, false);
  assert.equal(f.state.enabled, false);
  await assert.rejects(fs.stat(serviceUnitPath(f.home)), { code: 'ENOENT' });
});

test('raw environment placeholders require a persistent file even when loaded config is expanded', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(
    f.config.sourcePath,
    JSON.stringify({ ...f.config, security: { adminApiKeys: ['${PERSISTENT_KEY}'] } })
  );
  await assert.rejects(installGatewayService(f.config, { ...f.options, ...apply }), /persistent environment file/);
  assert.deepEqual(f.calls, []);
  await fs.mkdir(path.join(f.home, '.config', 'lloom'), { recursive: true });
  await fs.writeFile(path.join(f.home, '.config', 'lloom', 'env'), 'PERSISTENT_KEY=fixture-secret\n');
  const r = await installGatewayService(f.config, { ...f.options, ...apply });
  assert.equal(r.verification.ok, true);
});

test('standalone identity resolves the local hostname and nonlocal containers do not require local Docker', async (t) => {
  const f = await fixture(t, { active: true, enabled: true, nodeId: os.hostname() });
  delete f.config.cluster;
  await fs.writeFile(f.config.sourcePath, JSON.stringify(f.config));
  await f.writeUnit();
  f.config.runtimes = { remote: { node: 'another-node', containerName: 'remote-container' } };
  const r = await doctorGatewayService(f.config, f.options);
  assert.equal(r.gateway.nodeIdMatch, true);
  assert.equal(r.docker.needed, false);
});

test('loaded service overrides are refused before any service mutation', async (t) => {
  const f = await fixture(t, {
    active: true,
    enabled: true,
    dropIns: '/etc/systemd/user/lloom.service.d/override.conf'
  });
  await f.writeUnit();
  for (const action of [installGatewayService, stopGatewayService, uninstallGatewayService]) {
    await assert.rejects(action(f.config, { ...f.options, ...apply }), /drop-in/);
  }
  assert.equal(
    f.calls.every((c) => c[0] === 'systemctl' && c[2] === 'show'),
    true
  );
  const d = await doctorGatewayService(f.config, f.options);
  assert.equal(d.ok, false);
  assert.equal(d.checks.find((c) => c.id === 'systemd-loaded-unit-match').ok, false);
});
