import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDeploymentPlanReport,
  deploymentFailureReport,
  formatDeploymentReport,
  runDeploymentCli
} from '../src/cluster-deployment-cli.mjs';

const digest = (letter) => letter.repeat(64);
const plan = {
  gatewayProtocol: 1,
  reviewedArtifact: {
    id: 'release-next',
    path: '/srv/lloom/incoming/release-next.tar',
    manifestPath: '/srv/lloom/incoming/release-next.tar.manifest.json',
    sha256: digest('a'),
    manifestSha256: digest('b'),
    reviewed: true
  },
  targetNodes: [
    { id: 'worker-1', role: 'worker' },
    { id: 'leader', role: 'leader' }
  ],
  expectedOldIdentity: { releaseId: 'release-old', artifactSha256: digest('c'), manifestSha256: digest('d') },
  canary: { gatewayModelId: 'atlas/local', runtimeId: 'atlas-runtime' }
};

test('plans from a reviewed JSON file without creating a journal', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const planPath = path.join(directory, 'plan.json');
  const journalPath = path.join(directory, 'deployment.json');
  await fs.writeFile(planPath, JSON.stringify(plan));
  const result = await runDeploymentCli('plan', { planPath, journalPath });
  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.planHash.length, 64);
  await assert.rejects(() => fs.stat(journalPath), { code: 'ENOENT' });
  assert.match(formatDeploymentReport(result), /review it/);
});

test('reports status read-only and refuses mutation without explicit confirmation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-cli-status-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const planPath = path.join(directory, 'plan.json');
  const journalPath = path.join(directory, 'deployment.json');
  await fs.writeFile(planPath, JSON.stringify(plan));
  await assert.rejects(
    () => runDeploymentCli('apply', { planPath, nodesPath: planPath, journalPath, apply: true, yes: false }),
    /requires --apply --yes/
  );
  const result = await runDeploymentCli('status', { operationId: 'missing', journalPath });
  assert.equal(result.ok, false);
  assert.equal(result.report, null);
  assert.match(formatDeploymentReport(result), /not-found/);
});

test('creates a plan report from the library API', async () => {
  const result = await createDeploymentPlanReport(plan);
  assert.equal(result.action, 'plan');
  assert.equal(result.plan.targetNodes[1].role, 'leader');
});

test('requires immutable absolute artifact paths and reports node progress on failure', async () => {
  await assert.rejects(
    () => createDeploymentPlanReport({ ...plan, reviewedArtifact: { ...plan.reviewedArtifact, path: 'release.tar' } }),
    /absolute normalized file path/
  );

  const report = {
    operationId: 'op-failed',
    generation: 2,
    operationState: 'rollback-failed',
    nodes: {
      leader: {
        nodeId: 'leader',
        state: 'rollback-failed',
        receipts: { preflight: {}, prepare: {} },
        lastError: { code: 'rollback_disconnect' }
      }
    },
    rollback: { attempted: true, manualIntervention: true }
  };
  const failure = deploymentFailureReport('apply', Object.assign(new Error('failed'), { report }));
  assert.equal(failure.ok, false);
  assert.match(
    formatDeploymentReport(failure),
    /leader: rollback-failed \[preflight, prepare\]; error=rollback_disconnect/
  );
  assert.match(formatDeploymentReport(failure), /manual intervention required/);
  assert.match(formatDeploymentReport(failure, { json: true }), /"operationState": "rollback-failed"/);
});

test('binds resume and rollback to the original endpoint map', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-cli-binding-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const planPath = path.join(directory, 'plan.json');
  const nodesPath = path.join(directory, 'nodes.json');
  const changedNodesPath = path.join(directory, 'nodes-changed.json');
  const journalPath = path.join(directory, 'deployment.json');
  await fs.writeFile(planPath, JSON.stringify(plan));
  await fs.writeFile(
    nodesPath,
    JSON.stringify({
      'worker-1': { host: 'worker-1.internal' },
      leader: { host: 'leader.internal' }
    })
  );
  await fs.writeFile(
    changedNodesPath,
    JSON.stringify({
      'worker-1': { host: 'worker-2.internal' },
      leader: { host: 'leader.internal' }
    })
  );
  const transport = {
    async preflight() {
      throw Object.assign(new Error('offline'), { code: 'disconnect' });
    },
    async stage() {},
    async prepare() {},
    async swap() {},
    async restart() {},
    async verify() {},
    async canary() {},
    async promote() {},
    async release() {},
    async reprepare() {},
    async rollback() {},
    async discardStage() {}
  };
  await assert.rejects(
    () =>
      runDeploymentCli('apply', {
        planPath,
        nodesPath,
        journalPath,
        operationId: 'op-binding',
        apply: true,
        yes: true,
        transport
      }),
    (error) => error?.report?.operationId === 'op-binding'
  );
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  assert.equal(journal.nodeEndpointBinding.schemaVersion, 1);
  assert.match(journal.nodeEndpointBinding.sha256, /^[0-9a-f]{64}$/);
  await assert.rejects(
    () =>
      runDeploymentCli('resume', {
        planPath,
        nodesPath: changedNodesPath,
        journalPath,
        operationId: 'op-binding',
        apply: true,
        yes: true,
        transport
      }),
    /endpoint map does not match/
  );
});
