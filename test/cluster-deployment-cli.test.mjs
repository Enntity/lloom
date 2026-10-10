import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDeploymentPlanReport,
  formatDeploymentReport,
  runDeploymentCli
} from '../src/cluster-deployment-cli.mjs';

const digest = (letter) => letter.repeat(64);
const plan = {
  gatewayProtocol: 1,
  reviewedArtifact: { id: 'release-next', sha256: digest('a'), manifestSha256: digest('b'), reviewed: true },
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
