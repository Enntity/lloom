// Explicit numeric memory-policy configuration for the CLI.
//
// This module owns the `runtime-policy` command surface: parsing numeric
// memory limits, building a read-only dry-run report, and applying a
// minimal, validated mutation to the resolved installed config file.
//
// Design boundaries (see AGENTS.md):
//   - runtime-plan stays read-only. Mutating anything requires
//     `--apply --yes` on `runtime-policy`.
//   - We never set memorySafety.mode: no hidden yolo, no implicit
//     enforcement disable.
//   - We never touch cluster.nodes.*.resources; per-node overrides stay
//     operator-owned. Recent stricter node overrides are surfaced in the
//     dry-run report with an explicit warning instead.
//   - Writes go through mutateConfigSource (atomic, validated), never a raw
//     fs write.
import { mutateConfigSource } from './config-mutation.mjs';

export const NUMERIC_MEMORY_FLAGS = Object.freeze(['--max-memory-utilization', '--reserve-memory-gb']);

class NumericMemoryFlagError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NumericMemoryFlagError';
    this.code = 'invalid_memory_policy_flag';
    this.statusCode = 2;
  }
}

function rawFlagValue(args, name) {
  const tokens = Array.isArray(args) ? args : [];
  if (tokens.filter((token) => token === name).length > 1) {
    throw new NumericMemoryFlagError(`${name} must be supplied only once`);
  }
  const index = tokens.indexOf(name);
  if (index === -1) return undefined;
  const next = tokens[index + 1];
  if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
    throw new NumericMemoryFlagError(`${name} requires a numeric value`);
  }
  return next;
}

function parseMaxMemoryUtilization(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new NumericMemoryFlagError('--max-memory-utilization requires a numeric value');
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new NumericMemoryFlagError(`--max-memory-utilization must be a finite number; received "${raw}"`);
  }
  if (!(value > 0 && value < 1)) {
    throw new NumericMemoryFlagError(
      `--max-memory-utilization must be greater than 0 and less than 1; received ${value}`
    );
  }
  return value;
}

function parseReserveMemoryGb(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new NumericMemoryFlagError('--reserve-memory-gb requires a numeric value');
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new NumericMemoryFlagError(`--reserve-memory-gb must be a finite number; received "${raw}"`);
  }
  if (!(value > 0)) {
    throw new NumericMemoryFlagError(`--reserve-memory-gb must be greater than 0; received ${value}`);
  }
  return value;
}

/**
 * Extract numeric memory-policy flags. Returns null when neither flag is
 * present so callers can preserve the existing read-only behavior.
 */
export function parseNumericMemoryFlags(args) {
  const tokens = Array.isArray(args) ? args : [];
  for (const name of NUMERIC_MEMORY_FLAGS) {
    if (tokens.some((token) => token.startsWith(`${name}=`))) {
      throw new NumericMemoryFlagError(`${name} requires a separate numeric argument`);
    }
  }
  const hasMax = tokens.includes('--max-memory-utilization');
  const hasReserve = tokens.includes('--reserve-memory-gb');
  if (!hasMax && !hasReserve) return null;
  const flags = {};
  if (hasMax) flags.maxMemoryUtilization = parseMaxMemoryUtilization(rawFlagValue(tokens, '--max-memory-utilization'));
  if (hasReserve) flags.reserveMemoryGb = parseReserveMemoryGb(rawFlagValue(tokens, '--reserve-memory-gb'));
  return Object.keys(flags).length ? flags : null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Per-node resource overrides that an operator may set to constrain a specific
// node. We surface conflicts but never write these.
function nodeOverrideRows(config, flags) {
  const nodes = config?.cluster?.nodes;
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) return [];
  const rows = [];
  for (const [nodeId, node] of Object.entries(nodes)) {
    const resources = node?.resources;
    if (!resources || typeof resources !== 'object' || Array.isArray(resources)) continue;
    const row = {
      nodeId,
      reserveMemoryGb: numberOrNull(resources.reserveMemoryGb),
      maxMemoryUtilization: numberOrNull(resources.maxMemoryUtilization),
      memoryBudgetGb: numberOrNull(resources.memoryBudgetGb)
    };
    rows.push(row);
  }
  return rows.filter((row) =>
    flags ? row.reserveMemoryGb != null || row.maxMemoryUtilization != null || row.memoryBudgetGb != null : true
  );
}

// Warn explicitly when a per-node override is stricter than the requested
// global value (so the global change will not take effect on that node).
function nodeOverrideWarnings(config, flags) {
  const warnings = [];
  const rows = nodeOverrideRows(config, flags);
  for (const row of rows) {
    if (
      flags.maxMemoryUtilization != null &&
      row.maxMemoryUtilization != null &&
      row.maxMemoryUtilization < flags.maxMemoryUtilization
    ) {
      warnings.push(
        `cluster.nodes.${row.nodeId}.resources.maxMemoryUtilization (${row.maxMemoryUtilization}) is stricter than the requested ${flags.maxMemoryUtilization}; the requested global value will not take effect on node ${row.nodeId}`
      );
    }
    if (flags.reserveMemoryGb != null && row.reserveMemoryGb != null && row.reserveMemoryGb > flags.reserveMemoryGb) {
      warnings.push(
        `cluster.nodes.${row.nodeId}.resources.reserveMemoryGb (${row.reserveMemoryGb}) is stricter than the requested ${flags.reserveMemoryGb}; the requested global reserve will not take effect on node ${row.nodeId}`
      );
    }
    if (row.memoryBudgetGb != null) {
      const requestedBudget =
        flags.maxMemoryUtilization != null ? `≈ totalMemoryGb * ${flags.maxMemoryUtilization}` : null;
      warnings.push(
        `cluster.nodes.${row.nodeId}.resources.memoryBudgetGb (${row.memoryBudgetGb}) is an absolute per-node budget${
          requestedBudget ? ` and overrides the requested percentage-based budget (${requestedBudget})` : ''
        }; per-node overrides are preserved and the requested global policy may not take effect on node ${row.nodeId}`
      );
    }
  }
  return warnings;
}

function selectedConfigFields(config) {
  const policy = config?.runtimePolicy ?? {};
  const safety = policy.memorySafety ?? {};
  return {
    runtimePolicy: {
      maxMemoryUtilization: numberOrNull(policy.maxMemoryUtilization),
      reserveMemoryGb: numberOrNull(policy.reserveMemoryGb),
      memoryBudgetGb: numberOrNull(policy.memoryBudgetGb)
    },
    memorySafety: {
      maxMemoryUtilization: numberOrNull(safety.maxMemoryUtilization),
      minAvailableMemoryGb: numberOrNull(safety.minAvailableMemoryGb),
      mode: safety.mode ?? null
    }
  };
}

function projectAfter(config, flags) {
  const policy = { ...(config?.runtimePolicy ?? {}) };
  const safety = { ...(policy.memorySafety ?? {}) };
  if (flags.maxMemoryUtilization != null) {
    policy.maxMemoryUtilization = flags.maxMemoryUtilization;
    safety.maxMemoryUtilization = flags.maxMemoryUtilization;
  }
  if (flags.reserveMemoryGb != null) {
    policy.reserveMemoryGb = flags.reserveMemoryGb;
    safety.minAvailableMemoryGb = flags.reserveMemoryGb;
  }
  policy.memorySafety = safety;
  return { ...config, runtimePolicy: policy };
}

/**
 * Build a read-only dry-run report for `lloom runtime-policy`. Returns only
 * the selected memory-policy fields before/after plus per-node overrides and
 * warnings. It deliberately omits secrets and the entire config body.
 */
export function createRuntimePolicyConfigReport(config, flags) {
  if (!flags) {
    throw new NumericMemoryFlagError('runtime-policy requires --max-memory-utilization and/or --reserve-memory-gb');
  }
  const absolute = numberOrNull(config?.runtimePolicy?.memoryBudgetGb);
  if (absolute != null) {
    throw new NumericMemoryFlagError(
      `runtimePolicy.memoryBudgetGb (${absolute}) is set as an absolute budget and would keep taking precedence over a percentage; remove it explicitly or edit the config before changing utilization/reserve`
    );
  }
  const after = projectAfter(config, flags);
  return {
    ok: true,
    mode: 'dry-run',
    changed: Object.keys(flags),
    before: selectedConfigFields(config),
    after: selectedConfigFields(after),
    nodeOverrides: nodeOverrideRows(config, flags),
    warnings: nodeOverrideWarnings(config, flags)
  };
}

function applyFlagsToConfig(parsed, flags) {
  const policy = { ...(parsed.runtimePolicy ?? {}) };
  const safety = { ...(policy.memorySafety ?? {}) };
  if (flags.maxMemoryUtilization != null) {
    policy.maxMemoryUtilization = flags.maxMemoryUtilization;
    safety.maxMemoryUtilization = flags.maxMemoryUtilization;
  }
  if (flags.reserveMemoryGb != null) {
    policy.reserveMemoryGb = flags.reserveMemoryGb;
    safety.minAvailableMemoryGb = flags.reserveMemoryGb;
  }
  policy.memorySafety = safety;
  parsed.runtimePolicy = policy;
}

/**
 * Apply numeric memory-policy flags to the resolved installed config file.
 *
 * Requires both --apply and --yes (enforced by the CLI handler). The actual
 * write goes through mutateConfigSource, which re-reads the file, rejects
 * symlinks, writes an atomic temp file, and validates before rename. This
 * preserves every unrelated field, per-node overrides, and the existing
 * memorySafety.mode.
 */
export async function applyRuntimePolicyConfig(config, flags, { apply = false, yes = false } = {}) {
  if (!flags) {
    throw new NumericMemoryFlagError('runtime-policy requires --max-memory-utilization and/or --reserve-memory-gb');
  }
  if (!apply || !yes) {
    return { skipped: true, reason: 'requires --apply --yes', mode: 'dry-run' };
  }
  if (!config?.sourcePath) {
    throw new NumericMemoryFlagError('resolved config path is required to apply a memory-policy change');
  }
  let report;
  const result = await mutateConfigSource(config, (parsed) => {
    report = createRuntimePolicyConfigReport(parsed, flags);
    applyFlagsToConfig(parsed, flags);
  });
  return { ...report, mode: 'applied', applied: true, mutated: result?.changed === true };
}
