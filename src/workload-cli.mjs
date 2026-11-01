import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { enrollProfile, inheritedClient } from '../vendor/accord/src/bootstrap.mjs';
import { ensureAccord } from './accord-client.mjs';
import { runWorkload, validateWorkloadPlan } from './workload-runner.mjs';
export async function runWorkloadCli(args, { out = console.log } = {}) {
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  if (args.includes('--help') || !value('--file')) {
    out(
      'lloom workload run --file plan.json [--apply --yes] [--profile accord-profile.json]\nCreates, registers, launches, renews and releases the whole workload. Preview by default.'
    );
    return;
  }
  if (args[0] !== 'run') throw Error('Use lloom workload run --file plan.json');
  const plan = validateWorkloadPlan(JSON.parse(readFileSync(value('--file'), 'utf8')));
  if (!args.includes('--apply')) {
    out(
      JSON.stringify(
        {
          dryRun: true,
          plan,
          steps: [
            'reserve',
            'create stopped objects',
            'register all containers and supervisors',
            'launch through Accord',
            'wait and renew',
            'confirmed release',
            'remove stopped objects'
          ]
        },
        null,
        2
      )
    );
    return;
  }
  if (!args.includes('--yes')) throw Error('Launching requires --apply --yes');
  const profile = value('--profile') ?? process.env.ACCORD_PROFILE ?? join(homedir(), '.config/accord/connection.json');
  if (!value('--profile') && !process.env.ACCORD_PROFILE && !process.env.ACCORD_SESSION_FILE) await ensureAccord();
  const inherited = !!process.env.ACCORD_SESSION_FILE;
  const client = inherited
    ? inheritedClient()
    : await enrollProfile(profile, { label: plan.title ?? 'LLooM workload', harness: 'lloom' });
  const controller = new AbortController(),
    cancel = () => controller.abort(Error('Workload cancelled; waiting for Accord recovery'));
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  let job;
  try {
    if (!inherited)
      await client.announce({
        label: plan.title ?? 'LLooM workload',
        activity: 'Launching registered workload',
        location: process.cwd()
      });
    job = await client.collaborate('job', {
      key: randomUUID(),
      title: plan.title ?? 'LLooM workload',
      state: 'working',
      note: 'Waiting for ownership, then automatic launch and recovery'
    });
    const result = await runWorkload(plan, {
      client,
      signal: controller.signal,
      onEvent: (event) => out(JSON.stringify(event))
    });
    await client.collaborate('job', {
      key: randomUUID(),
      id: job.id,
      state: 'done',
      note: 'Workload finished; release confirmed'
    });
    if (!inherited)
      await client.collaborate('session-report', {
        key: 'workload-finished-' + result.reservationId,
        title: plan.title ?? 'LLooM workload',
        state: 'done',
        detail: 'Workload finished; release confirmed'
      });
  } catch (error) {
    if (job)
      await client
        .collaborate('job', { key: randomUUID(), id: job.id, state: 'failed', note: error.message })
        .catch(() => {});
    throw error;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    if (!inherited) await client.closeSession();
  }
}
