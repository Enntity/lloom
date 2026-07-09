#!/usr/bin/env node
import path from 'node:path';
import { loadConfig, repoRoot } from '../src/config.mjs';
import { createLloomHostServer } from '../src/host-server.mjs';

function usage() {
  return `Usage:
  lloom-host serve [--config path] [--host host] [--port port] [--index path] [--recipes-root path] [--benchmarks-root path] [--submissions-root path] [--backend-catalog path] [--publisher id] [--key-id id --private-key path [--public-key path]]

Environment:
  LLOOM_CONFIG  Path to gateway-compatible config JSON used for recipe-pack validation
`;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function parsePort(value, fallback) {
  if (value == null) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port must be an integer from 1 to 65535');
  }
  return port;
}

function resolveRepoPath(value) {
  if (!value) return undefined;
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args[0] === '--help' ||
    args[0] === '-h' ||
    args[0] === 'help' ||
    args.includes('--help') ||
    args.includes('-h')
  ) {
    console.log(usage());
    return;
  }
  const command = args[0] ?? 'serve';
  if (command !== 'serve') {
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const config = await loadConfig(argValue(args, '--config') ?? process.env.LLOOM_CONFIG);
  const host = argValue(args, '--host') ?? '127.0.0.1';
  const port = parsePort(argValue(args, '--port'), 8110);
  const hostData = config.communityHost ?? {};
  const app = createLloomHostServer(config, {
    host,
    port,
    indexPath: resolveRepoPath(argValue(args, '--index') ?? hostData.indexPath),
    recipesRoot: resolveRepoPath(argValue(args, '--recipes-root') ?? hostData.recipesRoot),
    benchmarksRoot: resolveRepoPath(argValue(args, '--benchmarks-root') ?? hostData.benchmarksRoot),
    submissionsRoot: argValue(args, '--submissions-root'),
    backendCatalogPath: resolveRepoPath(argValue(args, '--backend-catalog') ?? hostData.backendCatalogPath),
    publisher: argValue(args, '--publisher'),
    keyId: argValue(args, '--key-id'),
    privateKeyPath: resolveRepoPath(argValue(args, '--private-key')),
    publicKeyPath: resolveRepoPath(argValue(args, '--public-key'))
  });
  await app.listen();
  console.log(`LLooM host listening on http://${host}:${port}`);
}

main().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
