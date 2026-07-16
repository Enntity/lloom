import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function buildRelease({ root, allowDirty = false, runTests = true } = {}) {
  const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: root });
  if (status.trim() && !allowDirty)
    throw new Error('Refusing to package a dirty tree. Commit the release first, or pass --allow-dirty.');
  const { stdout: sha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
  const commit = sha.trim();
  if (runTests) {
    await inherit('npm', ['run', 'check'], root);
    await inherit('npm', ['test'], root);
  }
  const outputDir = path.join(root, 'dist', 'releases', commit.slice(0, 12));
  await fs.mkdir(outputDir, { recursive: true });
  const { stdout } = await execFileAsync('npm', ['pack', '--json', '--pack-destination', outputDir], {
    cwd: root,
    env: { ...process.env, NPM_CONFIG_CACHE: path.join(root, '.cache', 'npm-release') },
    maxBuffer: 10 * 1024 * 1024
  });
  const packed = JSON.parse(stdout)[0];
  const artifact = path.join(outputDir, packed.filename);
  const bytes = await fs.readFile(artifact);
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = {
    schemaVersion: 1,
    package: packageJson.name,
    version: packageJson.version,
    commit,
    dirty: !!status.trim(),
    artifact: packed.filename,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    files: packed.files.map(({ path: file, size }) => ({ path: file, size })),
    builtAt: new Date().toISOString()
  };
  const manifestPath = `${artifact}.manifest.json`;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { artifact, manifestPath, manifest };
}

export async function inherit(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${signal || code})`))
    );
  });
}

export function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) continue;
    const [name, inline] = raw.slice(2).split('=', 2);
    if (inline !== undefined) flags[name] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) flags[name] = argv[++index];
    else flags[name] = true;
  }
  return flags;
}
