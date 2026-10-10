import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClusterDeploymentCoordinator,
  DeploymentJournal,
  DeploymentPlanError,
  deploymentPlanHash,
  normalizeDeploymentPlan,
  sha256
} from './cluster-deployment.mjs';
import { createSshDeploymentTransport } from './ssh-deployment-transport.mjs';

const NODE_BINDING_SCHEMA_VERSION = 1;

function requiredRemotePath(value, label) {
  if (
    typeof value !== 'string' ||
    !value ||
    !value.startsWith('/') ||
    path.posix.normalize(value) !== value ||
    value.endsWith('/') ||
    /[\u0000-\u001f\u007f\r\n]/.test(value)
  ) {
    throw new DeploymentPlanError(`${label} must be an absolute normalized file path pre-staged on every target node`);
  }
  return value;
}

function normalizeCliDeploymentPlan(rawPlan) {
  const plan = normalizeDeploymentPlan(rawPlan);
  const artifactPath = requiredRemotePath(plan.reviewedArtifact.path, 'reviewedArtifact.path');
  const manifestPath = requiredRemotePath(plan.reviewedArtifact.manifestPath, 'reviewedArtifact.manifestPath');
  if (artifactPath === manifestPath)
    throw new DeploymentPlanError('reviewedArtifact.path and reviewedArtifact.manifestPath must differ');
  return plan;
}

function nodeEndpointBinding(nodeDefinitions) {
  if (!nodeDefinitions || typeof nodeDefinitions !== 'object' || Array.isArray(nodeDefinitions))
    throw new DeploymentPlanError('--nodes must contain an endpoint object');
  if (!Object.keys(nodeDefinitions).length) throw new DeploymentPlanError('--nodes must contain at least one node');
  return { schemaVersion: NODE_BINDING_SCHEMA_VERSION, sha256: sha256(nodeDefinitions) };
}

function assertNodeCoverage(plan, nodeDefinitions) {
  for (const node of plan.targetNodes) {
    if (!Object.prototype.hasOwnProperty.call(nodeDefinitions, node.id))
      throw new DeploymentPlanError(`--nodes is missing target node ${node.id}`);
  }
}

class EndpointBoundJournal {
  constructor(inner, binding, { expectedPlanHash = null } = {}) {
    this.inner = inner;
    this.binding = binding;
    this.expectedPlanHash = expectedPlanHash;
  }

  async load() {
    const document = await this.inner.load();
    if (!document) return null;
    if (
      document.nodeEndpointBinding?.schemaVersion !== this.binding.schemaVersion ||
      document.nodeEndpointBinding?.sha256 !== this.binding.sha256
    ) {
      throw new DeploymentPlanError(
        'the --nodes endpoint map does not match the operation journal; resume or rollback with the original map'
      );
    }
    if (this.expectedPlanHash && document.planHash !== this.expectedPlanHash)
      throw new DeploymentPlanError('the supplied deployment plan does not match the immutable operation journal');
    return document;
  }

  save(document) {
    return this.inner.save({
      ...document,
      nodeEndpointBinding: this.binding
    });
  }

  acquire(operationId) {
    return this.inner.acquire(operationId);
  }

  release() {
    return this.inner.release();
  }
}

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
  const plan = normalizeCliDeploymentPlan(rawPlan);
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
  const plan = normalizeCliDeploymentPlan(rawPlan);
  const nodeDefinitions = await readJson(nodesPath, '--nodes');
  assertNodeCoverage(plan, nodeDefinitions);
  const binding = nodeEndpointBinding(nodeDefinitions);
  const effectiveTransport = transport ?? createSshDeploymentTransport({ nodes: nodeDefinitions });
  const boundJournal = new EndpointBoundJournal(journal, binding, {
    expectedPlanHash: action === 'resume' || action === 'rollback' ? deploymentPlanHash(plan) : null
  });
  const coordinator = new ClusterDeploymentCoordinator({
    journalPath,
    journal: boundJournal,
    transport: effectiveTransport
  });
  let report;
  if (action === 'apply') report = await coordinator.deploy(plan, { operationId });
  else if (action === 'resume') {
    if (!operationId) throw new DeploymentPlanError('--operation-id is required for resume');
    report = await coordinator.resume(operationId, { generation, plan });
  } else {
    if (!operationId) throw new DeploymentPlanError('--operation-id is required for rollback');
    try {
      report = await coordinator.rollback(operationId, { generation });
    } catch (error) {
      // The coordinator uses DeploymentError as its durable rollback receipt,
      // including when an explicit rollback reaches the safe rolled-back state.
      if (error?.code !== 'DEPLOYMENT_FAILED' || error?.report?.operationState !== 'rolled-back') throw error;
      report = error.report;
    }
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

export function deploymentFailureReport(action, error) {
  const report = error?.report;
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;
  return {
    ok: false,
    action,
    applied: true,
    operationId: report.operationId ?? null,
    generation: report.generation ?? null,
    operationState: report.operationState ?? 'unknown',
    report
  };
}

function formatNodeProgress(node) {
  const phases = Object.keys(node?.receipts ?? {});
  const phaseText = phases.length ? ` [${phases.join(', ')}]` : '';
  const errorCode = typeof node?.lastError?.code === 'string' ? `; error=${node.lastError.code}` : '';
  return `  ${node.nodeId}: ${node.state}${phaseText}${errorCode}`;
}

function formatOperationReport(result) {
  const report = result.report;
  const lines = [`${result.operationId}: ${result.operationState}`];
  for (const node of Object.values(report?.nodes ?? {})) lines.push(formatNodeProgress(node));
  if (report?.rollback?.attempted) {
    lines.push(
      report.rollback.manualIntervention || report.operationState === 'rollback-failed'
        ? '  rollback: manual intervention required'
        : '  rollback: completed'
    );
  }
  return lines.join('\n');
}

export function formatDeploymentReport(result, { json = false } = {}) {
  if (json) return JSON.stringify(result, null, 2);
  if (result.action === 'plan') return `Deployment plan ${result.planHash} is ready; review it before --apply --yes.`;
  if (result.action === 'status') {
    const state = result.report?.operationState ?? 'not-found';
    if (!result.report) return `${result.operationId}: ${state}`;
    return formatOperationReport({ ...result, operationState: state });
  }
  return formatOperationReport(result);
}
