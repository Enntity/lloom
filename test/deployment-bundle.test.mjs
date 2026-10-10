import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  buildDeploymentBundle,
  dependencyVersionAllows,
  inspectDeploymentBundle
} from '../scripts/build-deployment-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

test('dependency range contract accepts the installed undici pin and rejects links', () => {
  assert.equal(dependencyVersionAllows('^8.11.2', '8.11.2'), true);
  assert.equal(dependencyVersionAllows('^8.11.2', '9.0.0'), false);
  assert.equal(dependencyVersionAllows('file:../undici', '8.11.2'), false);
  assert.equal(dependencyVersionAllows('*', '8.11.2'), false);
});

test('actual LLooM bundle round trips with stable inventory and direct closure', async () => {
  const runtimeContractDigest = 'a'.repeat(64);
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-bundle-output-'));
  try {
    const first = await buildDeploymentBundle({ root, runtimeContractDigest, allowDirty: true, outputDir });
    const firstInspection = await inspectDeploymentBundle(first);
    const installedUndici = JSON.parse(
      await fs.readFile(path.join(root, 'node_modules', 'undici', 'package.json'), 'utf8')
    );

    assert.equal(firstInspection.packageJson.name, 'lloom');
    assert.deepEqual(first.manifest.dependencyClosure, { undici: installedUndici.version });
    assert.equal(first.manifest.runtimeContractDigest, runtimeContractDigest);
    assert.equal(first.manifest.artifact, path.basename(first.artifact));
    assert.ok(first.manifest.files.some((entry) => entry.path === 'package.json'));
    assert.ok(first.manifest.files.some((entry) => entry.path === 'node_modules/undici/package.json'));
    assert.equal(firstInspection.files.length, first.manifest.files.length);

    const second = await buildDeploymentBundle({ root, runtimeContractDigest, allowDirty: true, outputDir });
    assert.equal(second.manifest.sha256, first.manifest.sha256);
    assert.equal(second.manifest.treeSha256, first.manifest.treeSha256);
    assert.equal(second.manifest.dependencyDigest, first.manifest.dependencyDigest);
    assert.deepEqual(second.manifest.files, first.manifest.files);
    await inspectDeploymentBundle(second);
    await assert.rejects(
      buildDeploymentBundle({ root, runtimeContractDigest: 'b'.repeat(64), allowDirty: true, outputDir }),
      /refusing to replace existing reviewed bundle file/
    );
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test('bundle inspection rejects symlink members before extraction', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-unsafe-bundle-'));
  try {
    const source = path.join(temporary, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'target.txt'), 'safe\n');
    await fs.symlink('target.txt', path.join(source, 'link.txt'));
    const artifact = path.join(temporary, 'unsafe.tar');
    await execFileAsync('tar', [
      '--create',
      '--format',
      'ustar',
      '--file',
      artifact,
      '--directory',
      source,
      'link.txt'
    ]);
    const bytes = await fs.readFile(artifact);
    const manifestPath = `${artifact}.manifest.json`;
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify({ sha256: crypto.createHash('sha256').update(bytes).digest('hex') })}\n`
    );
    await assert.rejects(inspectDeploymentBundle({ artifact, manifestPath }), /link or special file/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
