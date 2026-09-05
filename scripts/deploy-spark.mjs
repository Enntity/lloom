#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRelease, inherit, parseArgs } from './release-lib.mjs';

const flags = parseArgs(process.argv.slice(2));
const host = String(flags.host || process.env.ENNTITY_SPARK_HOST || '').trim();
if (!host) throw new Error('Pass --host user@host or set ENNTITY_SPARK_HOST');
const workerHosts = splitHosts(flags['worker-host'] || process.env.ENNTITY_SPARK_WORKER_HOSTS);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await requireClusterWorkers(root, flags.recipe, workerHosts);
const release = await buildRelease({ root, allowDirty: !!flags['allow-dirty'], runTests: !flags['skip-tests'] });
const remoteDir = `/tmp/lloom-release-${release.manifest.commit.slice(0, 12)}`;
const ssh = options(flags, false),
  scp = options(flags, true);
for (const target of [host, ...workerHosts]) await stageRelease(target);
const remoteArgs = [
  'bash',
  `${remoteDir}/install.sh`,
  `${remoteDir}/${path.basename(release.artifact)}`,
  `${remoteDir}/${path.basename(release.manifestPath)}`
];
if (flags.runtime) remoteArgs.push(String(flags.runtime));
else remoteArgs.push('-');
remoteArgs.push(String(flags.entity || 'Jinx'));
remoteArgs.push(String(flags.recipe || '-'));
remoteArgs.push(`${remoteDir}/spark-route-catalog.json`);
remoteArgs.push(flags['preserve-routes'] ? 'true' : 'false');
const stagedWorkers = [];
try {
  for (const workerHost of workerHosts) {
    await workerAction(workerHost, 'install');
    stagedWorkers.push(workerHost);
  }
  await inherit('ssh', [...ssh, host, ...remoteArgs], root);
} catch (error) {
  for (const workerHost of stagedWorkers.reverse()) {
    try {
      await workerAction(workerHost, 'rollback');
    } catch (rollbackError) {
      console.error(`Worker rollback failed on ${workerHost}: ${rollbackError.message}`);
    }
  }
  throw error;
}
for (const workerHost of stagedWorkers) await workerAction(workerHost, 'finalize');
console.log(
  JSON.stringify(
    {
      deployed: true,
      host,
      workerHosts,
      entity: flags.entity || 'Jinx',
      runtime: flags.runtime || null,
      recipe: flags.recipe || null,
      commit: release.manifest.commit,
      sha256: release.manifest.sha256
    },
    null,
    2
  )
);

async function stageRelease(target) {
  const scpHost = scpHostSpec(target);
  await inherit('ssh', [...ssh, target, `mkdir -p '${remoteDir}'`], root);
  await inherit('scp', [...scp, release.artifact, release.manifestPath, `${scpHost}:${remoteDir}/`], root);
  await inherit(
    'scp',
    [...scp, path.join(root, 'scripts', 'remote-install-spark.sh'), `${scpHost}:${remoteDir}/install.sh`],
    root
  );
  if (target === host) {
    await inherit(
      'scp',
      [
        ...scp,
        path.join(root, 'deploy', 'dgx-spark', 'config.json'),
        `${scpHost}:${remoteDir}/spark-route-catalog.json`
      ],
      root
    );
  }
  if (target !== host) {
    await inherit(
      'scp',
      [...scp, path.join(root, 'scripts', 'remote-stage-spark-worker.sh'), `${scpHost}:${remoteDir}/stage-worker.sh`],
      root
    );
  }
}

async function workerAction(workerHost, action) {
  await inherit(
    'ssh',
    [
      ...ssh,
      workerHost,
      'bash',
      `${remoteDir}/stage-worker.sh`,
      action,
      `${remoteDir}/${path.basename(release.artifact)}`,
      `${remoteDir}/${path.basename(release.manifestPath)}`
    ],
    root
  );
}

async function requireClusterWorkers(repositoryRoot, recipeId, workers) {
  if (!recipeId) return;
  if (!/^[a-zA-Z0-9._-]+$/.test(String(recipeId))) throw new Error(`Invalid recipe id: ${recipeId}`);
  const recipePath = path.join(repositoryRoot, 'recipes', `${recipeId}.json`);
  const recipe = JSON.parse(await fs.readFile(recipePath, 'utf8'));
  const nodeCount = Number(recipe.requirements?.cluster?.nodes || 1);
  const requiredWorkers = Math.max(0, nodeCount - 1);
  if (workers.length !== requiredWorkers) {
    throw new Error(`Recipe ${recipeId} requires ${requiredWorkers} worker host(s); pass --worker-host host[,host...]`);
  }
}

function splitHosts(value) {
  if (!value || value === true) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function options(input, isScp) {
  const args = [];
  if (input['host-key-alias']) args.push('-o', `HostKeyAlias=${input['host-key-alias']}`);
  if (input.port) args.push(isScp ? '-P' : '-p', String(input.port));
  return args;
}

function scpHostSpec(value) {
  const at = value.lastIndexOf('@');
  const user = at >= 0 ? value.slice(0, at + 1) : '';
  const address = at >= 0 ? value.slice(at + 1) : value;
  return address.includes(':') && !address.startsWith('[') ? `${user}[${address}]` : value;
}
