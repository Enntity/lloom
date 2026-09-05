import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preserveSparkRoutes } from '../scripts/preserve-spark-routes.mjs';

const routingBefore = {
  aliases: { ds4fv: { members: ['cloud-qwen', 'local'], suspendedMembers: ['local'] } },
  defaults: { chatModel: 'cloud-qwen' },
  routing: { mode: 'fallback' }
};
const routingAfter = {
  aliases: { ds4fv: { members: ['local', 'cloud-ds'] } },
  defaults: { chatModel: 'local' },
  runtimes: { local: { recipe: { version: 3 } } },
  clientCatalog: { changed: true }
};
const preserved = preserveSparkRoutes(routingBefore, routingAfter);
assert.deepEqual(preserved.aliases, routingBefore.aliases);
assert.deepEqual(preserved.defaults, routingBefore.defaults);
assert.deepEqual(preserved.runtimes, routingAfter.runtimes);
assert.equal(Object.hasOwn(preserved, 'clientCatalog'), false);
assert.notDeepEqual(routingAfter.aliases, routingBefore.aliases);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'remote-stage-spark-worker.sh');
const headInstallScript = await fs.readFile(path.join(root, 'scripts', 'remote-install-spark.sh'), 'utf8');
assert.match(headInstallScript, /adopting keep-warm startup/);
assert.match(headInstallScript, /status" == "starting"/);
assert.match(headInstallScript, /status" == "running"/);
assert.match(headInstallScript, /runtime_previously_known="false"/);
assert.match(headInstallScript, /if \[\[ -n "\$runtime" \]\] && lloom runtimes "\$runtime" >\/dev\/null 2>&1; then/);
assert.match(headInstallScript, /if \[\[ "\$runtime_previously_known" == "true" \]\]; then/);
assert(
  headInstallScript.indexOf('lloom runtime-stop "$runtime" >/dev/null') <
    headInstallScript.indexOf('npm install --global --prefix "$HOME/.local" "$artifact"'),
  'an existing targeted runtime must release package bind mounts before npm replaces the installed tree'
);
assert.match(headInstallScript, /\[\[ "\$keep_warm" == "true" \]\] \|\| lloom runtime-stop/);
assert.match(
  headInstallScript,
  /lloom runtime-start "\$runtime" --no-force/,
  'deploy adopts a same-spec startup that raced the service restart instead of forcing a second model reload'
);
assert.doesNotMatch(
  headInstallScript,
  /enn presence (disable|enable)/,
  'LLooM deployment must not manipulate independent Runtime Presence state'
);
assert.match(headInstallScript, /apply-spark-route-catalog\.mjs/);
assert(
  headInstallScript.indexOf('apply-spark-route-catalog.mjs') <
    headInstallScript.lastIndexOf('systemctl --user restart'),
  'leader route catalog must be reconciled before the gateway restart'
);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-spark-deploy-'));
const bin = path.join(home, '.local', 'bin');
const installed = path.join(home, '.local', 'lib', 'node_modules', 'lloom');
const releaseDir = path.join(home, 'release');
const lloomDir = path.join(home, '.lloom');
await Promise.all([
  fs.mkdir(bin, { recursive: true }),
  fs.mkdir(installed, { recursive: true }),
  fs.mkdir(releaseDir, { recursive: true }),
  fs.mkdir(path.join(lloomDir, 'releases'), { recursive: true })
]);

const artifact = path.join(releaseDir, 'lloom-new.tgz');
const manifest = `${artifact}.manifest.json`;
const bytes = Buffer.from('new release');
const commit = '1234567890abcdef1234567890abcdef12345678';
await fs.writeFile(artifact, bytes);
await fs.writeFile(
  manifest,
  `${JSON.stringify({ commit, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })}\n`
);
await fs.writeFile(path.join(installed, 'package.json'), '{"name":"lloom","version":"old"}\n');
await fs.writeFile(path.join(lloomDir, 'config.json'), '{"recipe":"old"}\n');
await fs.writeFile(path.join(lloomDir, 'releases', 'current.manifest.json'), '{"commit":"old"}\n');

await executable(
  'npm',
  `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "pack" ]]; then
  for ((i=1; i<=$#; i++)); do
    if [[ "\${!i}" == "--pack-destination" ]]; then j=$((i+1)); destination="\${!j}"; fi
  done
  printf 'old package' > "$destination/lloom-old.tgz"
  printf '[{"filename":"lloom-old.tgz"}]\\n'
elif [[ "$1" == "install" ]]; then
  artifact="\${@: -3:1}"
  if [[ "$artifact" == *package.before.worker.tgz ]]; then version=old; else version=new; fi
  mkdir -p "$HOME/.local/lib/node_modules/lloom"
  printf '{"name":"lloom","version":"%s"}\\n' "$version" > "$HOME/.local/lib/node_modules/lloom/package.json"
else
  exit 2
fi
`
);
await executable('systemctl', '#!/usr/bin/env bash\nexit 0\n');
await executable('lloom', '#!/usr/bin/env bash\n[[ "$1" == "models" ]]\n');

run('install');
assert.equal(JSON.parse(await fs.readFile(path.join(installed, 'package.json'))).version, 'new');
assert.equal(
  JSON.parse(await fs.readFile(path.join(lloomDir, 'config.json'))).server.inferenceEnabled,
  false,
  'worker deployment must make direct inference fail closed'
);
assert.equal(JSON.parse(await fs.readFile(path.join(lloomDir, 'releases', 'current.manifest.json'))).commit, commit);
await fs.access(path.join(lloomDir, 'releases', commit.slice(0, 12), 'worker.prepared'));

await fs.writeFile(path.join(lloomDir, 'config.json'), '{"recipe":"new"}\n');
run('rollback');
assert.equal(JSON.parse(await fs.readFile(path.join(installed, 'package.json'))).version, 'old');
assert.equal(JSON.parse(await fs.readFile(path.join(lloomDir, 'config.json'))).recipe, 'old');
assert.equal(JSON.parse(await fs.readFile(path.join(lloomDir, 'releases', 'current.manifest.json'))).commit, 'old');

run('install');
run('finalize');
assert.equal(JSON.parse(await fs.readFile(path.join(installed, 'package.json'))).version, 'new');
await assert.rejects(fs.access(path.join(lloomDir, 'releases', commit.slice(0, 12), 'worker.prepared')));

await fs.rm(home, { recursive: true, force: true });
console.log('spark deploy tests passed');

async function executable(name, contents) {
  const target = path.join(bin, name);
  await fs.writeFile(target, contents);
  await fs.chmod(target, 0o755);
}

function run(action) {
  const result = spawnSync('bash', [script, action, artifact, manifest], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
