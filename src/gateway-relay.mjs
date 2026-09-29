import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveManagedEnvironmentValue } from './managed-environment.mjs';
const exec = promisify(execFile);
const hash = (s) => createHash('sha256').update(s).digest('hex');

// Move an existing systemd socket proxy to this node's directly bound gateway.
// The socket remains installed; a drop-in preserves the original unit for rollback.
export async function retargetGatewayRelay(
  config,
  { unit, apply = false, yes = false, expectedUnitHash, platform = process.platform, run = exec, fetchFn = fetch } = {}
) {
  if (platform !== 'linux') throw new Error('Socket relay control requires Linux systemd');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(unit ?? '')) throw new Error('Specify a valid --unit name without suffix');
  const host = config.server.host,
    port = config.server.port;
  const addresses = new Set(
    Object.values(os.networkInterfaces())
      .flat()
      .filter(Boolean)
      .map((n) => n.address)
  );
  if (!addresses.has(host) || ['127.0.0.1', '::1', '0.0.0.0', '::'].includes(host))
    throw new Error('Relay destination must be a specific non-loopback local interface');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port');
  const endpoint = `http://${host.includes(':') ? '[' + host + ']' : host}:${port}`;
  const key = resolveManagedEnvironmentValue(config.security?.adminApiKeys?.[0] ?? config.security?.apiKeys?.[0]);
  const response = await fetchFn(endpoint + '/gateway/node', {
    headers: { authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok || (await response.json()).node?.id !== config.cluster?.nodeId)
    throw new Error('Direct gateway is not healthy or has a different node identity');
  const name = unit + '.service';
  const current = (await run('systemctl', ['cat', name])).stdout;
  if (!/^ExecStart=\/usr\/lib\/systemd\/systemd-socket-proxyd\s+\S+$/m.test(current))
    throw new Error('Selected unit is not a supported socket proxy');
  const unitHash = hash(current);
  const dir = `/etc/systemd/system/${name}.d`;
  const target = `${dir}/90-lloom-head.conf`;
  const content = `[Service]\nExecStart=\nExecStart=/usr/lib/systemd/systemd-socket-proxyd ${host.includes(':') ? '[' + host + ']' : host}:${port}\n`;
  let prior;
  try {
    prior = await fs.readFile(target, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const report = {
    unit: name,
    endpoint,
    node: config.cluster.nodeId,
    unitHash,
    changed: prior !== content,
    applied: false
  };
  if (!apply || prior === content) return report;
  if (!yes || !expectedUnitHash) throw new Error('Relay cutover requires --apply --yes --expect-unit HASH');
  if (expectedUnitHash !== unitHash) throw new Error('Relay unit changed since the reviewed plan');
  try {
    await run('sudo', ['-n', 'true']);
  } catch {
    throw new Error(
      'Relay cutover requires system administrator privileges; run the reviewed command from an authenticated administrator terminal'
    );
  }
  const backupDir = await fs.mkdtemp(path.join(path.dirname(config.sourcePath), 'relay-backup-'));
  await fs.chmod(backupDir, 0o700);
  await fs.writeFile(path.join(backupDir, 'unit.before.txt'), current, { mode: 0o600 });
  await fs.writeFile(
    path.join(backupDir, 'state.json'),
    JSON.stringify({ unit: name, target, prior: prior ?? null, endpoint }),
    { mode: 0o600 }
  );
  const candidate = path.join(backupDir, 'candidate.conf');
  await fs.writeFile(candidate, content, { mode: 0o600 });
  const sudo = (...args) => run('sudo', ['-n', ...args], { timeout: 60000 });
  let changed = false;
  try {
    if (hash((await run('systemctl', ['cat', name])).stdout) !== unitHash)
      throw new Error('Relay unit changed during cutover');
    await sudo('install', '-d', '-m', '755', dir);
    await sudo('install', '-m', '644', candidate, target + '.tmp');
    await sudo('mv', target + '.tmp', target);
    changed = true;
    await sudo('systemctl', 'daemon-reload');
    await sudo('systemctl', 'restart', name);
    await run('systemctl', ['is-active', '--quiet', name]);
  } catch (error) {
    if (!changed) throw error;
    try {
      if (prior === undefined) await sudo('rm', '-f', target);
      else {
        const rollback = path.join(backupDir, 'rollback.conf');
        await fs.writeFile(rollback, prior, { mode: 0o600 });
        await sudo('install', '-m', '644', rollback, target);
      }
      await sudo('systemctl', 'daemon-reload');
      await sudo('systemctl', 'restart', name);
      const restored = (await run('systemctl', ['cat', name])).stdout;
      if (hash(restored) !== unitHash)
        throw new Error('Restored relay unit differs from the saved unit', { cause: error });
      await run('systemctl', ['is-active', '--quiet', name]);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Relay cutover failed and rollback could not be verified; inspect the saved backup before retrying',
        { cause: rollbackError }
      );
    }
    throw error;
  }
  return { ...report, applied: true, backupDir };
}
