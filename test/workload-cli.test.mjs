import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('ordinary CLI dispatch previews workload without joining or installing', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'lloom-workload-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, 'plan.json');
  writeFileSync(
    file,
    JSON.stringify({
      schema: 1,
      resource: 'host/resource',
      containers: [{ name: 'job', host: 'worker', image: 'cached', command: ['/bin/true'] }]
    })
  );
  const output = execFileSync(process.execPath, ['bin/lloom.mjs', 'workload', 'run', '--file', file, '--json'], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8'
  });
  assert.equal(JSON.parse(output).dryRun, true);
  assert(!existsSync(join(home, '.config/accord/connection.json')));
  assert.throws(
    () =>
      execFileSync(process.execPath, ['bin/lloom.mjs', 'workload', 'run', '--file', file, '--apply'], {
        env: { ...process.env, HOME: home },
        stdio: 'pipe'
      }),
    /requires --apply --yes/
  );
});
