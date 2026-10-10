import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClusterDeploymentCoordinator,
  DeploymentJournal,
  DeploymentPlanError,
  deploymentPlanHash,
  normalizeDeploymentPlan
} from './cluster-deployment.mjs';
import { createSshDeploymentTransport } from './ssh-deployment-transport.mjs';

async function readJson(filePath, label) {
  if (!filePath) throw new DeploymentPlanError(`${label} is required`);
  try {
    return JSON.parse(await fs.readFile(path.resolve(filePath), 'utf8'));
  } catch {
    throw new DeploymentPlanError(`${label} could not be read`);
  }
}

function defaultJournalPath() {
  return path.join(process.env.LLOOM_STATE ?? path.join(os.homedir(), '.lloom'), 'deployment.json');
}

export async function readDeploymentPlan(planPath) {
  return readJson(planPath, '--plan');
}

export async function createDeploymentPlanReport(rawPlan) {
  const plan = normalizeDeploymentPlan(rawPlan);
  return { ok: true, action: 'plan', applied: false, planHash: deploymentPlanHash(plan), plan };
}

export async function runDeploymentCli(
  action,
  {
    planPath,
    nodesPath,
    journalPath = defaultJournalPath(),
    operationId = null,
    generation = null,
    apply = false,
    yes = false,
    transport = null
  } = {}
) {
  if (!['plan', 'apply', 'status', 'resume', 'rollback'].includes(action))
    throw new DeploymentPlanError(`unsupported deployment action ${action}`);
  if (action === 'plan') return createDeploymentPlanReport(await readDeploymentPlan(planPath));
  if (yes && !apply) throw new DeploymentPlanError('--yes requires --apply');
  if (action !== 'status' && (!apply || !yes))
    throw new DeploymentPlanError(`${action} requires --apply --yes after reviewing the plan`);
  const journal = new DeploymentJournal(journalPath);
  if (action === 'status') {
    if (!operationId) throw new DeploymentPlanError('--operation-id is required for status');
    const document = await journal.load();
    return {
      ok: Boolean(document?.operationId === operationId),
      action,
      applied: false,
      operationId,
      report: document?.operationId === operationId ? document : null
    };
  }
  const rawPlan = await readDeploymentPlan(planPath);
  const nodeDefinitions = await readJson(nodesPath, '--nodes');
  const effectiveTransport = transport ?? createSshDeploymentTransport({ nodes: nodeDefinitions });
  const coordinator = new ClusterDeploymentCoordinator({ journalPath, journal, transport: effectiveTransport });
  let report;
  if (action === 'apply') report = await coordinator.deploy(rawPlan, { operationId });
  else if (action === 'resume') {
    if (!operationId) throw new DeploymentPlanError('--operation-id is required for resume');
    report = await coordinator.resume(operationId, { generation, plan: rawPlan });
  } else {
    if (!operationId) throw new DeploymentPlanError('--operation-id is required for rollback');
    report = await coordinator.rollback(operationId, { generation });
  }
  return {
    ok: report.operationState === 'completed' || report.operationState === 'rolled-back',
    action,
    applied: true,
    operationId: report.operationId,
    generation: report.generation,
    operationState: report.operationState,
    report
  };
}

export function formatDeploymentReport(result, { json = false } = {}) {
  if (json) return JSON.stringify(result, null, 2);
  if (result.action === 'plan') return `Deployment plan ${result.planHash} is ready; review it before --apply --yes.`;
  if (result.action === 'status') {
    const state = result.report?.operationState ?? 'not-found';
    return `${result.operationId}: ${state}`;
  }
  return `${result.operationId}: ${result.operationState}`;
}
