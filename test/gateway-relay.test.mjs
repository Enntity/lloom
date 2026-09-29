import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retargetGatewayRelay } from '../src/gateway-relay.mjs';
const host = Object.values(os.networkInterfaces())
  .flat()
  .find((v) => !v.internal && v.family === 'IPv4')?.address;
for (const failRestart of [false, true])
  test(
    `relay verifies direct owner, previews and rolls back restart failure=${failRestart}`,
    { skip: !host },
    async (t) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-relay-test-'));
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const config = {
        sourcePath: path.join(dir, 'config.json'),
        server: { host, port: 8100 },
        cluster: { nodeId: 'media' },
        security: { apiKeys: ['fixture'] }
      };
      const calls = [];
      let restarts = 0;
      let override = null;
      const current = '[Service]\nExecStart=/usr/lib/systemd/systemd-socket-proxyd 192.0.2.1:8100\n';
      const run = async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args.includes('cat')) return { stdout: current + (override ?? '') };
        if (cmd === 'sudo' && args[1] === 'mv') {
          const backups = (await fs.readdir(dir)).filter((n) => n.startsWith('relay-backup-'));
          override = await fs.readFile(path.join(dir, backups.at(-1), 'candidate.conf'), 'utf8');
        }
        if (cmd === 'sudo' && args[1] === 'rm') override = null;
        if (args.includes('restart') && ++restarts === 1 && failRestart) throw new Error('restart failed');
        return { stdout: '' };
      };
      const fetchFn = async () => ({ ok: true, json: async () => ({ node: { id: 'media' } }) });
      const options = { unit: 'lloom-fixture-relay', platform: 'linux', run, fetchFn };
      const plan = await retargetGatewayRelay(config, options);
      assert.equal(
        calls.some((c) => c[0] === 'sudo'),
        false
      );
      await assert.rejects(
        retargetGatewayRelay(config, { ...options, apply: true, yes: true, expectedUnitHash: 'bad' }),
        /changed/
      );
      const apply = retargetGatewayRelay(config, {
        ...options,
        apply: true,
        yes: true,
        expectedUnitHash: plan.unitHash
      });
      if (failRestart) {
        await assert.rejects(apply, /restart failed/);
        assert.ok(calls.some((c) => c.includes('rm')));
        assert.equal(restarts, 2);
        assert.equal(override, null);
        assert.ok(calls.some((c) => c.includes('is-active')));
      } else {
        const report = await apply;
        assert.equal(report.applied, true);
        assert.equal(await fs.readFile(path.join(report.backupDir, 'unit.before.txt'), 'utf8'), current);
      }
    }
  );
