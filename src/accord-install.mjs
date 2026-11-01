import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { accordProfile, ensureAccord } from './accord-client.mjs';
export async function ensureLloomAccord({ home = os.homedir(), profilePath = accordProfile(), ...options } = {}) {
  const result = await ensureAccord({ home, profilePath, ...options });
  if (options.dryRun || path.resolve(profilePath) !== path.join(home, '.config/accord/connection.json')) return result;
  // Preserve local edits, but stop publishing a competing reservation contract.
  for (const root of ['.agents/skills', '.claude/skills', '.codex/skills']) {
    const source = path.join(home, root, 'lloom-schedule');
    if (!fs.existsSync(source)) continue;
    const archive = path.join(home, '.config/accord/retired-skills');
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    fs.renameSync(source, path.join(archive, 'lloom-schedule-' + randomUUID()));
  }
  return result;
}
