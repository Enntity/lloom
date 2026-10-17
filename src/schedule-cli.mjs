// Agent-facing schedule commands: `lloom reserve | renew | release | schedule | job`.
// They talk to the gateway that owns the schedule — the local one by default,
// or the cluster head given by --head / LLOOM_HEAD_URL.
import { setTimeout as delay } from 'node:timers/promises';
import { gatewayRequest, LLooMGatewayError } from './gateway-client.mjs';

const VALUE_FLAGS = new Set([
  '--owner',
  '--purpose',
  '--ttl',
  '--session',
  '--head',
  '--admin-api-key-env',
  '--on',
  '--reservation',
  '--note',
  '--stale',
  '--receipt',
  '--unit',
  '--poll',
  '--config',
  '--home'
]);
const RESERVATION_ID = /^r-[0-9a-f]{8}$/;
const ACTION_TIMEOUT_MS = 5 * 60 * 60 * 1000;

export const SCHEDULE_COMMANDS = ['reserve', 'renew', 'release', 'schedule', 'job'];

export function scheduleUsage() {
  return `Reservations and jobs (on the schedule-owning gateway; --head URL or LLOOM_HEAD_URL selects a remote head):
  lloom schedule [--all] [--json]                Resources, holders, queues, and recent jobs
  lloom reserve <resource> --owner NAME [--purpose TEXT] [--ttl 30m|none] [--wait] [--apply --yes]
  lloom renew <reservation|resource> [--ttl 30m]  Extend your lease (job reports also extend it)
  lloom release <reservation|resource> [--force] [--apply --yes]  Restore and free the resource
  lloom job start <title> [--on resource] [--note TEXT] [--stale 15m]   Prints the job id
  lloom job note|progress|metric|beat|done|fail|cancel|show <job> ...
  lloom job list [--all]
  Owner and session default to LLOOM_OWNER and LLOOM_SESSION.`;
}

/** Parse 90s / 30m / 2h / 1d (or "none" → null) to milliseconds. */
export function parseDuration(value, flag) {
  if (value === 'none') return null;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(String(value ?? '').trim());
  if (!match) throw new Error(`${flag} needs a duration such as 90s, 30m, 2h or none`);
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return Math.round(Number(match[1]) * scale);
}

function parseArgs(args) {
  const words = [];
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) words.push(arg);
    else if (VALUE_FLAGS.has(arg)) flags.set(arg, args[++index]);
    else flags.set(arg, true);
  }
  return { words, flag: (name) => flags.get(name), has: (name) => flags.get(name) === true };
}

export function ago(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 360) / 10}h`;
  return `${Math.round(seconds / 8640) / 10}d`;
}

function progressText(progress) {
  if (!progress) return '';
  const unit = progress.unit ? ` ${progress.unit}` : '';
  return progress.total == null ? `[${progress.done}${unit}]` : `[${progress.done}/${progress.total}${unit}]`;
}

function metricsText(metrics) {
  return Object.entries(metrics ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

export function formatReservation(entry, now) {
  const left =
    entry.state === 'active' ? (entry.expiresAt == null ? 'no expiry' : `${ago(entry.expiresAt - now)} left`) : null;
  const where = entry.state === 'queued' ? `queued #${entry.position}` : entry.state;
  const detail = [where, left].filter(Boolean).join(', ');
  const why = entry.purpose ? ` — ${entry.purpose}` : '';
  const error = entry.error ? `\n    ${entry.error}` : '';
  return `${entry.id}  ${entry.resource}  ${entry.owner} (${detail})${why}${error}`;
}

export function formatJob(job) {
  const when = job.state === 'running' ? `${ago(job.heartbeatAgeMs)} ago` : job.state;
  const parts = [
    job.id,
    job.health.padEnd(9),
    when.padEnd(8),
    job.owner,
    `${job.title}${job.note ? ` — ${job.note}` : ''}`,
    progressText(job.progress),
    metricsText(job.metrics)
  ];
  return parts.filter(Boolean).join('  ');
}

export function formatBoard(board, { all = false } = {}) {
  const byId = new Map(board.reservations.map((entry) => [entry.id, entry]));
  const lines = ['Resources'];
  for (const resource of board.resources) {
    const hosts = resource.hosts?.length ? ` (${resource.hosts.join(', ')})` : '';
    const label = `${resource.id}${resource.description ? ` — ${resource.description}` : ''}${hosts}`;
    if (resource.error) {
      lines.push(`  ${label}: config error: ${resource.error}`);
      continue;
    }
    const holders = resource.holders.map((id) => byId.get(id)).filter(Boolean);
    const status = holders.length
      ? holders.map((entry) => formatReservation(entry, board.now)).join('\n    ')
      : `free${resource.capacity > 1 ? ` (0/${resource.capacity})` : ''}`;
    lines.push(`  ${label}\n    ${status}`);
    for (const id of resource.queue) lines.push(`    next: ${formatReservation(byId.get(id), board.now)}`);
  }
  const recent = board.jobs.filter((job) => all || job.state === 'running' || board.now - job.endedAt < 86_400_000);
  lines.push(recent.length ? 'Jobs' : 'Jobs: none');
  for (const job of recent) lines.push(`  ${formatJob(job)}`);
  return lines.join('\n');
}

/** Run one schedule command. Returns a process exit code. */
export async function runScheduleCli(
  command,
  args,
  { config, env = process.env, out = console.log, err = console.error, sleep = delay }
) {
  const { words, flag, has } = parseArgs(args);
  const json = has('--json');
  const head = flag('--head') ?? env.LLOOM_HEAD_URL;
  const keyEnv = flag('--admin-api-key-env') ?? (head ? 'LLOOM_HEAD_API_KEY' : undefined);
  // Never send the local gateway's admin key to a different host.
  if (head && !env[keyEnv])
    throw new Error(`a remote head needs its admin key in ${keyEnv} (or --admin-api-key-env NAME)`);
  const request = (pathname, { method = 'GET', body, timeoutMs = 30_000 } = {}) =>
    gatewayRequest(config, pathname, {
      method,
      body,
      timeoutMs,
      throwOnError: true,
      env,
      ...(keyEnv ? { explicitEnvName: keyEnv } : {}),
      ...(head ? { urlFor: () => String(head).replace(/\/+$/, '') } : {})
    });
  const owner = () => {
    const value = flag('--owner') ?? env.LLOOM_OWNER;
    if (!value) throw new Error('--owner NAME (or LLOOM_OWNER) is required');
    return value;
  };
  const session = flag('--session') ?? env.LLOOM_SESSION;
  const print = (value, text) => out(json ? JSON.stringify(value, null, 2) : text);
  const confirmed = has('--apply') && has('--yes');
  if (has('--apply') && !has('--yes')) throw new Error(`${command} requires --apply --yes`);

  async function resolveReservation(ref) {
    if (!ref) throw new Error(`${command} needs a reservation id or resource name`);
    if (RESERVATION_ID.test(ref)) return ref;
    const board = await request('/gateway/schedule');
    const mine = board.reservations.find(
      (entry) => entry.resource === ref && entry.owner === owner() && !['released', 'failed'].includes(entry.state)
    );
    if (!mine) throw new Error(`${owner()} holds no reservation on ${ref}`);
    return mine.id;
  }

  if (command === 'schedule' || (command === 'reserve' && words.length < 2)) {
    const board = await request('/gateway/schedule');
    print(board, formatBoard(board, { all: has('--all') }));
    return 0;
  }

  if (command === 'reserve') {
    const body = {
      resource: words[1],
      owner: owner(),
      purpose: flag('--purpose') ?? (words.slice(2).join(' ') || undefined),
      session,
      wait: has('--wait'),
      apply: confirmed,
      yes: confirmed
    };
    if (flag('--ttl') !== undefined) body.ttlMs = parseDuration(flag('--ttl'), '--ttl');
    let entry = await request('/gateway/schedule/reservations', { method: 'POST', body, timeoutMs: ACTION_TIMEOUT_MS });
    if (entry.applied === false) {
      const steps = entry.actions.map((action) =>
        action.kind === 'route'
          ? `route ${action.alias}${action.node ? `@${action.node}` : ''} -> ${action.profile}`
          : `suspend ${action.model}${action.node ? `@${action.node}` : ''}`
      );
      const holders = entry.holders.map((holder) => formatReservation(holder, Date.now()));
      print(
        entry,
        [
          `Would take ${entry.resource}${entry.description ? ` (${entry.description})` : ''} for ${entry.ttlMs == null ? 'no fixed time' : ago(entry.ttlMs)}`,
          `  on take: ${steps.join('; ') || 'nothing'} (release undoes these in reverse)`,
          holders.length ? `  held: ${holders.join('; ')}` : '  free now',
          entry.queue.length ? `  queue: ${entry.queue.length}` : null,
          '  re-run with --apply --yes'
        ]
          .filter(Boolean)
          .join('\n')
      );
      return 0;
    }
    if (body.wait && entry.state === 'queued') entry = await waitForTurn(entry, body.owner);
    print(entry, formatReservation(entry, Date.now()));
    return entry.state === 'active' ? 0 : entry.state === 'released' && entry.endReason === 'interrupted' ? 130 : 1;
  }

  // Polls until the queued lease starts (or fails), keeping the queue slot
  // renewed and riding out a head that is briefly unreachable. Interrupted, it
  // gives the slot back so a later promotion never acts for nobody.
  async function waitForTurn(start, holder) {
    const poll = Math.max(1000, flag('--poll') === undefined ? 10_000 : parseDuration(flag('--poll'), '--poll'));
    let entry = start;
    let interrupted = false;
    const interrupt = () => {
      interrupted = true;
    };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    try {
      let renewedAt = Date.now();
      let position = null;
      while (['queued', 'acquiring'].includes(entry.state) && !interrupted) {
        if (entry.state === 'queued' && entry.position !== position) {
          position = entry.position;
          err(`queued for ${entry.resource} (#${position})`);
        }
        await sleep(poll);
        if (interrupted) break;
        const slot = entry.queuedUntil != null && entry.updatedAt != null ? entry.queuedUntil - entry.updatedAt : 0;
        const renewEvery = Math.max(poll, slot > 0 ? slot / 2 : 5 * 60_000);
        try {
          if (entry.state === 'queued' && Date.now() - renewedAt >= renewEvery) {
            entry = await request(`/gateway/schedule/reservations/${entry.id}/renew`, {
              method: 'POST',
              body: { owner: holder }
            });
            renewedAt = Date.now();
          } else entry = await request(`/gateway/schedule/reservations/${entry.id}`);
        } catch (error) {
          const transient =
            error instanceof LLooMGatewayError && !['auth', 'authorization', 'http'].includes(error.kind);
          if (!transient) throw error;
          err(`still waiting; the head did not answer (${error.message})`);
        }
      }
      if (interrupted) {
        const given = await request(`/gateway/schedule/reservations/${entry.id}/release`, {
          method: 'POST',
          body: { owner: holder, apply: true, yes: true },
          timeoutMs: ACTION_TIMEOUT_MS
        }).catch((error) => {
          err(`could not give back ${entry.id}: ${error.message}`);
          return entry;
        });
        return { ...given, endReason: given.state === 'released' ? 'interrupted' : given.endReason };
      }
      return entry;
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', interrupt);
    }
  }

  if (command === 'renew') {
    const id = await resolveReservation(words[1]);
    const body = { owner: owner() };
    if (flag('--ttl') !== undefined) body.ttlMs = parseDuration(flag('--ttl'), '--ttl');
    const entry = await request(`/gateway/schedule/reservations/${id}/renew`, { method: 'POST', body });
    print(entry, formatReservation(entry, Date.now()));
    return 0;
  }

  if (command === 'release') {
    const id = await resolveReservation(words[1]);
    const body = { owner: owner(), force: has('--force'), apply: confirmed, yes: confirmed };
    const entry = await request(`/gateway/schedule/reservations/${id}/release`, {
      method: 'POST',
      body,
      timeoutMs: ACTION_TIMEOUT_MS
    });
    if (entry.applied === false) {
      const undo = entry.undo.map((step) =>
        step.kind === 'route' ? `route ${step.alias} -> ${step.previous ?? '(unchanged)'}` : `resume ${step.model}`
      );
      print(
        entry,
        `Would release ${formatReservation(entry.reservation, Date.now())}\n  restore: ${undo.join('; ') || 'nothing'}\n  re-run with --apply --yes`
      );
      return 0;
    }
    print(entry, formatReservation(entry, Date.now()));
    return entry.state === 'released' ? 0 : 1;
  }

  // job
  const [, action, id, ...rest] = words;
  const restText = rest.join(' ') || undefined;
  // The owner, when known, lets the head refuse updates to someone else's job.
  const update = (body) =>
    request(`/gateway/schedule/jobs/${encodeURIComponent(id ?? '')}`, {
      method: 'POST',
      body: { owner: flag('--owner') ?? env.LLOOM_OWNER, ...body }
    });
  const requireId = () => {
    if (!id) throw new Error(`lloom job ${action} needs a job id`);
  };
  let job;
  switch (action) {
    case 'start': {
      const title = words.slice(2).join(' ');
      if (!title) throw new Error('lloom job start needs a title');
      const body = { title, owner: owner(), session, note: flag('--note') };
      const on = flag('--reservation') ?? flag('--on');
      if (on) body[RESERVATION_ID.test(on) ? 'reservationId' : 'resource'] = on;
      if (flag('--stale') !== undefined) body.staleAfterMs = parseDuration(flag('--stale'), '--stale');
      job = await request('/gateway/schedule/jobs', { method: 'POST', body });
      // Plain output is just the id so scripts can capture it.
      print(job, job.id);
      return 0;
    }
    case 'list': {
      const board = await request('/gateway/schedule');
      const jobs = board.jobs.filter((entry) => has('--all') || entry.state === 'running');
      print(jobs, jobs.length ? jobs.map(formatJob).join('\n') : 'no running jobs');
      return 0;
    }
    case 'show':
      requireId();
      job = await request(`/gateway/schedule/jobs/${encodeURIComponent(id)}`);
      print(
        job,
        [formatJob(job), ...job.notes.map((note) => `  ${new Date(note.at).toISOString()}  ${note.text}`)].join('\n')
      );
      return 0;
    case 'note':
    case 'beat':
      requireId();
      job = await update({ note: action === 'note' ? (restText ?? flag('--note')) : flag('--note') });
      break;
    case 'progress': {
      requireId();
      const match = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(rest[0] ?? '');
      if (!match) throw new Error('lloom job progress <job> DONE[/TOTAL] [--unit NAME]');
      job = await update({
        progress: { done: Number(match[1]), total: match[2] == null ? null : Number(match[2]), unit: flag('--unit') },
        note: rest.slice(1).join(' ') || flag('--note')
      });
      break;
    }
    case 'metric': {
      requireId();
      if (!rest.length) throw new Error('lloom job metric <job> NAME=VALUE ...');
      const metrics = {};
      for (const pair of rest) {
        const split = pair.indexOf('=');
        if (split < 1) throw new Error(`metric ${pair} must be NAME=VALUE`);
        const value = pair.slice(split + 1);
        metrics[pair.slice(0, split)] = value !== '' && Number.isFinite(Number(value)) ? Number(value) : value;
      }
      job = await update({ metrics });
      break;
    }
    case 'done':
    case 'fail':
    case 'cancel':
      requireId();
      job = await update({
        state: { done: 'done', fail: 'failed', cancel: 'cancelled' }[action],
        note: restText ?? flag('--note'),
        receipt: flag('--receipt')
      });
      break;
    default:
      throw new Error(`unknown job command ${action ?? ''}\n${scheduleUsage()}`);
  }
  print(job, formatJob(job));
  return 0;
}
