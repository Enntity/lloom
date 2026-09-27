// Focused tests for explicit numeric memory-policy CLI configuration.
//
// These spawn `node bin/lloom.mjs runtime-policy` against a CPU-only temp
// config file. No real gateway, runtimes, or network calls are involved.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'bin', 'lloom.mjs');

const directories = [];
after(async () => {
  await Promise.all(directories.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// Minimal config satisfying the real loadConfig validation.
function baseConfig(extra = {}) {
  return {
    runtimePolicy: {
      memorySafety: { mode: 'enforce', pollIntervalMs: 250 }
    },
    models: [{ id: 'm1', runtime: 'rt1', backend: 'test' }],
    runtimes: { rt1: { command: 'echo' } },
    backends: { test: { type: 'openai', baseUrl: 'http://127.0.0.1:12345/v1' } },
    aliases: {},
    ...extra
  };
}

async function writeConfig(config) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-policy-'));
  directories.push(dir);
  const p = path.join(dir, 'config.json');
  await fs.writeFile(p, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return p;
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: os.tmpdir(), LLOOM_CONFIG: '' }
      },
      (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr });
      }
    );
  });
}

test('dry-run reports selected fields only and leaves config bytes unchanged', async () => {
  const config = baseConfig({
    cluster: { nodes: { nodeA: { resources: { reserveMemoryGb: 8 } } } }
  });
  const p = await writeConfig(config);
  const before = await fs.readFile(p, 'utf8');

  const result = await runCli([
    'runtime-policy',
    '--config',
    p,
    '--max-memory-utilization',
    '0.85',
    '--reserve-memory-gb',
    '12'
  ]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.before.runtimePolicy.maxMemoryUtilization, null);
  assert.equal(report.after.runtimePolicy.maxMemoryUtilization, 0.85);
  assert.equal(report.after.memorySafety.minAvailableMemoryGb, 12);
  assert.equal(report.after.runtimePolicy.reserveMemoryGb, 12);
  // Only selected fields + node overrides + warnings; no whole config.
  assert.deepEqual(Object.keys(report).sort(), [
    'after',
    'before',
    'changed',
    'mode',
    'nodeOverrides',
    'ok',
    'warnings'
  ]);
  assert.equal(result.stdout.includes('http://127.0.0.1:12345'), false, 'config body must not be echoed');
  assert.equal(await fs.readFile(p, 'utf8'), before, 'dry-run must not write config bytes');
});

test('apply without --yes writes nothing', async () => {
  const p = await writeConfig(baseConfig());
  const before = await fs.readFile(p, 'utf8');
  const result = await runCli(['runtime-policy', '--config', p, '--max-memory-utilization', '0.7', '--apply']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--yes/);
  assert.equal(await fs.readFile(p, 'utf8'), before);
});

test('apply updates guard and admission fields, preserves unrelated config and node overrides', async () => {
  const config = baseConfig({
    gatewayNote: 'keep me',
    cluster: { nodes: { nodeA: { resources: { reserveMemoryGb: 8, memoryBudgetGb: 200 } } } },
    runtimePolicy: {
      memorySafety: { mode: 'enforce', pollIntervalMs: 250 },
      maxMemoryUtilization: 0.5,
      memoryBudgetGb: 0
    }
  });
  delete config.runtimePolicy.memoryBudgetGb;
  const p = await writeConfig(config);

  const result = await runCli([
    'runtime-policy',
    '--config',
    p,
    '--apply',
    '--yes',
    '--max-memory-utilization',
    '0.9',
    '--reserve-memory-gb',
    '16'
  ]);
  assert.equal(result.code, 0, result.stderr);
  const applied = JSON.parse(result.stdout);
  assert.equal(applied.applied, true);

  const written = JSON.parse(await fs.readFile(p, 'utf8'));
  assert.equal(written.runtimePolicy.maxMemoryUtilization, 0.9);
  assert.equal(written.runtimePolicy.memorySafety.maxMemoryUtilization, 0.9);
  assert.equal(written.runtimePolicy.reserveMemoryGb, 16);
  assert.equal(written.runtimePolicy.memorySafety.minAvailableMemoryGb, 16);
  // Mode and polling preserved; no yolo introduced.
  assert.equal(written.runtimePolicy.memorySafety.mode, 'enforce');
  assert.equal(written.runtimePolicy.memorySafety.pollIntervalMs, 250);
  assert.equal(written.gatewayNote, 'keep me');
  assert.deepEqual(written.cluster.nodes.nodeA.resources, { reserveMemoryGb: 8, memoryBudgetGb: 200 });
});

test('invalid numeric flags are rejected and write nothing', async () => {
  const p = await writeConfig(baseConfig());
  const before = await fs.readFile(p, 'utf8');
  const cases = [
    ['--max-memory-utilization'],
    ['--max-memory-utilization', 'NaN'],
    ['--max-memory-utilization', 'Infinity'],
    ['--max-memory-utilization', '0'],
    ['--max-memory-utilization', '1.5'],
    ['--reserve-memory-gb', '0'],
    ['--reserve-memory-gb', 'abc'],
    ['--max-memory-utilization=0.95'],
    ['--max-memory-utilization', '0.8', '--max-memory-utilization', '0.95'],
    ['--reserve-memory-gb']
  ];
  for (const flags of cases) {
    const result = await runCli(['runtime-policy', '--config', p, '--apply', '--yes', ...flags]);
    assert.notEqual(result.code, 0, `expected failure for ${flags.join(' ')}`);
    assert.equal(await fs.readFile(p, 'utf8'), before, `config changed for ${flags.join(' ')}`);
  }
});

test('top-level absolute memoryBudgetGb fails actionably instead of changing an unused percentage', async () => {
  const p = await writeConfig(
    baseConfig({ runtimePolicy: { memoryBudgetGb: 220, memorySafety: { mode: 'enforce', pollIntervalMs: 250 } } })
  );
  const before = await fs.readFile(p, 'utf8');
  for (const mode of [[], ['--apply', '--yes']]) {
    const result = await runCli(['runtime-policy', '--config', p, '--max-memory-utilization', '0.8', ...mode]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /memoryBudgetGb/);
    assert.equal(await fs.readFile(p, 'utf8'), before);
  }
});

test('runtime-plan never mutates and rejects numeric/apply flags', async () => {
  const p = await writeConfig(baseConfig());
  const before = await fs.readFile(p, 'utf8');

  const withNumeric = await runCli(['runtime-plan', '--config', p, '--max-memory-utilization', '0.8']);
  assert.match(withNumeric.stderr, /read-only/);
  const withApply = await runCli(['runtime-plan', '--config', p, '--apply', '--yes']);
  assert.match(withApply.stderr, /read-only/);
  assert.equal(await fs.readFile(p, 'utf8'), before, 'runtime-plan must never write config');
});

test('--yes without --apply is rejected without writing', async () => {
  const p = await writeConfig(baseConfig());
  const before = await fs.readFile(p, 'utf8');
  const result = await runCli(['runtime-policy', '--config', p, '--max-memory-utilization', '0.8', '--yes']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--yes requires --apply/);
  assert.equal(await fs.readFile(p, 'utf8'), before);
});
