import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { mutateConfigSource } from './config-mutation.mjs';
import { resolveManagedEnvironmentValue } from './managed-environment.mjs';
const exec = promisify(execFile);

export function launchAgentMatchesConfig(args, sourcePath) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return false;
  let argv = args;
  if (['sh', 'bash', 'zsh'].includes(path.basename(argv[0] ?? ''))) {
    if (argv.length !== 3 || argv[1] !== '-c') return false;
    const tail = argv[2].match(/(?:^|;\s*)exec\s+([^;]+)$/)?.[1];
    if (!tail || /[$`\\\n\r<>|&]/.test(tail)) return false;
    const tokens = tail.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
    if (tokens.join(' ') !== tail.trim()) return false;
    argv = tokens.map((v) => (/^["']/.test(v) ? v.slice(1, -1) : v));
  }
  if (path.basename(argv[0] ?? '') === 'node') {
    if (!argv[1]?.endsWith('/lloom/bin/lloom.mjs')) return false;
    argv = argv.slice(1);
  } else if (!['lloom', 'lloom.mjs'].includes(path.basename(argv[0] ?? ''))) return false;
  return (
    argv.length === 4 &&
    argv[1] === 'serve' &&
    argv[2] === '--config' &&
    path.resolve(argv[3]) === path.resolve(sourcePath)
  );
}

// The installed gateway's SIGTERM path retains managed model processes.
// Gate inference first, wait for acknowledgement and all metrics to drain,
// restart only the local user service, then restore the prior admission flag.
export async function restartGatewayService(
  config,
  {
    apply = false,
    yes = false,
    timeoutMs = 300000,
    platform = process.platform,
    serviceLabel = 'com.lloom.gateway',
    uid = process.getuid?.(),
    fetchFn = fetch,
    run = exec,
    pause = sleep
  } = {}
) {
  if (!['linux', 'darwin'].includes(platform)) throw new Error('Managed service restart requires systemd or launchd');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(serviceLabel)) throw new Error('Invalid launchd service label');
  if (platform === 'darwin' && !Number.isInteger(uid)) throw new Error('Cannot identify launchd user');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 7200000) throw new Error('Invalid drain timeout');
  const darwin = platform === 'darwin';
  const launchTarget = `gui/${uid}/${serviceLabel}`;
  const plan = {
    service: darwin ? serviceLabel : 'lloom.service',
    manager: darwin ? 'launchd' : 'systemd-user',
    preserveRuntimes: true
  };
  if (!apply) return { ...plan, applied: false };
  if (!yes) throw new Error('Service restart requires --apply --yes');
  const key = resolveManagedEnvironmentValue(config.security?.adminApiKeys?.[0] ?? config.security?.apiKeys?.[0]);
  const host = ['0.0.0.0', '::'].includes(config.server.host) ? '127.0.0.1' : config.server.host;
  const localAddresses = new Set([
    '127.0.0.1',
    '::1',
    'localhost',
    ...Object.values(os.networkInterfaces())
      .flat()
      .filter(Boolean)
      .map((n) => n.address)
  ]);
  if (!localAddresses.has(host)) throw new Error('Service control requires a local interface address');
  const base = `http://${host.includes(':') ? '[' + host + ']' : host}:${config.server.port}`;
  const get = async (route) => {
    const r = await fetchFn(base + route, {
      headers: { authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error('Gateway inspection failed');
    return r.json();
  };
  const node = await get('/gateway/node');
  if (!config.cluster?.nodeId || node.node?.id !== config.cluster.nodeId)
    throw new Error('Gateway node identity does not match local configuration');
  // Refuse inactive or unrelated service units before changing admission.
  let previousPid;
  if (darwin) {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', serviceLabel + '.plist');
    const keepAlive = (await run('plutil', ['-extract', 'KeepAlive', 'raw', '-o', '-', plist])).stdout.trim();
    if (!['true', '1'].includes(keepAlive)) throw new Error('LaunchAgent restart requires KeepAlive=true');
    const args = JSON.parse((await run('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', plist])).stdout);
    if (!launchAgentMatchesConfig(args, config.sourcePath))
      throw new Error('LaunchAgent does not name the selected configuration');
    const unit = await run('launchctl', ['print', launchTarget]);
    if (!/state = running/.test(unit.stdout)) throw new Error('Local LaunchAgent is not running');
    previousPid = unit.stdout.match(/\bpid = (\d+)/)?.[1];
    if (!previousPid) throw new Error('Cannot identify LaunchAgent process');
  } else {
    const unit = await run('systemctl', ['--user', 'show', 'lloom.service', '--property=ActiveState', '--value']);
    if (unit.stdout.trim() !== 'active') throw new Error('Local lloom.service is not active');
  }
  const raw = JSON.parse(await fs.readFile(config.sourcePath, 'utf8'));
  const hadFlag = Object.hasOwn(raw.server ?? {}, 'inferenceEnabled');
  const previous = raw.server?.inferenceEnabled;
  let gated = false;
  const deadline = Date.now() + timeoutMs;
  const until = async (check) => {
    while (Date.now() < deadline) {
      if (await check()) return;
      await pause(250);
    }
    throw new Error('Gateway did not drain before the deadline');
  };
  try {
    await mutateConfigSource(config, (c) => {
      c.server ??= {};
      if (c.server.inferenceEnabled !== previous) throw new Error('Admission setting changed');
      c.server.inferenceEnabled = false;
    });
    gated = true;
    await until(async () => (await get('/gateway/status')).server?.inferenceEnabled === false);
    await until(async () => {
      const m = await get('/gateway/metrics');
      if (!Array.isArray(m.active)) throw new Error('Gateway lacks active-request telemetry');
      return m.active.length === 0;
    });
    if (darwin) await run('launchctl', ['kill', 'SIGTERM', launchTarget], { timeout: 60000 });
    else await run('systemctl', ['--user', 'restart', 'lloom.service'], { timeout: 60000 });
    const healthDeadline = Date.now() + 60000;
    let healthy = false;
    while (Date.now() < healthDeadline) {
      try {
        if (darwin) {
          const state = (await run('launchctl', ['print', launchTarget])).stdout;
          const pid = state.match(/\bpid = (\d+)/)?.[1];
          if (!pid || pid === previousPid) {
            await pause(500);
            continue;
          }
        }
        const n = await get('/gateway/node');
        healthy = n.node?.id === config.cluster.nodeId;
        if (healthy) break;
      } catch {}
      await pause(500);
    }
    if (!healthy) throw new Error('Restarted gateway did not become healthy');
  } finally {
    if (gated)
      await mutateConfigSource(config, (c) => {
        if (c.server?.inferenceEnabled !== false)
          throw new Error('Admission setting changed externally; refusing to overwrite it');
        if (hadFlag) c.server.inferenceEnabled = previous;
        else delete c.server.inferenceEnabled;
      });
  }
  // Wait for the running process to adopt the restored setting as well.
  const restoredDeadline = Date.now() + 10000;
  while (Date.now() < restoredDeadline) {
    const s = await get('/gateway/status');
    if ((s.server?.inferenceEnabled !== false) === (previous !== false)) return { ...plan, applied: true };
    await pause(250);
  }
  throw new Error('Admission was restored on disk but the gateway has not acknowledged it');
}
