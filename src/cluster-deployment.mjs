import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Durable, gateway-only coordinator for a reviewed multi-node deployment.
 *
 * This module deliberately does not know how to reach a node.  The transport
 * adapter is the only place that may eventually use an agent or SSH.  Every
 * adapter call receives a public-safe context and must return a strict public
 * operation receipt (see docs/cluster-deployment-protocol.md).
 */

export const NODE_STATES = Object.freeze([
  'preflight',
  'staged',
  'prepared',
  'mutating',
  'active',
  'verified',
  'promoted',
  'released',
  'rollback-required',
  'rolled-back',
  'rollback-failed',
  'unknown',
  'manual-intervention'
]);

const DIGEST = /^[a-f0-9]{64}$/;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const OPERATION_PHASES = new Set([
  'preflight',
  'stage',
  'prepare',
  'swap',
  'restart',
  'verify',
  'canary',
  'promote',
  'release',
  'reprepare',
  'rollback',
  'discard-stage'
]);
const SAFE_ERROR_CODES = new Set([
  'adapter_failure',
  'disconnect',
  'injected_failure',
  'journal_write_failed',
  'operation_interrupted',
  'release_failed',
  'restart_failed',
  'rollback_disconnect',
  'timeout'
]);
const IDENTITY_FIELDS = [
  'releaseId',
  'artifactSha256',
  'manifestSha256',
  'configSha256',
  'effectiveConfigSha256',
  'dependencyDigest',
  'runtimeContractDigest'
];
const RECEIPT_KEYS = new Set([
  'operationId',
  'generation',
  'nodeId',
  'phase',
  'status',
  'observedAt',
  'gatewayProtocol',
  'platform',
  'serviceManager',
  'fenceProtocolVersion',
  'atomicLayout',
  'currentIdentity',
  'identity',
  'artifactSha256',
  'manifestSha256',
  'treeSha256',
  'configSha256',
  'dependencyDigest',
  'runtimeContractDigest',
  'effectiveConfigSha256',
  'preservationSnapshotSha256',
  'snapshot',
  'backup',
  'fenced',
  'drained',
  'staged',
  'applied',
  'serviceRestarted',
  'healthy',
  'verified',
  'promoted',
  'released',
  'rollbackReleased',
  'stageDiscarded',
  'restored',
  'gatewayModelId',
  'runtimeId',
  'aliasUsed',
  'cloudFallback',
  'source',
  'privileged',
  'receiptId'
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'undefined' : encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : stableStringify(value))
    .digest('hex');
}

function requiredString(value, label, pattern = null) {
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value.trim()))) {
    throw new DeploymentPlanError(`${label} is required`);
  }
  return value.trim();
}

function requiredDigest(value, label) {
  const digest = requiredString(value, label).toLowerCase();
  if (!DIGEST.test(digest)) throw new DeploymentPlanError(`${label} must be a SHA-256 digest`);
  return digest;
}

function publicIdentity(value, label = 'identity', { allowEmpty = false } = {}) {
  const source = object(value);
  const result = {};
  for (const field of IDENTITY_FIELDS) {
    if (source[field] === undefined) continue;
    if (
      typeof source[field] !== 'string' ||
      !source[field].trim() ||
      /[\r\n]/.test(source[field]) ||
      !SAFE_ID.test(source[field].trim())
    ) {
      throw new DeploymentPlanError(`${label}.${field} must be a non-empty safe string`);
    }
    if (field !== 'releaseId' && !DIGEST.test(source[field].trim().toLowerCase())) {
      throw new DeploymentPlanError(`${label}.${field} must be a SHA-256 digest`);
    }
    result[field] = source[field].trim();
  }
  if (!allowEmpty && !Object.keys(result).length)
    throw new DeploymentPlanError(`${label} must identify the old release`);
  return result;
}

function expectedOldIdentity(value, label = 'expectedOldIdentity') {
  const result = publicIdentity(value, label);
  for (const field of ['releaseId', 'artifactSha256', 'manifestSha256']) {
    if (field === 'releaseId') result[field] = requiredString(result[field], `${label}.${field}`, SAFE_ID);
    else result[field] = requiredDigest(result[field], `${label}.${field}`);
  }
  return result;
}

function identityMatches(actual, expected) {
  const candidate = publicIdentity(actual, 'receipt identity');
  return Object.entries(expected).every(([key, value]) => candidate[key] === value);
}

function safeTimestamp(clock) {
  const value = typeof clock === 'function' ? clock() : clock?.now?.();
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function safeError(error, phase = null) {
  const code = typeof error?.code === 'string' && SAFE_ERROR_CODES.has(error.code) ? error.code : 'adapter_failure';
  const candidatePhase = phase ?? (typeof error?.phase === 'string' ? error.phase : 'unknown');
  const safePhase =
    OPERATION_PHASES.has(candidatePhase) || candidatePhase === 'rollback-finalize' ? candidatePhase : 'unknown';
  return {
    code,
    phase: safePhase,
    message: 'deployment operation failed'
  };
}

function receiptSummary(receipt) {
  const result = {};
  for (const key of RECEIPT_KEYS) {
    if (receipt?.[key] === undefined) continue;
    if (['currentIdentity', 'identity'].includes(key))
      result[key] = publicIdentity(receipt[key], `receipt.${key}`, { allowEmpty: true });
    else if (['snapshot', 'backup'].includes(key)) {
      const value = object(receipt[key]);
      assertSnapshot(value, `receipt.${key}`);
      result[key] = {};
      if (typeof value.id !== 'string' || !SAFE_ID.test(value.id))
        throw new ReceiptError('receipt', 'snapshot id is not public-safe');
      result[key].id = value.id;
      const digestField = typeof value.sha256 === 'string' ? 'sha256' : 'digest';
      if (!digestField || !DIGEST.test(String(value[digestField]).toLowerCase()))
        throw new ReceiptError('receipt', 'snapshot digest is invalid');
      result[key][digestField] = String(value[digestField]).toLowerCase();
    } else if (key === 'receiptId') {
      if (typeof receipt[key] !== 'string' || !SAFE_ID.test(receipt[key]))
        throw new ReceiptError('receipt', 'receipt id is not public-safe');
      result[key] = receipt[key];
    } else if (typeof receipt[key] === 'string') {
      if (!SAFE_ID.test(receipt[key]) || /[\r\n]/.test(receipt[key]))
        throw new ReceiptError('receipt', `${key} is not public-safe`);
      if (
        [
          'artifactSha256',
          'manifestSha256',
          'configSha256',
          'dependencyDigest',
          'runtimeContractDigest',
          'effectiveConfigSha256',
          'preservationSnapshotSha256'
        ].includes(key)
      ) {
        if (!DIGEST.test(receipt[key].toLowerCase())) throw new ReceiptError('receipt', `${key} is not a digest`);
        result[key] = receipt[key].toLowerCase();
      } else {
        result[key] = receipt[key];
      }
    } else if (typeof receipt[key] === 'number' || typeof receipt[key] === 'boolean') {
      result[key] = receipt[key];
    }
  }
  return result;
}

function assertReceipt(receipt, context, phase) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
    throw new ReceiptError(phase, 'receipt is not an object');
  if (receipt.status !== 'ok') throw new ReceiptError(phase, 'receipt did not affirm success');
  if (receipt.operationId !== context.operationId) throw new ReceiptError(phase, 'receipt operation identity mismatch');
  if (receipt.generation !== context.generation) throw new ReceiptError(phase, 'receipt generation mismatch');
  if (receipt.nodeId !== context.nodeId) throw new ReceiptError(phase, 'receipt node identity mismatch');
  if (receipt.phase !== phase) throw new ReceiptError(phase, 'receipt phase mismatch');
  if (typeof receipt.observedAt !== 'string' || Number.isNaN(Date.parse(receipt.observedAt))) {
    throw new ReceiptError(phase, 'receipt timestamp is missing');
  }
  const unknownKeys = Object.keys(receipt).filter((key) => !RECEIPT_KEYS.has(key));
  if (unknownKeys.length) throw new ReceiptError(phase, 'receipt contains non-public fields');
  return receipt;
}

function assertSnapshot(value, label) {
  const snapshot = object(value);
  const id = typeof snapshot.id === 'string' ? snapshot.id : '';
  const digest = typeof snapshot.sha256 === 'string' ? snapshot.sha256 : snapshot.digest;
  if (!SAFE_ID.test(id) || typeof digest !== 'string' || !DIGEST.test(digest)) {
    throw new ReceiptError(label, 'snapshot evidence is incomplete');
  }
}

function normalizeNodes(input) {
  const raw = input.targetNodes ?? input.nodes;
  if (!Array.isArray(raw) || !raw.length) throw new DeploymentPlanError('targetNodes must be a non-empty array');
  const nodes = raw.map((entry, index) => {
    const value = typeof entry === 'string' ? { id: entry } : object(entry);
    const id = requiredString(value.id, `targetNodes[${index}].id`, NODE_ID);
    const role = value.role === 'leader' ? 'leader' : value.role === 'worker' ? 'worker' : null;
    if (!role) throw new DeploymentPlanError(`targetNodes[${index}].role must be worker or leader`);
    return { id, role, order: Number.isFinite(Number(value.order)) ? Number(value.order) : index };
  });
  const ids = new Set();
  for (const node of nodes) {
    if (ids.has(node.id)) throw new DeploymentPlanError(`targetNodes contains duplicate ${node.id}`);
    ids.add(node.id);
  }
  if (nodes.filter((node) => node.role === 'leader').length !== 1) {
    throw new DeploymentPlanError('targetNodes must contain exactly one leader');
  }
  return nodes
    .sort((left, right) =>
      left.role === right.role
        ? left.order - right.order || left.id.localeCompare(right.id)
        : left.role === 'leader'
          ? 1
          : -1
    )
    .map((node, index) => ({ ...node, order: index }));
}

export function normalizeDeploymentPlan(input = {}) {
  const scope = object(input.scope);
  if ((scope.platform ?? input.platform ?? 'linux') !== 'linux')
    throw new DeploymentPlanError('only Linux gateways are supported');
  if ((scope.serviceManager ?? input.serviceManager ?? 'systemd') !== 'systemd') {
    throw new DeploymentPlanError('only systemd gateways are supported');
  }
  if ((scope.mode ?? 'gateway') !== 'gateway') throw new DeploymentPlanError('only gateway deployment is supported');
  if (input.rebuild === true || input.noRebuild === false)
    throw new DeploymentPlanError('deployment coordinator never rebuilds artifacts');
  if (input.reviewedArtifact === undefined) throw new DeploymentPlanError('reviewedArtifact is required');
  const artifact = object(input.reviewedArtifact);
  const artifactSha256 = requiredDigest(artifact.sha256 ?? input.artifactSha256, 'reviewedArtifact.sha256');
  const manifestSha256 = requiredDigest(artifact.manifestSha256 ?? input.manifestSha256, 'manifestSha256');
  if (artifact.reviewed !== true) throw new DeploymentPlanError('reviewedArtifact.reviewed must be true');
  const artifactId = requiredString(artifact.id ?? input.artifactId, 'reviewedArtifact.id', SAFE_ID);
  const artifactPath = artifact.path ?? input.artifactPath;
  const manifestPath = artifact.manifestPath ?? input.manifestPath;
  if (
    artifactPath !== undefined &&
    (typeof artifactPath !== 'string' || !artifactPath.trim() || /[\r\n]/.test(artifactPath))
  ) {
    throw new DeploymentPlanError('reviewedArtifact.path must be a safe path');
  }
  if (
    manifestPath !== undefined &&
    (typeof manifestPath !== 'string' || !manifestPath.trim() || /[\r\n]/.test(manifestPath))
  ) {
    throw new DeploymentPlanError('reviewedArtifact.manifestPath must be a safe path');
  }
  const nodes = normalizeNodes(input);
  const expectedOldIdentity = expectedOldIdentityValue(input.expectedOldIdentity);
  const expectedOldIdentityByNode =
    input.expectedOldIdentityByNode === undefined
      ? undefined
      : normalizeExpectedOldIdentityByNode(input.expectedOldIdentityByNode, nodes);
  const canary = object(input.canary);
  const gatewayModelId = requiredString(canary.gatewayModelId ?? canary.modelId, 'canary.gatewayModelId', SAFE_ID);
  const runtimeId = requiredString(canary.runtimeId, 'canary.runtimeId', SAFE_ID);
  const gatewayProtocol = Number(input.gatewayProtocol ?? 1);
  if (!Number.isInteger(gatewayProtocol) || gatewayProtocol < 1)
    throw new DeploymentPlanError('gatewayProtocol must be a positive integer');
  const drainTimeoutMs = Number(input.drainTimeoutMs ?? 300000);
  if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1000 || drainTimeoutMs > 3600000)
    throw new DeploymentPlanError('drainTimeoutMs must be an integer between 1000 and 3600000');
  return {
    version: 1,
    scope: { platform: 'linux', serviceManager: 'systemd', mode: 'gateway' },
    gatewayProtocol,
    noRebuild: true,
    reviewedArtifact: {
      id: artifactId,
      ...(artifactPath ? { path: artifactPath.trim() } : {}),
      ...(manifestPath ? { manifestPath: manifestPath.trim() } : {}),
      sha256: artifactSha256,
      manifestSha256,
      reviewed: true
    },
    manifestSha256,
    drainTimeoutMs,
    targetNodes: nodes,
    expectedOldIdentity,
    ...(expectedOldIdentityByNode ? { expectedOldIdentityByNode } : {}),
    canary: { gatewayModelId, runtimeId }
  };
}

function expectedOldIdentityValue(value) {
  return expectedOldIdentity(value);
}

function normalizeExpectedOldIdentityByNode(value, nodes) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DeploymentPlanError('expectedOldIdentityByNode must be an object');
  const result = {};
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    if (!(node.id in value)) throw new DeploymentPlanError(`expectedOldIdentityByNode.${node.id} is required`);
    result[node.id] = expectedOldIdentity(value[node.id], `expectedOldIdentityByNode.${node.id}`);
  }
  for (const key of Object.keys(value))
    if (!ids.has(key)) throw new DeploymentPlanError(`unknown expected old identity node ${key}`);
  return result;
}

export function deploymentPlanHash(plan) {
  return sha256(normalizeDeploymentPlan(plan));
}

export class DeploymentPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeploymentPlanError';
    this.code = 'INVALID_DEPLOYMENT_PLAN';
  }
}

export class ReceiptError extends Error {
  constructor(phase, message) {
    super(`${phase}: ${message}`);
    this.name = 'ReceiptError';
    this.code = 'INVALID_OPERATION_RECEIPT';
    this.phase = phase;
  }
}

export class StaleGenerationError extends Error {
  constructor(expected, actual) {
    super(`stale deployment generation ${expected}; current generation is ${actual}`);
    this.name = 'StaleGenerationError';
    this.code = 'STALE_GENERATION';
  }
}

export class DeploymentError extends Error {
  constructor(message, report, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DeploymentError';
    this.code = 'DEPLOYMENT_FAILED';
    this.report = report;
  }
}

export class JournalLockError extends Error {
  constructor() {
    super('another deployment operation holds the local journal lock');
    this.name = 'JournalLockError';
    this.code = 'DEPLOYMENT_JOURNAL_LOCKED';
  }
}

export class DeploymentJournal {
  constructor(journalPath, { lockPath = `${journalPath}.lock`, fsImpl = fs } = {}) {
    if (!journalPath) throw new Error('journalPath is required');
    this.journalPath = path.resolve(journalPath);
    this.lockPath = path.resolve(lockPath);
    this.fs = fsImpl;
  }

  async load() {
    try {
      return JSON.parse(await this.fs.readFile(this.journalPath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw new Error('deployment journal could not be read', { cause: error });
    }
  }

  async save(document) {
    const directory = path.dirname(this.journalPath);
    await this.fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.journalPath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await this.fs.writeFile(temporary, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
      const handle = await this.fs.open(temporary, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.fs.rename(temporary, this.journalPath);
      const directoryHandle = await this.fs.open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      await this.fs.unlink(temporary).catch(() => {});
      throw new Error('deployment journal write failed');
    }
  }

  async acquire(operationId) {
    let created = false;
    try {
      await this.fs.mkdir(this.lockPath, { recursive: false, mode: 0o700 });
      created = true;
      await this.fs.writeFile(path.join(this.lockPath, 'owner'), JSON.stringify({ operationId, pid: process.pid }), {
        mode: 0o600
      });
    } catch (error) {
      if (created) await this.fs.rm(this.lockPath, { recursive: true, force: true }).catch(() => {});
      if (error?.code === 'EEXIST') throw new JournalLockError();
      throw new Error('deployment journal lock could not be acquired', { cause: error });
    }
  }

  async release() {
    await this.fs.rm(this.lockPath, { recursive: true, force: true });
  }
}

function initialJournal(plan, operationId, generation, clock) {
  const timestamp = safeTimestamp(clock);
  return {
    version: 1,
    operationId,
    generation,
    plan: clone(plan),
    planHash: deploymentPlanHash(plan),
    operationState: 'running',
    phase: 'preflight',
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes: Object.fromEntries(
      plan.targetNodes.map((node) => [
        node.id,
        {
          nodeId: node.id,
          role: node.role,
          state: 'preflight',
          receipts: {},
          pendingAction: null,
          possiblyMutated: false,
          lastError: null
        }
      ])
    ),
    mutationOrder: [],
    events: [],
    failure: null,
    rollback: { attempted: false, failures: [], manualIntervention: false }
  };
}

export class ClusterDeploymentCoordinator {
  constructor({
    journalPath,
    journal = null,
    transport,
    clock = () => new Date(),
    operationIdFactory = randomUUID
  } = {}) {
    if (!transport || typeof transport !== 'object') throw new Error('transport adapter is required');
    const methods = [
      'preflight',
      'stage',
      'prepare',
      'swap',
      'restart',
      'verify',
      'canary',
      'promote',
      'release',
      'reprepare',
      'rollback',
      'discardStage'
    ];
    for (const method of methods) {
      if (typeof transport[method] !== 'function') throw new Error(`transport.${method} is required`);
    }
    this.journal = journal ?? new DeploymentJournal(journalPath);
    this.transport = transport;
    this.clock = clock;
    this.operationIdFactory = operationIdFactory;
  }

  async status(operationId) {
    const document = await this.journal.load();
    if (!document || document.operationId !== operationId) return null;
    return clone(document);
  }

  async deploy(input, { operationId = null } = {}) {
    const plan = normalizeDeploymentPlan(input);
    const id = requiredString(operationId ?? this.operationIdFactory(), 'operationId', SAFE_ID);
    return this.#withLock(id, async () => {
      const existing = await this.journal.load();
      if (existing) throw new DeploymentError('deployment journal already contains an operation', clone(existing));
      const document = initialJournal(plan, id, 1, this.clock);
      await this.#save(document);
      return this.#run(document);
    });
  }

  async resume(operationId, { generation = null, plan = null } = {}) {
    requiredString(operationId, 'operationId', SAFE_ID);
    return this.#withLock(operationId, async () => {
      const document = await this.#load(operationId);
      this.#assertGeneration(document, generation);
      if (plan && deploymentPlanHash(plan) !== document.planHash)
        throw new DeploymentPlanError('immutable deployment plan hash mismatch');
      if (['completed', 'rolled-back'].includes(document.operationState)) return clone(document);
      document.generation += 1;
      document.updatedAt = safeTimestamp(this.clock);
      this.#append(document, { type: 'resume', phase: document.phase });
      await this.#save(document);
      if (['rollback-required', 'rollback-failed'].includes(document.operationState)) {
        return this.#finishRollback(document, new Error('resuming an operation that requires rollback'));
      }
      return this.#run(document);
    });
  }

  async rollback(operationId, { generation = null } = {}) {
    requiredString(operationId, 'operationId', SAFE_ID);
    return this.#withLock(operationId, async () => {
      const document = await this.#load(operationId);
      this.#assertGeneration(document, generation);
      if (document.operationState === 'rolled-back') return clone(document);
      if (document.operationState === 'completed')
        throw new DeploymentError('completed deployment requires an explicit new operation', clone(document));
      document.generation += 1;
      document.operationState = 'rollback-required';
      document.updatedAt = safeTimestamp(this.clock);
      this.#append(document, { type: 'rollback-requested', phase: 'rollback' });
      await this.#save(document);
      return this.#finishRollback(document, new Error('rollback requested'));
    });
  }

  async #run(document) {
    try {
      await this.#recoverPending(document);
      await this.#execute(document);
      document.operationState = 'completed';
      document.phase = 'released';
      document.updatedAt = safeTimestamp(this.clock);
      this.#append(document, { type: 'completed', phase: 'release' });
      await this.#save(document);
      return clone(document);
    } catch (error) {
      return this.#finishRollback(document, error);
    }
  }

  async #execute(document) {
    const nodes = this.#orderedNodes(document);
    document.phase = 'preflight';
    for (const node of nodes) {
      if (node.receipts.preflight) continue;
      await this.#action(document, node, 'preflight', 'preflight', {
        mutation: false,
        validate: (receipt) => {
          if (receipt.platform !== 'linux' || receipt.serviceManager !== 'systemd')
            throw new ReceiptError('preflight', 'node is not a Linux systemd gateway');
          if (receipt.gatewayProtocol !== document.plan.gatewayProtocol)
            throw new ReceiptError('preflight', 'unsupported gateway protocol');
          if (receipt.fenceProtocolVersion !== 1)
            throw new ReceiptError('preflight', 'unsupported gateway fence protocol');
          if (!(receipt.atomicLayout === true || receipt.atomicLayout === 'atomic'))
            throw new ReceiptError('preflight', 'node lacks an atomic deployment layout');
          if (!identityMatches(receipt.currentIdentity, this.#expectedOldIdentity(document, node)))
            throw new ReceiptError('preflight', 'expected old identity drifted');
          const expected = this.#expectedOldIdentity(document, node);
          if (
            receipt.effectiveConfigSha256 !== undefined &&
            (!DIGEST.test(String(receipt.effectiveConfigSha256).toLowerCase()) ||
              (expected.effectiveConfigSha256 !== undefined &&
                receipt.effectiveConfigSha256 !== expected.effectiveConfigSha256))
          )
            throw new ReceiptError('preflight', 'effective config identity drifted');
          if (
            receipt.preservationSnapshotSha256 !== undefined &&
            !DIGEST.test(String(receipt.preservationSnapshotSha256).toLowerCase())
          )
            throw new ReceiptError('preflight', 'preservation snapshot evidence is invalid');
        }
      });
    }
    document.phase = 'stage';
    for (const node of nodes) {
      if (node.state !== 'preflight' || node.receipts.stage) continue;
      await this.#action(document, node, 'stage', 'stage', {
        nextState: 'staged',
        validate: (receipt) => {
          if (
            receipt.staged !== true ||
            receipt.artifactSha256 !== document.plan.reviewedArtifact.sha256 ||
            receipt.manifestSha256 !== document.plan.manifestSha256
          ) {
            throw new ReceiptError('stage', 'staged artifact or manifest digest mismatch');
          }
        }
      });
    }
    if (nodes.some((node) => node.state !== 'staged')) throw new Error('stage barrier did not complete for every node');

    document.phase = 'prepare';
    for (const node of nodes) {
      if (node.state !== 'staged') continue;
      await this.#action(document, node, 'prepare', 'prepare', {
        nextState: 'prepared',
        validate: (receipt) => {
          if (receipt.fenced !== true || receipt.drained !== true)
            throw new ReceiptError('prepare', 'node did not affirm fence and drain');
          assertSnapshot(receipt.backup, 'prepare backup');
          assertSnapshot(receipt.snapshot, 'prepare snapshot');
        }
      });
    }
    if (nodes.some((node) => node.state !== 'prepared'))
      throw new Error('prepare barrier did not complete for every node');

    document.phase = 'swap';
    for (const node of nodes) {
      if (node.state === 'prepared' && !node.receipts.swap) {
        await this.#action(document, node, 'swap', 'swap', {
          nextState: 'mutating',
          validate: (receipt) => this.#assertNewIdentity(receipt, document, 'swap', node)
        });
      }
      if (node.state === 'mutating' && node.receipts.swap && !node.receipts.restart) {
        await this.#action(document, node, 'restart', 'restart', {
          nextState: 'active',
          validate: (receipt) => {
            if (receipt.serviceRestarted !== true || receipt.healthy !== true)
              throw new ReceiptError('restart', 'service did not return healthy');
            this.#assertNewIdentity(receipt, document, 'restart', node);
          }
        });
      }
    }

    document.phase = 'verify';
    for (const node of nodes) {
      if (node.state !== 'active') continue;
      await this.#action(document, node, 'verify', 'verify', {
        nextState: 'verified',
        mutation: false,
        validate: (receipt) => {
          if (receipt.verified !== true)
            throw new ReceiptError('verify', 'node did not affirm exact identity verification');
          this.#assertNewIdentity(receipt, document, 'verify', node);
        }
      });
    }

    const leader = nodes.find((node) => node.role === 'leader');
    document.phase = 'canary';
    if (!leader.receipts.canary) {
      await this.#action(document, leader, 'canary', 'canary', {
        mutation: false,
        validate: (receipt) => {
          if (
            receipt.healthy !== true ||
            receipt.gatewayModelId !== document.plan.canary.gatewayModelId ||
            receipt.runtimeId !== document.plan.canary.runtimeId ||
            receipt.fenced !== true ||
            receipt.privileged !== true ||
            receipt.aliasUsed !== false ||
            receipt.cloudFallback !== false ||
            receipt.source !== 'local'
          ) {
            throw new ReceiptError(
              'canary',
              'canary was not a healthy privileged local request on the exact fenced model and runtime'
            );
          }
        }
      });
    }

    document.phase = 'promote';
    for (const node of nodes) {
      if (node.state !== 'verified') continue;
      await this.#action(document, node, 'promote', 'promote', {
        nextState: 'promoted',
        validate: (receipt) => {
          if (receipt.promoted !== true) throw new ReceiptError('promote', 'node did not affirm promotion');
          this.#assertNewIdentity(receipt, document, 'promote', node);
        }
      });
    }

    document.phase = 'release';
    for (const node of nodes) {
      if (node.state !== 'promoted') continue;
      await this.#action(document, node, 'release', 'release', {
        nextState: 'released',
        validate: (receipt) => {
          if (receipt.released !== true || receipt.fenced !== false)
            throw new ReceiptError('release', 'public release was not affirmed');
        }
      });
    }
    if (nodes.some((node) => node.state !== 'released')) throw new Error('release did not complete for every node');
  }

  #assertNewIdentity(receipt, document, phase, node) {
    const identity = publicIdentity(receipt.identity ?? receipt, `${phase} identity`);
    const expected = {
      artifactSha256: document.plan.reviewedArtifact.sha256,
      manifestSha256: document.plan.manifestSha256
    };
    if (identity.artifactSha256 !== expected.artifactSha256 || identity.manifestSha256 !== expected.manifestSha256) {
      throw new ReceiptError(phase, 'active identity does not match the reviewed artifact');
    }
    for (const field of ['configSha256', 'dependencyDigest', 'runtimeContractDigest']) {
      if (typeof identity[field] !== 'string' || !DIGEST.test(identity[field]))
        throw new ReceiptError(phase, `${field} evidence is missing or invalid`);
    }
    if (
      identity.effectiveConfigSha256 !== undefined &&
      (typeof identity.effectiveConfigSha256 !== 'string' || !DIGEST.test(identity.effectiveConfigSha256))
    )
      throw new ReceiptError(phase, 'effectiveConfigSha256 evidence is invalid');
    const baselineSnapshot = node?.receipts?.preflight?.preservationSnapshotSha256;
    if (baselineSnapshot !== undefined && receipt.preservationSnapshotSha256 !== baselineSnapshot)
      throw new ReceiptError(phase, 'preservation snapshot changed from the preflight gateway contract');
    const baseline = node?.receipts?.preflight?.currentIdentity;
    for (const field of ['configSha256', 'effectiveConfigSha256', 'dependencyDigest', 'runtimeContractDigest']) {
      if (baseline?.[field] !== undefined && identity[field] !== baseline[field])
        throw new ReceiptError(phase, `${field} changed from the preflight gateway contract`);
    }
    if (!identity.releaseId || !SAFE_ID.test(identity.releaseId))
      throw new ReceiptError(phase, 'releaseId evidence is missing');
    const previousPhases = ['swap', 'restart', 'verify', 'promote'].filter((candidate) => candidate !== phase);
    for (const previousPhase of previousPhases) {
      const previous = node?.receipts?.[previousPhase]?.identity;
      if (!previous) continue;
      for (const field of IDENTITY_FIELDS) {
        if (identity[field] !== previous[field])
          throw new ReceiptError(phase, `${field} identity drifted from ${previousPhase}`);
      }
    }
    assertSnapshot(receipt.snapshot, `${phase} snapshot`);
  }

  #expectedOldIdentity(document, node) {
    return clone(document.plan.expectedOldIdentityByNode?.[node.nodeId] ?? document.plan.expectedOldIdentity);
  }

  async #action(
    document,
    node,
    phase,
    method,
    { nextState = null, mutation = true, validate = null, contextOptions = {} } = {}
  ) {
    if (!OPERATION_PHASES.has(phase)) throw new Error(`unsupported operation phase ${phase}`);
    const context = this.#context(document, node, phase, contextOptions);
    node.pendingAction = phase;
    node.possiblyMutated = node.possiblyMutated || mutation;
    if (mutation && !document.mutationOrder.includes(node.nodeId)) document.mutationOrder.push(node.nodeId);
    this.#append(document, { type: 'intent', phase, nodeId: node.nodeId });
    await this.#save(document);
    let raw;
    let summary;
    try {
      raw = await this.transport[method](node.nodeId, context);
      assertReceipt(raw, context, phase);
      if (validate) validate(raw);
      summary = receiptSummary(raw);
    } catch (error) {
      node.state = 'unknown';
      node.lastError = safeError(error, phase);
      this.#append(document, { type: 'failure', phase, nodeId: node.nodeId, error: node.lastError });
      await this.#saveBestEffort(document);
      throw error;
    }
    node.receipts[phase] = summary;
    node.pendingAction = null;
    if (nextState) node.state = nextState;
    node.lastError = null;
    this.#append(document, { type: 'receipt', phase, nodeId: node.nodeId, receipt: node.receipts[phase] });
    await this.#save(document);
    return raw;
  }

  async #recoverPending(document) {
    const pending = Object.values(document.nodes).filter((node) => node.pendingAction);
    if (!pending.length) return;
    for (const node of pending) {
      node.state = 'unknown';
      node.possiblyMutated = true;
      node.lastError = safeError({ code: 'operation_interrupted' }, node.pendingAction);
      this.#append(document, {
        type: 'uncertain',
        phase: node.pendingAction,
        nodeId: node.nodeId,
        error: node.lastError
      });
    }
    document.operationState = 'rollback-required';
    await this.#save(document);
    throw new Error('journal contains an operation whose outcome is uncertain');
  }

  async #finishRollback(document, originalError) {
    document.operationState = 'rollback-required';
    document.failure = safeError(originalError, document.phase);
    document.updatedAt = safeTimestamp(this.clock);
    this.#append(document, { type: 'rollback-required', phase: 'rollback', error: document.failure });
    await this.#saveBestEffort(document);
    const failures = [];
    document.rollback.attempted = true;
    const nodes = this.#rollbackOrder(document);
    const restoreCandidates = [];
    const discardCandidates = [];
    const reservationCandidates = [];
    const recordFailure = (node, error, phase = node.pendingAction ?? 'rollback') => {
      node.state = 'rollback-failed';
      node.lastError = safeError(error, phase);
      failures.push({ nodeId: node.nodeId, error: node.lastError });
      this.#append(document, { type: 'rollback-failure', phase, nodeId: node.nodeId, error: node.lastError });
    };

    // Classify the journal before issuing any compensating mutation. A node
    // that reached an active/public phase belongs to the fleet fence barrier;
    // a stage-only node can be discarded without touching its service.
    for (const node of nodes) {
      // A successful preflight reserves the node's durable agent lock even
      // though it has not fenced or touched the service. Release that
      // reservation explicitly on an abort so a later operation is not
      // stranded behind a harmless, completed inspection.
      if (!node.possiblyMutated && node.state === 'preflight') {
        reservationCandidates.push(node);
        continue;
      }
      const onlyStageCleanup =
        node.state === 'rolled-back' &&
        Boolean(node.receipts['discard-stage']) &&
        !['prepare', 'swap', 'restart', 'verify', 'canary', 'promote', 'release', 'rollback'].some(
          (phase) => node.receipts[phase]
        );
      // A stage-only cleanup already released the node reservation and never
      // fenced the gateway. Do not reclassify that terminal receipt as a
      // service mutation if an operator later retries journal cleanup.
      if (onlyStageCleanup) {
        node.possiblyMutated = false;
        continue;
      }
      const preparedOrBeyond = Boolean(
        node.receipts.prepare ||
        node.receipts.swap ||
        node.receipts.restart ||
        node.receipts.verify ||
        node.receipts.canary ||
        node.receipts.promote ||
        node.receipts.release ||
        node.receipts.rollback ||
        [
          'prepared',
          'mutating',
          'active',
          'verified',
          'promoted',
          'released',
          'rolled-back',
          'rollback-failed'
        ].includes(node.state) ||
        ['prepare', 'swap', 'restart', 'verify', 'canary', 'promote', 'release', 'reprepare', 'rollback'].includes(
          node.pendingAction
        )
      );
      if (!preparedOrBeyond) {
        if (node.receipts.stage || node.pendingAction === 'stage' || node.state === 'unknown') {
          discardCandidates.push(node);
        } else {
          node.state = 'rolled-back';
          node.possiblyMutated = false;
          this.#append(document, { type: 'rolled-back', phase: 'rollback', nodeId: node.nodeId });
        }
        continue;
      }
      restoreCandidates.push(node);
    }
    await this.#saveBestEffort(document);

    // Release preflight-only reservations before establishing the fleet
    // rollback barrier. This path has no service or artifact mutation and is
    // deliberately distinct from discard-stage cleanup for an uncertain or
    // failed stage.
    for (const node of reservationCandidates) {
      try {
        await this.#action(document, node, 'discard-stage', 'discardStage', {
          mutation: false,
          nextState: 'rolled-back',
          contextOptions: { reservationOnly: true },
          validate: (receipt) => {
            if (receipt.stageDiscarded !== true)
              throw new ReceiptError('discard-stage', 'preflight reservation was not released');
          }
        });
      } catch (error) {
        recordFailure(node, error, 'discard-stage');
      }
    }

    // Establish one fleet-wide fence/drain barrier before any rollback swap
    // or restart. A partial forward release may have opened one gateway while
    // another is still on new bytes; restoring nodes one at a time would make
    // that mixed public state observable. Attempt the barrier for every
    // affected node even after one failure so the report identifies all
    // nodes that could not be fenced. No rollback action is issued unless all
    // of these fresh receipts succeed.
    for (const node of restoreCandidates) {
      try {
        await this.#action(document, node, 'reprepare', 'reprepare', {
          nextState: 'rollback-required',
          validate: (receipt) => {
            if (receipt.fenced !== true || receipt.drained !== true)
              throw new ReceiptError('reprepare', 'fresh fence and drain were not affirmed');
          }
        });
      } catch (error) {
        recordFailure(node, error, 'reprepare');
      }
    }

    // Restore every possibly mutated node while the fleet barrier is held.
    // Public release is deliberately deferred until the whole fleet has an
    // independently verified old identity.
    if (!failures.length) {
      for (const node of restoreCandidates) {
        if (node.state === 'rolled-back') continue;
        try {
          await this.#action(document, node, 'rollback', 'rollback', {
            nextState: 'rolled-back',
            validate: (receipt) => {
              if (receipt.restored !== true || receipt.fenced !== true || receipt.drained !== true)
                throw new ReceiptError('rollback', 'rollback did not affirm restored fenced state');
              if (!identityMatches(receipt.identity, this.#expectedOldIdentity(document, node)))
                throw new ReceiptError('rollback', 'rollback identity does not match expected old release');
            }
          });
        } catch (error) {
          recordFailure(node, error);
        }
      }
    }

    // Stage-only or interrupted preflight nodes never need a service fence,
    // but their reviewed artifact must still be discarded before completion.
    if (!failures.length) {
      for (const node of discardCandidates) {
        try {
          await this.#action(document, node, 'discard-stage', 'discardStage', {
            nextState: 'rolled-back',
            validate: (receipt) => {
              if (receipt.stageDiscarded !== true)
                throw new ReceiptError('discard-stage', 'staged artifact was not discarded');
            }
          });
        } catch (error) {
          recordFailure(node, error, 'discard-stage');
        }
      }
    }

    // A single old-release canary on the leader is the last fleet-wide gate.
    // If it fails, all successfully restored nodes stay fenced for manual
    // intervention; no mixed public state is opened.
    const leader = nodes.find((node) => node.role === 'leader');
    if (!failures.length && leader && restoreCandidates.includes(leader) && leader.state === 'rolled-back') {
      try {
        await this.#action(document, leader, 'canary', 'canary', {
          mutation: false,
          nextState: 'rolled-back',
          validate: (receipt) => {
            if (
              receipt.healthy !== true ||
              receipt.fenced !== true ||
              receipt.privileged !== true ||
              receipt.aliasUsed !== false ||
              receipt.cloudFallback !== false ||
              receipt.source !== 'local' ||
              receipt.gatewayModelId !== document.plan.canary.gatewayModelId ||
              receipt.runtimeId !== document.plan.canary.runtimeId
            )
              throw new ReceiptError('canary', 'old-release canary was not local, healthy, and fenced');
          }
        });
      } catch (error) {
        recordFailure(leader, error, 'canary');
      }
    }

    // Only after every node is restored and the leader canary succeeds may the
    // compensating release open the gateways. Each release is still a
    // separately journaled action; a partial release becomes manual
    // intervention rather than a false global completion.
    if (!failures.length) {
      for (const node of restoreCandidates) {
        if (node.state !== 'rolled-back') continue;
        try {
          await this.#action(document, node, 'release', 'release', {
            nextState: 'rolled-back',
            validate: (receipt) => {
              if (receipt.released !== true || receipt.fenced !== false || receipt.rollbackReleased !== true)
                throw new ReceiptError('release', 'restored old release was not publicly released');
            }
          });
        } catch (error) {
          recordFailure(node, error, 'release');
        }
      }
    }

    if (!failures.length) {
      for (const node of restoreCandidates) {
        if (node.state !== 'rolled-back' || !node.receipts.stage) continue;
        try {
          await this.#action(document, node, 'discard-stage', 'discardStage', {
            nextState: 'rolled-back',
            validate: (receipt) => {
              if (receipt.stageDiscarded !== true)
                throw new ReceiptError('discard-stage', 'staged artifact was not discarded');
            }
          });
        } catch (error) {
          recordFailure(node, error, 'discard-stage');
        }
      }
    }
    document.rollback.failures = failures;
    document.rollback.manualIntervention = failures.length > 0;
    document.operationState = failures.length ? 'rollback-failed' : 'rolled-back';
    document.phase = failures.length ? 'rollback' : 'rolled-back';
    document.updatedAt = safeTimestamp(this.clock);
    this.#append(document, {
      type: failures.length ? 'manual-intervention' : 'rolled-back',
      phase: 'rollback',
      ...(failures.length ? { failures } : {})
    });
    try {
      await this.#save(document);
    } catch {
      document.rollback.manualIntervention = true;
      document.operationState = 'rollback-failed';
      failures.push({ nodeId: null, error: safeError({ code: 'journal_write_failed' }, 'rollback-finalize') });
    }
    throw new DeploymentError(
      failures.length ? 'deployment failed and requires manual intervention' : 'deployment failed and was rolled back',
      clone(document),
      originalError
    );
  }

  #context(document, node, phase, options = {}) {
    return {
      operationId: document.operationId,
      generation: document.generation,
      planHash: document.planHash,
      phase,
      nodeId: node.nodeId,
      role: node.role,
      scope: clone(document.plan.scope),
      gatewayProtocol: document.plan.gatewayProtocol,
      drainTimeoutMs: document.plan.drainTimeoutMs,
      artifact: clone(document.plan.reviewedArtifact),
      manifestSha256: document.plan.manifestSha256,
      expectedOldIdentity: this.#expectedOldIdentity(document, node),
      canary: clone(document.plan.canary),
      rollbackCanary: phase === 'canary' && Boolean(node.receipts.rollback),
      rollbackRelease: phase === 'release' && Boolean(node.receipts.rollback),
      ...(options.reservationOnly === true ? { reservationOnly: true } : {})
    };
  }

  #orderedNodes(document) {
    return document.plan.targetNodes.map((entry) => document.nodes[entry.id]).filter(Boolean);
  }

  #rollbackOrder(document) {
    const all = this.#orderedNodes(document);
    const ids = [...document.mutationOrder].reverse();
    return [...new Set([...ids, ...all.map((node) => node.nodeId)])].map((id) => document.nodes[id]).filter(Boolean);
  }

  #append(document, event) {
    document.events.push({ at: safeTimestamp(this.clock), ...event });
    if (document.events.length > 2000) document.events.splice(0, document.events.length - 2000);
    document.updatedAt = safeTimestamp(this.clock);
  }

  async #save(document) {
    await this.journal.save(clone(document));
  }

  async #saveBestEffort(document) {
    try {
      await this.#save(document);
    } catch {
      document.rollback.manualIntervention = true;
    }
  }

  async #load(operationId) {
    const document = await this.journal.load();
    if (!document || document.operationId !== operationId)
      throw new DeploymentError('deployment operation was not found', document ? clone(document) : null);
    if (
      document.version !== 1 ||
      typeof document.planHash !== 'string' ||
      document.planHash !== deploymentPlanHash(document.plan)
    ) {
      throw new DeploymentError('deployment journal plan integrity check failed', clone(document));
    }
    return document;
  }

  #assertGeneration(document, generation) {
    if (generation !== null && Number(generation) !== document.generation)
      throw new StaleGenerationError(generation, document.generation);
  }

  async #withLock(operationId, fn) {
    await this.journal.acquire(operationId);
    try {
      return await fn();
    } finally {
      await this.journal.release();
    }
  }
}

export const DeploymentCoordinator = ClusterDeploymentCoordinator;
