// Operator reconciliation of a historical production hold. This never executes
// the old undo journal and is not a receipt that an arbitrary workload stopped.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { writeAtomicJson } from './deployment-fence.mjs';
import { schedulePaths } from './resource-spec.mjs';
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const leaseDigest = (lease) => digest(JSON.stringify(lease));
export const migrationPath = (config) => `${schedulePaths(config).statePath}.accord-migrations.json`;
export function reconciledLease(config, lease) {
  const file = migrationPath(config);
  if (!fs.existsSync(file)) return false;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.schema !== 1) throw Error('Unknown legacy reconciliation schema; resources remain held');
  const entry = state.leases?.[lease.id];
  return entry?.disposition === 'production-baseline' && entry.leaseSHA256 === leaseDigest(lease);
}
export async function reconcileLegacyHold({ config, plan, fence, apply = false }) {
  const old = JSON.parse(fs.readFileSync(schedulePaths(config).statePath, 'utf8'));
  const lease = old.reservations?.[plan.leaseId];
  if (old.schemaVersion !== 1 || !lease || !['active', 'stuck'].includes(lease.state))
    throw Error('Expected an active historical hold');
  if (leaseDigest(lease) !== plan.leaseSHA256 || digest(fs.readFileSync(config.sourcePath)) !== plan.configSHA256)
    throw Error('Lease or configuration changed; inspect again');
  if (
    plan.owner !== lease.owner ||
    !plan.ownerConfirmation?.trim() ||
    !plan.baselineEvidence?.trim() ||
    plan.noBorrowedWorkload !== true
  )
    throw Error('Verified owner confirmation and current production baseline evidence are required');
  if (!config.reservations?.resources?.[lease.resource]) throw Error('Resource has no Accord effect definition');
  if (
    fence.state !== 'prepared' ||
    fence.activeHandlers !== 0 ||
    fence.operation?.opId !== plan.opId ||
    fence.generation !== plan.generation
  )
    throw Error('Matching prepared, drained deployment fence required');
  const effectsFile = schedulePaths(config).statePath.replace(/\.json$/, '') + '-accord-effects.json';
  if (fs.existsSync(effectsFile)) {
    const effects = JSON.parse(fs.readFileSync(effectsFile, 'utf8'));
    if (effects.schema !== 1 || Object.values(effects.resources ?? {}).some((r) => r.phase !== 'idle'))
      throw Error('Existing Accord effects remain held; reconciliation cannot replace them');
  }
  const file = migrationPath(config);
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schema: 1, leases: {} };
  if (state.schema !== 1) throw Error('Unknown reconciliation schema');
  const entry = { ...plan, disposition: 'production-baseline', resource: lease.resource };
  if (state.leases[lease.id] && JSON.stringify(state.leases[lease.id]) !== JSON.stringify(entry))
    throw Error('Different reconciliation already exists');
  if (apply) {
    state.leases[lease.id] = entry;
    await writeAtomicJson(file, state);
  }
  return {
    applied: apply,
    leaseId: lease.id,
    resource: lease.resource,
    oldJournalPreserved: true,
    disposition: entry.disposition
  };
}
