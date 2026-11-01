// Run validation against a disposable standalone host, never the user's authority.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { accordFixture } from '../test/accord-fixture.mjs';
const h = await accordFixture();
try {
  const argv = process.argv.slice(2);
  const child = spawn(argv.shift() || 'npm', argv.length ? argv : ['run', 'test:suite'], {
    stdio: 'inherit',
    env: { ...process.env, HOME: h.home, ACCORD_PROFILE: h.profile }
  });
  const [code] = await once(child, 'exit');
  process.exitCode = code ?? 1;
} finally {
  await h.close();
}
