import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { accordFixture, delay } from './accord-fixture.mjs';
import { ensureLloomAccord } from '../src/accord-install.mjs';
test('LLooM reuses an installed authority and retires its duplicate skill without losing edits', async (t) => {
  const h = await accordFixture();
  t.after(() => h.close());
  const skill = path.join(h.home, '.agents/skills/lloom-schedule');
  await fs.mkdir(skill, { recursive: true });
  await fs.writeFile(path.join(skill, 'SKILL.md'), 'local customization');
  const before = await fs.readFile(h.profile, 'utf8');
  const result = await ensureLloomAccord({ home: h.home, profilePath: h.profile });
  assert(result.reused);
  assert.equal(await fs.readFile(h.profile, 'utf8'), before);
  assert.equal(
    await fs.stat(skill).then(
      () => true,
      () => false
    ),
    false
  );
  const archive = path.join(h.home, '.config/accord/retired-skills');
  const entries = await fs.readdir(archive);
  assert.equal(entries.length, 1);
  assert.equal(await fs.readFile(path.join(archive, entries[0], 'SKILL.md'), 'utf8'), 'local customization');
  await ensureLloomAccord({ home: h.home, profilePath: h.profile });
  assert.equal((await fs.readdir(archive)).length, 1);
});

test(
  'authority reuse tolerates a scheduling pause within the production leadership window',
  { skip: process.platform === 'win32' },
  async (t) => {
    const h = await accordFixture();
    t.after(() => h.close());
    h.server.kill('SIGSTOP');
    try {
      await delay(800);
    } finally {
      h.server.kill('SIGCONT');
    }
    await delay(200);
    const result = await ensureLloomAccord({ home: h.home, profilePath: h.profile });
    assert(result.reused);
    assert.equal(h.server.exitCode, null);
  }
);
