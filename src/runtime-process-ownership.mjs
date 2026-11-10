import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const hash = (value) => createHash('sha256').update(value).digest('hex');
function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], options).trim();
    const started = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], options).trim();
    if (!command || !started) return null;
    return { commandDigest: hash(command), started };
  } catch {
    return null;
  }
}
function receiptPath(config, runtimeId) {
  return config.sourcePath ? path.join(`${config.sourcePath}.runtime-processes`, hash(runtimeId) + '.json') : null;
}
export function recordRuntimeProcess(config, runtimeId, pid) {
  const file = receiptPath(config, runtimeId);
  if (!file) return;
  const processIdentity = identity(pid);
  if (!processIdentity) throw new Error('Cannot record runtime process ownership');
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error('Runtime ownership directory is not private');
  const temporary = `${file}.${randomUUID()}`;
  try {
    fs.writeFileSync(
      temporary,
      JSON.stringify({ schema: 1, configPath: path.resolve(config.sourcePath), runtimeId, pid, ...processIdentity }),
      { mode: 0o600, flag: 'wx' }
    );
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function recoverRuntimeProcess(config, runtimeId) {
  const file = receiptPath(config, runtimeId);
  if (!file) return null;
  try {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      return null;
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      receipt.schema !== 1 ||
      receipt.runtimeId !== runtimeId ||
      receipt.configPath !== path.resolve(config.sourcePath)
    )
      return null;
    const current = identity(receipt.pid);
    return current && current.started === receipt.started && current.commandDigest === receipt.commandDigest
      ? { pid: receipt.pid }
      : null;
  } catch {
    return null;
  }
}
export function forgetRuntimeProcess(config, runtimeId) {
  const file = receiptPath(config, runtimeId);
  if (file) fs.rmSync(file, { force: true });
}
