import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const gatewayReceiptDirectory = () =>
  path.join(os.tmpdir(), `lloom-gateway-receipts-${process.getuid?.() ?? 'user'}`);
function command(program, args) {
  try {
    return execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}
function startIdentity(pid) {
  return command('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
}
export function recordGatewayProcess({ pid, executable, cliPath, configPath, port }) {
  const directory = gatewayReceiptDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Gateway receipt directory is not private');
  const receipt = {
    schema: 1,
    pid,
    executable,
    cliPath: path.resolve(cliPath),
    configPath: path.resolve(configPath),
    port,
    startIdentity: startIdentity(pid)
  };
  const receiptPath = path.join(directory, `${pid}-${randomUUID()}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...receipt, receiptPath };
}

export function inspectGatewayProcesses({ configPath } = {}) {
  const directory = gatewayReceiptDirectory();
  let files;
  try {
    files = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return files
    .filter((name) => /^\d+-[a-f0-9-]+\.json$/.test(name))
    .flatMap((name) => {
      const receiptPath = path.join(directory, name);
      const stat = fs.lstatSync(receiptPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        return [];
      let receipt;
      try {
        receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      } catch {
        return [];
      }
      if (configPath && receipt.configPath !== path.resolve(configPath)) return [];
      if (receipt.schema !== 1 || !Number.isInteger(receipt.pid) || receipt.pid <= 1) return [];
      const actual = command('/bin/ps', ['-p', String(receipt.pid), '-o', 'command=']);
      const expected = `${receipt.executable} ${receipt.cliPath} serve --config ${receipt.configPath}`;
      const listeners = command(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', [
        '-nP',
        `-tiTCP:${receipt.port}`,
        '-sTCP:LISTEN'
      ])
        .split(/\s+/)
        .map(Number);
      const owned = Boolean(
        receipt.startIdentity &&
        startIdentity(receipt.pid) === receipt.startIdentity &&
        actual === expected &&
        listeners.includes(receipt.pid)
      );
      return [
        { ...receipt, receiptPath, alive: Boolean(actual), owned, configMissing: !fs.existsSync(receipt.configPath) }
      ];
    });
}

export function cleanupGatewayProcesses({ configPath, apply = false, yes = false } = {}) {
  const receipts = inspectGatewayProcesses({ configPath });
  if (apply && !yes) throw new Error('Gateway cleanup requires --apply --yes');
  return receipts.map((receipt) => {
    if (!apply || !receipt.owned || !receipt.configMissing) return { ...receipt, signalled: false };
    // Reinspect immediately before the signal; a stale PID/port receipt alone
    // never grants ownership of its current occupant.
    const current = inspectGatewayProcesses({ configPath: receipt.configPath }).find(
      (item) => item.pid === receipt.pid
    );
    if (!current?.owned || !current.configMissing) return { ...receipt, signalled: false };
    try {
      process.kill(receipt.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    return { ...receipt, signalled: true };
  });
}
