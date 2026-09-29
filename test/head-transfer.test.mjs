import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { runHeadPreparation, validateSshHost, sourceReadScript } from '../src/head-transfer.mjs';

test('SSH hosts reject shell syntax and option injection', () => {
  for (const host of ['-oProxyCommand=x', 'host;echo x', '$(id)', 'a\nb', 'a b', '@bad'])
    assert.throws(() => validateSshHost(host));
  assert.equal(validateSshHost('admin@media-node'), 'admin@media-node');
});
test('source and target SSH use stdin, fixed commands and strict apply guard', async () => {
  const calls = [];
  const secret = 'private-fixture-key';
  const transport = async (...args) => {
    calls.push(args);
    return calls.length === 1
      ? JSON.stringify({ backends: { x: { apiKey: secret } } })
      : JSON.stringify({ ok: true, applied: false });
  };
  await assert.rejects(
    runHeadPreparation({ sourceSsh: 'source', targetSsh: 'target', apply: true, transport }),
    /--yes/
  );
  assert.equal(calls.length, 0);
  const r = await runHeadPreparation({ sourceSsh: 'source', targetSsh: 'target', includeSecrets: true, transport });
  assert.equal(r.ok, true);
  assert.equal(calls[0][1], 'node --input-type=module');
  assert.ok(!calls[1][1].includes(secret));
  assert.ok(calls[1][2].includes(secret));
  assert.ok(!calls[1][1].includes('--apply'));
  assert.ok(calls[1][1].includes('--from -'));
});
test('SSH read script never writes a source-host file', () => {
  const script = sourceReadScript(true);
  assert.ok(!script.includes('writeFile'));
  assert.ok(script.includes('process.stdout.write'));
});
test('stdin transport does not require a temporary secret file', async () => {
  const r = await runHeadPreparation({
    sourcePath: '-',
    targetSsh: 'target',
    stdin: Readable.from(['{"models":[]}']),
    transport: async (h, cmd, input) => {
      assert.equal(input.toString(), '{"models":[]}');
      return '{"ok":true}';
    }
  });
  assert.equal(r.ok, true);
});

test('local file sources can be sent directly to a target', async (t) => {
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'head-file-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'source.json');
  await fs.writeFile(file, '{"models":[]}');
  const result = await runHeadPreparation({
    sourcePath: file,
    targetSsh: 'target',
    transport: async (h, c, input) => {
      assert.equal(input.toString(), '{"models":[]}');
      return '{"ok":true}';
    }
  });
  assert.equal(result.ok, true);
});
test('SSH reader omits literal secrets unless explicitly requested', async (t) => {
  const { promises: fs } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'head-secret-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '.lloom'));
  const cfg = path.join(dir, '.lloom/config.json');
  await fs.writeFile(
    cfg,
    JSON.stringify({ backends: { b: { baseUrl: 'https://api.example.com', apiKey: 'fixture-secret' } } })
  );
  for (const allow of [false, true]) {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', sourceReadScript(allow)],
      { env: { ...process.env, HOME: dir } }
    );
    assert.equal(stdout.includes('fixture-secret'), allow);
  }
});

test('stdin credentials are redacted before target transport without opt-in', async () => {
  const result = await runHeadPreparation({
    sourcePath: '-',
    targetSsh: 'target',
    stdin: Readable.from([JSON.stringify({ backends: { b: { apiKey: 'fixture-secret' } } })]),
    transport: async (h, c, input) => {
      assert.ok(!input.toString().includes('fixture-secret'));
      return '{"ok":false}';
    }
  });
  assert.equal(result.ok, false);
});
