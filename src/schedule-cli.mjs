// Read-only LLooM presentation of Accord ownership and shared jobs.
import { gatewayRequest } from './gateway-client.mjs';

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

export const SCHEDULE_COMMANDS = ['reserve', 'renew', 'release', 'schedule', 'job'];

export function scheduleUsage() {
  return `Shared coordination (Accord):
  lloom schedule [--all] [--json]  Read Accord resources and jobs
  accord reserve|extend|release  Reserve using your authenticated Accord session
  accord job|jobs                Publish and inspect shared progress
  accord find|send|inbox         Discover and message collaborators`;
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

/** Convenience aliases only. Agent identity and all durable writes belong to Accord. */
export async function runScheduleCli(command, args, { config, env = process.env, out = console.log }) {
  const { has } = parseArgs(args);
  if (command === 'schedule') {
    const board = await gatewayRequest(config, '/gateway/schedule', { throwOnError: true, env });
    out(has('--json') ? JSON.stringify(board, null, 2) : formatBoard(board, { all: has('--all') }));
    return 0;
  }
  throw new Error(
    `${command} moved to Accord. Use accord reserve, extend, release or job with your Accord session. No LLooM owner-name authority remains.`
  );
}
