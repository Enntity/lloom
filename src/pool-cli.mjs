// `lloom pool plan`: a read-only pool placement plan for the installed config.
// Live node status, inventory and 7-day metrics come from the running gateway;
// without one, the plan uses the config plus this machine's own inventory.
import { loadBenchmarkEvidence } from './benchmarks.mjs';
import { currentNodeId } from './cluster.mjs';
import { readProfile } from './config-profiles.mjs';
import { profileMachine } from './machine-profile.mjs';
import { modelRootCandidates } from './model-files.mjs';
import { buildPoolPlanInputs } from './pool-catalog.mjs';
import { collectNodeInventory } from './pool-inventory.mjs';
import { planPool } from './pool-planner.mjs';
import { loadRecipes } from './recipes.mjs';

export const POOL_USAGE =
  'Usage: lloom pool plan [--cordon NODE[,NODE]] [--pin ALIAS=MODEL] [--profile NAME] [--consider-installs] ' +
  '[--headroom-gb N] [--churn-weight N] [--external fallback|allow|never] [--offline] [--json]';

const METRICS_PERIOD = '7d';

function parsePins(values = []) {
  const routes = {};
  for (const value of values) {
    const index = String(value).indexOf('=');
    if (index < 1 || index === value.length - 1) throw new Error(`--pin expects ALIAS=MODEL, got ${value}`);
    routes[value.slice(0, index)] = value.slice(index + 1);
  }
  return routes;
}

function numberOption(value, name) {
  if (value == null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative number`);
  return number;
}

export function poolPlanOptions({
  cordon = [],
  pins = [],
  profile,
  considerInstalls,
  offline,
  headroomGb,
  churnWeight,
  external
} = {}) {
  if (external != null && !['fallback', 'allow', 'never'].includes(external)) {
    throw new Error('--external must be fallback, allow, or never');
  }
  return {
    cordon: cordon
      .flatMap((value) => String(value).split(','))
      .map((value) => value.trim())
      .filter(Boolean),
    routes: parsePins(pins),
    profileName: profile ?? null,
    considerInstalls: considerInstalls === true,
    offline: offline === true,
    policy: Object.fromEntries(
      Object.entries({
        headroomGb: numberOption(headroomGb, '--headroom-gb'),
        churnWeight: numberOption(churnWeight, '--churn-weight'),
        external
      }).filter(([, value]) => value !== undefined)
    )
  };
}

async function liveState(config, gatewayRequest) {
  const cluster = await gatewayRequest(config, '/gateway/cluster?inventory=1');
  const metrics = await gatewayRequest(config, `/gateway/metrics?period=${METRICS_PERIOD}`).catch(() => null);
  return {
    nodeStatuses: cluster?.cluster?.nodes ?? {},
    metrics: metrics ? { ...metrics, period: METRICS_PERIOD } : null
  };
}

async function localState(config, deps) {
  const profile = await deps.profileMachine();
  const inventory = await deps.collectNodeInventory({
    nodeId: currentNodeId(config),
    profile,
    recipes: await deps.loadRecipes(),
    modelRoots: await deps.modelRootCandidates({ config })
  });
  return { nodeStatuses: { [currentNodeId(config)]: { reachable: true, profile, inventory } }, metrics: null };
}

export async function createPoolPlanReport(config, options = {}, overrides = {}) {
  const deps = {
    gatewayRequest: null,
    gatewayUrl: null,
    profileMachine,
    collectNodeInventory,
    loadRecipes,
    loadBenchmarkEvidence,
    modelRootCandidates,
    readProfile,
    ...overrides
  };
  let state = null;
  let source = { mode: 'config', gateway: deps.gatewayUrl, metricsPeriod: null, note: null };
  if (!options.offline && deps.gatewayRequest) {
    try {
      state = await liveState(config, deps.gatewayRequest);
      source = { ...source, mode: 'gateway', metricsPeriod: state.metrics ? METRICS_PERIOD : null };
    } catch (error) {
      source.note = `gateway unavailable (${error?.message ?? error}); planned from config and this machine only`;
    }
  }
  if (!state) {
    state = await localState(config, deps);
    source.note ??= 'offline: no running state is known, so every resident lane is listed as a start';
  }
  const profile = options.profileName ? await deps.readProfile(config, options.profileName) : null;
  const inputs = buildPoolPlanInputs({
    config,
    nodeStatuses: state.nodeStatuses,
    metrics: state.metrics,
    recipes: await deps.loadRecipes(),
    benchmarks: await deps.loadBenchmarkEvidence(),
    profile,
    cordon: options.cordon ?? [],
    routes: options.routes ?? {},
    considerInstalls: options.considerInstalls === true,
    policy: options.policy ?? {}
  });
  const plan = planPool(inputs);
  return {
    ok: plan.ok,
    dryRun: true,
    source,
    nodes: inputs.nodes.map((node) => ({
      id: node.id,
      available: node.available,
      cordoned: inputs.pins.cordon.includes(node.id),
      inventory: node.inventory,
      computeArchs: node.computeArchs
    })),
    counts: { workloads: inputs.workloads.length, variants: inputs.variants.length },
    pins: inputs.pins,
    ...(profile ? { profile: profile.name } : {}),
    plan
  };
}

function gb(value) {
  return `${Number(value ?? 0).toFixed(1)} GB`;
}

function workloadList(workloads) {
  if (!workloads.length) return 'pinned';
  const shown = workloads.slice(0, 4).join(', ');
  return workloads.length > 4 ? `${shown} (+${workloads.length - 4})` : shown;
}

export function formatPoolPlanReport(report) {
  const { plan } = report;
  const lines = ['LLooM pool plan (dry run; nothing was changed)'];
  lines.push(
    report.source.mode === 'gateway'
      ? `Source: gateway ${report.source.gateway ?? ''} live status${report.source.metricsPeriod ? `, ${report.source.metricsPeriod} demand` : ''}`.trim()
      : `Source: config only${report.source.note ? ` — ${report.source.note}` : ''}`
  );
  if (report.profile) lines.push(`Pinned routes from fleet profile ${report.profile}`);

  lines.push('', 'Nodes');
  for (const node of report.nodes) {
    const summary = plan.nodes[node.id];
    const memory = (summary?.domains ?? [])
      .map(
        (domain) =>
          `${domain.id} ${gb(domain.residentGb)} resident of ${gb(domain.budgetGb)} (${gb(domain.freeGb)} free)`
      )
      .join('; ');
    lines.push(
      `  ${node.id.padEnd(16)} ${summary?.status ?? 'unknown'}${memory ? `  ${memory}` : ''}  [inventory: ${node.inventory}]`
    );
  }

  lines.push('', 'Placements');
  const order = { always: 0, preferred: 1, auto: 2 };
  const placements = [...plan.placements].sort(
    (a, b) => Number(a.external) - Number(b.external) || order[a.residency] - order[b.residency]
  );
  for (const placement of placements) {
    const tier = placement.external ? 'external' : placement.residency === 'auto' ? 'on-demand' : placement.residency;
    const size = placement.external ? '' : ` ${gb(placement.memoryGbPerNode)}/node`;
    const manual = placement.managed || placement.external ? '' : ' (unmanaged)';
    const shared =
      placement.models.length > 1 ? ` [runtime ${placement.runtime} serves ${placement.models.length} models]` : '';
    lines.push(
      `  ${tier.padEnd(10)} ${placement.placement}${size}${manual}${shared} <- ${workloadList(placement.workloads)}`
    );
  }
  if (!placements.length) lines.push('  (none)');

  const { diff } = plan;
  const changes = [
    ...diff.routeChanges.map((change) => `route      ${change.alias}: ${change.from ?? '(none)'} -> ${change.to}`),
    ...diff.start.map((entry) => `start      ${entry.placement} as ${entry.residency}`),
    ...diff.manual.map((entry) => `${entry.action.padEnd(10)} ${entry.placement} (not managed by LLooM)`),
    ...diff.release.map((entry) => `release    ${entry.placement} (no planned workload)`),
    ...diff.residencyChanges.map((change) => `residency  ${change.runtime}: ${change.from} -> ${change.to}`)
  ];
  lines.push('', 'Changes from current');
  lines.push(...(changes.length ? changes.map((line) => `  ${line}`) : ['  (none)']));

  if (plan.uncovered.length || plan.pinViolations.length) {
    lines.push('', 'Not covered');
    for (const entry of plan.uncovered) {
      lines.push(`  ${entry.workload}${entry.required ? '' : ' (optional)'}: ${entry.reasons[0] ?? 'no candidate'}`);
    }
    for (const entry of plan.pinViolations) lines.push(`  pinned runtime ${entry.runtime}: ${entry.reasons[0]}`);
  }
  if (plan.warnings.length) lines.push('', 'Warnings', ...plan.warnings.map((warning) => `  ${warning}`));
  const score = plan.score;
  lines.push(
    '',
    `Score: ${score.uncovered} uncovered, ${score.external} external fallback, ${score.sloMisses} SLO misses, cost ${score.cost.toExponential(2)}`,
    'Applying plans is not available yet; act on this one with `lloom fleet`, `lloom route` and `lloom keep-warm`.'
  );
  return lines.join('\n');
}
