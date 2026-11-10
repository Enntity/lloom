// `lloom pool simulate`: run a fleet scenario through the pool planner,
// reconciler and controller in a deterministic simulation. Nothing on the
// installed gateway or any node is read or changed.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { comparePoolSimulation } from './pool-sim.mjs';

export const POOL_SIMULATE_USAGE =
  'Usage: lloom pool simulate <scenario.json> [--mode off|advise|auto|compare] [--hours N] [--seed N] [--json]';

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function mergeValue(base, overlay) {
  if (Array.isArray(base) && Array.isArray(overlay) && overlay.every((item) => isObject(item) && item.id != null)) {
    const merged = base.map((item) => ({ ...item }));
    for (const item of overlay) {
      const index = merged.findIndex((existing) => existing.id === item.id);
      if (item.remove === true) {
        if (index >= 0) merged.splice(index, 1);
      } else if (index >= 0) merged[index] = mergeValue(merged[index], item);
      else merged.push(item);
    }
    return merged;
  }
  if (isObject(base) && isObject(overlay)) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(overlay))
      merged[key] = key in base ? mergeValue(base[key], value) : value;
    return merged;
  }
  return overlay;
}

// A scenario may name a `base` file (relative to itself). Objects merge; arrays
// of objects with ids merge by id (`"remove": true` drops one); anything else
// in the scenario replaces the base value.
export async function loadPoolScenario(path, seen = new Set()) {
  const file = resolve(path);
  if (seen.has(file)) throw new Error(`scenario base cycle at ${file}`);
  seen.add(file);
  const scenario = JSON.parse(await readFile(file, 'utf8'));
  if (!scenario.base) return scenario;
  const { base, ...overlay } = scenario;
  const parent = await loadPoolScenario(resolve(dirname(file), base), seen);
  const { description: _description, ...inherited } = parent;
  return mergeValue(inherited, overlay);
}

export function poolSimulateOptions({ mode = 'compare', hours, seed } = {}) {
  if (!['off', 'advise', 'auto', 'compare'].includes(mode))
    throw new Error('--mode must be off, advise, auto, or compare');
  const number = (value, name) => {
    if (value == null) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
    return parsed;
  };
  return {
    modes: mode === 'compare' ? ['off', 'auto'] : [mode],
    durationHours: number(hours, '--hours'),
    seed: number(seed, '--seed')
  };
}

export async function runPoolSimulateCommand(path, options = {}) {
  const scenario = await loadPoolScenario(path);
  const overrides = Object.fromEntries(
    Object.entries({ durationHours: options.durationHours, seed: options.seed }).filter(
      ([, value]) => value !== undefined
    )
  );
  return comparePoolSimulation({ ...scenario, ...overrides }, { modes: options.modes ?? ['off', 'auto'] });
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function seconds(ms) {
  return ms >= 10000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(2)}s`;
}

export function formatPoolSimulation(reports) {
  const modes = Object.keys(reports);
  const first = reports[modes[0]];
  const lines = [`Pool simulation: ${first.scenario} (${first.durationHours} h, simulated)`, ''];
  const rows = [
    ['requests', (r) => String(r.requests.total)],
    ['failed', (r) => String(r.requests.failed)],
    ['external', (r) => String(r.requests.external)],
    ['cold waits', (r) => String(r.requests.coldWaits)],
    ['SLO attainment', (r) => pct(r.requests.sloAttainment)],
    ['TTFT p50', (r) => seconds(r.requests.ttftP50Ms)],
    ['TTFT p95', (r) => seconds(r.requests.ttftP95Ms)],
    ['lane loads', (r) => `${r.lanes.loads} (${r.lanes.loadGb} GB)`],
    ['evictions', (r) => String(r.lanes.evictions)],
    ['admission refusals', (r) => String(r.lanes.admissionRefusals)],
    ['memory guard aborts', (r) => String(r.lanes.guardAborts)],
    ['memory violations', (r) => String(r.safety.memoryViolations.length)],
    [
      'controller applies',
      (r) => (r.mode === 'off' ? '-' : `${r.controller.applies} (${r.controller.urgentApplies} urgent)`)
    ],
    ['step failures', (r) => (r.mode === 'off' ? '-' : String(r.controller.stepFailures))]
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  lines.push(`${''.padEnd(width)}${modes.map((mode) => mode.padStart(16)).join('')}`);
  for (const [label, value] of rows) {
    lines.push(`${label.padEnd(width)}${modes.map((mode) => value(reports[mode]).padStart(16)).join('')}`);
  }
  for (const mode of modes) {
    const report = reports[mode];
    const worst = Object.entries(report.workloads)
      .filter(([, stats]) => stats.requests && stats.sloAttainment < 1)
      .sort(([, a], [, b]) => a.sloAttainment - b.sloAttainment)
      .slice(0, 5);
    if (worst.length) {
      lines.push('', `${mode}: lowest SLO attainment`);
      for (const [id, stats] of worst) {
        const reasons = Object.entries(stats.failReasons)
          .map(([reason, count]) => `${count} ${reason}`)
          .join(', ');
        lines.push(
          `  ${id}: ${pct(stats.sloAttainment)} of ${stats.requests}, p95 ${seconds(stats.ttftP95Ms)}${reasons ? `, failed: ${reasons}` : ''}`
        );
      }
    }
    const decisions = report.timeline.filter(
      (entry) => entry.kind === 'apply' || entry.kind === 'propose' || entry.kind.startsWith('event:')
    );
    if (decisions.length && mode !== 'off') {
      lines.push('', `${mode}: events and decisions`);
      for (const entry of decisions.slice(0, 20)) {
        const detail = entry.kind.startsWith('event:')
          ? (entry.nodes ?? []).join(', ')
          : `${entry.reason}; ${entry.steps.length} step${entry.steps.length === 1 ? '' : 's'}`;
        lines.push(`  ${String(entry.atMinutes).padStart(7)} min  ${entry.kind}  ${detail}`);
      }
    }
    const failedChecks = report.checks.filter((check) => !check.ok);
    if (report.checks.length) {
      lines.push('', `${mode}: ${report.checks.length - failedChecks.length}/${report.checks.length} expectations met`);
      for (const check of failedChecks)
        lines.push(`  FAIL ${check.path} = ${JSON.stringify(check.value)}, expected ${check.expected}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
