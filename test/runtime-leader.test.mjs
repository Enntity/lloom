import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { runtimeAuthority, runtimeControlAllowed } from '../src/cluster.mjs';
test('a distributed model retains its own leader when the gateway has a different fleet leader', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-model-leader-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const raw = {
    cluster: {
      nodeId: 'gateway',
      leaderNode: 'gateway',
      nodes: { gateway: {}, owner: { endpoint: 'http://127.0.0.1:1' } }
    },
    runtimes: {
      group: {
        enabled: true,
        authority: { owner: 'owner', scope: 'distributed-model', group: 'group' },
        placement: {
          mode: 'distributed',
          leaderNode: 'owner',
          members: [{ node: 'owner', runtime: 'member', role: 'head' }]
        }
      },
      member: {
        enabled: true,
        node: 'owner',
        authority: { owner: 'owner', scope: 'distributed-member', group: 'group' }
      }
    }
  };
  await fs.writeFile(file, JSON.stringify(raw));
  const config = await loadConfig(file);
  assert.equal(runtimeAuthority(config, 'group').owner, 'owner');
  assert.equal(runtimeAuthority(config, 'member').owner, 'owner');
  for (const id of ['group', 'member']) {
    assert.equal(runtimeControlAllowed(config, id, 'gateway'), false);
    assert.equal(runtimeControlAllowed(config, id, 'owner'), true);
  }
  raw.runtimes.group.placement.leaderNode = 'missing';
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(loadConfig(file), /placement.leaderNode must name a node/);
  raw.runtimes.group.placement.leaderNode = 'owner';
  raw.runtimes.member.authority.owner = 'gateway';
  await fs.writeFile(file, JSON.stringify(raw));
  await assert.rejects(loadConfig(file), /distributed member member authority owner must be owner/);
});
