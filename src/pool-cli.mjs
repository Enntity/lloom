// `lloom pool plan`: a read-only pool placement plan for the installed config.
// Live node status, inventory, membership and 7-day metrics come from the
// running gateway; without one, the plan uses the config, the saved pool
// membership and this machine's own inventory. Also the report helpers for
// `lloom pool token|members|cordon|uncordon|drain|join`.
import { loadBenchmarkEvidence } from './benchmarks.mjs';
import { currentNodeId } from './cluster.mjs';
import { readProfile } from './config-profiles.mjs';
import { profileMachine } from './machine-profile.mjs';
import { modelRootCandidates } from './model-files.mjs';
import { buildPoolPlanInputs } from './pool-catalog.mjs';
import { collectNodeInventory } from './pool-inventory.mjs';
import { createPoolMembership } from './pool-membership.mjs';
import { poolMembershipOptions, poolMembershipPath, readPoolMembershipState } from './pool-membership-store.mjs';
import { planPool } from './pool-planner.mjs';
import { loadRecipes } from './recipes.mjs';

export const POOL_USAGE = [
  'Usage: lloom pool plan [--cordon NODE[,NODE]] [--pin ALIAS=MODEL] [--profile NAME] [--consider-installs] ' +
    '[--headroom-gb N] [--churn-weight N] [--external fallback|allow|never] [--offline] [--json]',
  '       lloom pool token create [--ttl DURATION] [--uses N] [--label KEY=VALUE] [--json]',
  '       lloom pool members [--json]',
  '       lloom pool cordon|uncordon|drain <node> [--reason TEXT]',
  '       lloom pool join <head-url> --token-stdin [--node-id ID] [--endpoint URL] [--apply --yes]',
  '       lloom pool simulate <scenario.json> [--mode off|advise|auto|compare] [--hours N] [--seed N] [--json]'
].join('\n');

const DURATION_UNITS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };

// `90` is seconds; `30m`, `2h` and `7d` carry a unit.
export function parseDurationMs(value) {
  const match = String(value ?? '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
  const ms = match ? Number(match[1]) * DURATION_UNITS[match[2] || 's'] : NaN;
  if (!Number.isSafeInteger(Math.round(ms)) || ms < 1000) {
    throw new Error(`Expected a duration such as 90, 30m, 2h or 7d; got ${value}`);
  }
  return Math.round(ms);
}

export function poolTokenOptions({ ttl, uses, labels = [] } = {}) {
  const options = {};
  if (ttl != null) options.ttlMs = parseDurationMs(ttl);
  if (uses != null) {
    if (!/^\d+$/.test(String(uses))) throw new Error('--uses must be a positive integer');
    options.uses = Number(uses);
  }
  if (labels.length) {
    options.labels = Object.fromEntries(
      labels.map((label) => {
        const index = String(label).indexOf('=');
        if (index < 1) throw new Error(`--label expects KEY=VALUE, got ${label}`);
        return [label.slice(0, index), label.slice(index + 1)];
      })
    );
  }
  return options;
}

function ago(iso, now) {
  const seconds = Math.max(0, Math.round((now() - Date.parse(iso)) / 1000));
  return seconds < 120
    ? `${seconds}s ago`
    : seconds < 7200
      ? `${Math.round(seconds / 60)}m ago`
      : `${Math.round(seconds / 3600)}h ago`;
}

export function formatPoolMembers(result, { now = Date.now } = {}) {
  const members = result?.members ?? [];
  if (!members.length) return 'No pool members. Issue a token with `lloom pool token create`.';
  const rows = members.map((member) => {
    const flags = [member.cordoned && 'cordoned', member.draining && 'draining'].filter(Boolean);
    const state = [member.state, ...flags].join(', ') + (flags.length && member.reason ? ` (${member.reason})` : '');
    const inventory = member.inventory;
    const memoryGb = (inventory?.memoryDomains ?? []).reduce((sum, domain) => sum + (domain.capacityGb ?? 0), 0);
    const facts = inventory
      ? [...(inventory.computeArchs ?? []), memoryGb ? `${Math.round(memoryGb)} GB` : null].filter(Boolean).join(', ')
      : 'no inventory yet';
    return [
      member.id,
      state,
      member.endpoint,
      ago(member.lastSeenAt, now),
      facts || '-',
      (member.running ?? []).join(', ') || '-'
    ];
  });
  const header = ['NODE', 'STATE', 'ENDPOINT', 'LAST SEEN', 'INVENTORY', 'RUNNING'];
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}

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
  // A gateway that predates pool membership has no members route.
  const membership = await gatewayRequest(config, '/gateway/pool/members').catch(() => null);
  return {
    nodeStatuses: cluster?.cluster?.nodes ?? {},
    metrics: metrics ? { ...metrics, period: METRICS_PERIOD } : null,
    members: membership?.members ?? [],
    membershipLiveness: true
  };
}

async function savedMembers(config, deps) {
  const state = await deps.readPoolMembership(config);
  return state ? createPoolMembership({ ...poolMembershipOptions(config), state }).members() : [];
}

async function localState(config, deps) {
  const profile = await deps.profileMachine();
  const inventory = await deps.collectNodeInventory({
    nodeId: currentNodeId(config),
    profile,
    recipes: await deps.loadRecipes(),
    modelRoots: await deps.modelRootCandidates({ config })
  });
  return {
    nodeStatuses: { [currentNodeId(config)]: { reachable: true, profile, inventory } },
    metrics: null,
    members: await savedMembers(config, deps),
    membershipLiveness: false
  };
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
    readPoolMembership: (target) => readPoolMembershipState(poolMembershipPath(target)),
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
    policy: options.policy ?? {},
    members: state.members,
    membershipLiveness: state.membershipLiveness
  });
  const planned = planPool(inputs);
  const plan = { ...planned, warnings: [...inputs.warnings, ...planned.warnings] };
  return {
    ok: plan.ok,
    dryRun: true,
    source,
    nodes: inputs.nodes.map((node) => ({
      id: node.id,
      available: node.available,
      cordoned: node.cordoned === true || inputs.pins.cordon.includes(node.id),
      inventory: node.inventory,
      computeArchs: node.computeArchs,
      membership: node.membership ?? null,
      routable: node.routable !== false
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
    const member = node.membership ? ` [member ${node.membership}${node.routable ? '' : ', enrolled only'}]` : '';
    lines.push(
      `  ${node.id.padEnd(16)} ${summary?.status ?? 'unknown'}${memory ? `  ${memory}` : ''}  [inventory: ${node.inventory}]${member}`
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
