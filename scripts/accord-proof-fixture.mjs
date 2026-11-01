import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { initialize } from '../vendor/accord/src/config.mjs';
import { install } from '../vendor/accord/src/installer.mjs';
import { AccordClient } from '../vendor/accord/src/client.mjs';
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export async function eventually(fn, timeout = 12000) {
  let last;
  for (const end = Date.now() + timeout; Date.now() < end;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await delay(50);
  }
  throw Error('Timed out: ' + (last?.message ?? ''));
}
export async function stop(p, signal = 'SIGTERM') {
  if (!p || p.exitCode !== null || p.signalCode !== null) return;
  const exited = once(p, 'exit');
  p.kill(signal);
  await exited;
}
export async function accordFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lloom-accord-')),
    home = join(dir, 'home'),
    data = join(dir, 'data');
  mkdirSync(home);
  initialize(data, { fixtures: true });
  install({ home, data, clients: [] });
  const h = { dir, home, data, profile: join(home, '.config/accord/connection.json'), children: [] };
  const launch = async (command, args) => {
    const p = fork(
      fileURLToPath(new URL('../vendor/accord/src/cli.mjs', import.meta.url)),
      [command, '--data', data, ...args],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    );
    h.children.push(p);
    let ready,
      error = '';
    p.stderr.on('data', (b) => (error += b));
    p.on('message', (v) => {
      if (v.type === 'ready') ready = v;
    });
    await eventually(() => {
      if (p.exitCode !== null) throw Error(error);
      return ready;
    });
    return { p, ...ready };
  };
  const d = await launch('driver', ['--port', '0']);
  h.driver = d.p;
  h.driverUrl = d.url;
  h.start = async (port = 0) => {
    const s = await launch('serve', ['--port', String(port), '--driver-url', h.driverUrl, '--leader-ms', '500']);
    h.server = s.p;
    h.url = s.url;
  };
  await h.start();
  h.client = (name) => new AccordClient(h.url, readFileSync(join(data, name + '.token'), 'utf8').trim());
  h.close = async () => {
    await Promise.all(h.children.map((p) => stop(p)));
    rmSync(dir, { recursive: true, force: true });
  };
  return h;
}
