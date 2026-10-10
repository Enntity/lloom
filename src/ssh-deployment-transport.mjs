import { spawn } from 'node:child_process';
import path from 'node:path';

const HOST = /^[A-Za-z0-9][A-Za-z0-9._:@%+-]{0,255}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@%+,-]{0,255}$/;
const PHASES = new Set([
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
const MAX_SSH_OUTPUT_BYTES = 1024 * 1024;
const MAX_SSH_TIMEOUT_MS = 3_660_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 300_000;
const DRAIN_PHASES = new Set(['prepare', 'reprepare']);
const DRAIN_TIMEOUT_MARGIN_MS = 60_000;
const ARTIFACT_PHASES = new Set(['stage', 'swap', 'restart', 'verify', 'promote']);

function safeToken(value, label, pattern = TOKEN) {
  if (typeof value !== 'string' || !value || !pattern.test(value) || /[\r\n;|&$`<>]/.test(value)) {
    throw new SshTransportError(`${label} is invalid`, 'invalid_transport_config');
  }
  return value;
}

function reviewedRemotePath(value, label) {
  if (
    typeof value !== 'string' ||
    !value ||
    !value.startsWith('/') ||
    path.posix.normalize(value) !== value ||
    /[\u0000-\u001f\u007f\r\n;|&$`<>]/.test(value)
  ) {
    throw new SshTransportError(`${label} must be an absolute normalized path`, 'invalid_artifact_path');
  }
  return value;
}

function reviewedArtifactPaths(context) {
  const artifact = context?.artifact;
  const artifactPath = reviewedRemotePath(artifact?.path, 'reviewed artifact path');
  const manifestPath = reviewedRemotePath(artifact?.manifestPath, 'reviewed manifest path');
  if (artifactPath === manifestPath)
    throw new SshTransportError('reviewed artifact and manifest paths must differ', 'invalid_artifact_path');
  return { artifactPath, manifestPath };
}

function nodeSpec(value, nodeId) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const host = safeToken(source.host, `${nodeId}.host`, HOST);
  const user = source.user === undefined ? null : safeToken(source.user, `${nodeId}.user`, HOST);
  const port = source.port === undefined ? null : Number(source.port);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))
    throw new SshTransportError(`${nodeId}.port is invalid`, 'invalid_transport_config');
  const hostKeyAlias =
    source.hostKeyAlias === undefined ? null : safeToken(source.hostKeyAlias, `${nodeId}.hostKeyAlias`, HOST);
  const remoteCommand = source.remoteCommand === undefined ? ['lloom', 'node-agent'] : source.remoteCommand;
  if (
    !Array.isArray(remoteCommand) ||
    !remoteCommand.length ||
    remoteCommand.some((token) => typeof token !== 'string' || !TOKEN.test(token))
  )
    throw new SshTransportError(`${nodeId}.remoteCommand is invalid`, 'invalid_transport_config');
  return { host, user, port, hostKeyAlias, remoteCommand: [...remoteCommand] };
}

function publicError(error, phase) {
  const code =
    typeof error?.code === 'string' && /^[a-z][a-z0-9_:-]{0,63}$/.test(error.code)
      ? error.code
      : 'ssh_transport_failure';
  return new SshTransportError(`remote ${phase} failed`, code);
}

function publicContext(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const key of [
    'operationId',
    'generation',
    'planHash',
    'phase',
    'nodeId',
    'role',
    'gatewayProtocol',
    'manifestSha256',
    'drainTimeoutMs',
    'reservationOnly',
    'rollbackCanary',
    'rollbackRelease'
  ]) {
    if (source[key] !== undefined) result[key] = structuredClone(source[key]);
  }
  if (source.scope && typeof source.scope === 'object') {
    result.scope = {};
    for (const key of ['platform', 'serviceManager', 'mode'])
      if (source.scope[key] !== undefined) result.scope[key] = source.scope[key];
  }
  if (source.expectedOldIdentity && typeof source.expectedOldIdentity === 'object') {
    result.expectedOldIdentity = {};
    for (const key of [
      'releaseId',
      'artifactSha256',
      'manifestSha256',
      'configSha256',
      'effectiveConfigSha256',
      'dependencyDigest',
      'runtimeContractDigest'
    ]) {
      if (source.expectedOldIdentity[key] !== undefined)
        result.expectedOldIdentity[key] = source.expectedOldIdentity[key];
    }
  }
  if (source.canary && typeof source.canary === 'object') {
    result.canary = {};
    for (const key of ['gatewayModelId', 'runtimeId'])
      if (source.canary[key] !== undefined) result.canary[key] = source.canary[key];
  }
  if (source.artifact && typeof source.artifact === 'object' && !Array.isArray(source.artifact)) {
    result.artifact = {};
    for (const key of ['id', 'path', 'manifestPath', 'sha256', 'manifestSha256', 'reviewed']) {
      if (source.artifact[key] !== undefined) result.artifact[key] = source.artifact[key];
    }
  }
  return result;
}

function spawnSsh(node, argv, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const append = (target, chunk) => {
      if (settled) return;
      const value = Buffer.from(chunk);
      outputBytes += value.byteLength;
      if (outputBytes > MAX_SSH_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(reject, new SshTransportError(`remote ${node.host} returned too much output`, 'output_too_large'));
        return;
      }
      target.push(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new SshTransportError(`remote ${node.host} timed out`, 'timeout'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => append(stdout, chunk));
    child.stderr.on('data', (chunk) => append(stderr, chunk));
    child.stdin.on('error', (error) => finish(reject, publicError(error, 'ssh')));
    child.on('error', (error) => finish(reject, publicError(error, 'ssh')));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(
          reject,
          new SshTransportError(`remote command exited ${code}`, code === null ? 'disconnect' : 'remote_failure')
        );
      } else {
        finish(resolve, {
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8')
        });
      }
    });
    try {
      child.stdin.end(input);
    } catch (error) {
      finish(reject, publicError(error, 'ssh'));
    }
  });
}

export class SshTransportError extends Error {
  constructor(message, code = 'ssh_transport_failure') {
    super(message);
    this.name = 'SshTransportError';
    this.code = code;
  }
}

/**
 * Coordinator transport for an already-reviewed artifact and an installed
 * node-agent. It never builds, uploads, or changes a model/runtime process.
 * `runSsh(node, request)` is injectable for tests; its request contains only
 * public plan context and the remote argv. Artifact and manifest paths are
 * absolute, normalized paths already present on the target. If `upload` is
 * supplied, it may pre-stage those files but must return the exact paths from
 * the reviewed plan so a later process can resume without transport state.
 */
export class SshDeploymentTransport {
  constructor({ nodes, runSsh = null, upload = null, timeoutMs = 120000 } = {}) {
    if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes))
      throw new SshTransportError('nodes map is required', 'invalid_transport_config');
    this.nodes = new Map(Object.entries(nodes).map(([id, spec]) => [safeToken(id, 'node id'), nodeSpec(spec, id)]));
    if (!this.nodes.size) throw new SshTransportError('nodes map must not be empty', 'invalid_transport_config');
    if (typeof upload !== 'function' && upload !== null)
      throw new SshTransportError('upload must be a function', 'invalid_transport_config');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_SSH_TIMEOUT_MS)
      throw new SshTransportError('timeoutMs is invalid', 'invalid_transport_config');
    this.runSsh = runSsh ?? ((node, request) => spawnSsh(node, request.argv, request.input, request.timeoutMs));
    this.upload = upload;
    this.timeoutMs = timeoutMs;
  }

  preflight(nodeId, context) {
    return this.#call(nodeId, 'preflight', context);
  }

  async stage(nodeId, context) {
    let nextContext = context;
    const configuredPaths = reviewedArtifactPaths(context);
    if (this.upload) {
      const uploaded = await this.upload(this.#node(nodeId), publicContext(context));
      if (!uploaded || typeof uploaded !== 'object')
        throw new SshTransportError('artifact upload did not return paths', 'upload_failed');
      const artifactPath = reviewedRemotePath(uploaded.artifactPath, 'uploaded.artifactPath');
      const manifestPath = reviewedRemotePath(uploaded.manifestPath, 'uploaded.manifestPath');
      if (artifactPath !== configuredPaths.artifactPath || manifestPath !== configuredPaths.manifestPath) {
        throw new SshTransportError(
          'artifact upload paths must exactly match the reviewed plan paths',
          'upload_path_mismatch'
        );
      }
    }
    return this.#call(nodeId, 'stage', nextContext);
  }

  prepare(nodeId, context) {
    return this.#call(nodeId, 'prepare', context);
  }
  swap(nodeId, context) {
    return this.#call(nodeId, 'swap', context);
  }
  restart(nodeId, context) {
    return this.#call(nodeId, 'restart', context);
  }
  verify(nodeId, context) {
    return this.#call(nodeId, 'verify', context);
  }
  canary(nodeId, context) {
    return this.#call(nodeId, 'canary', context);
  }
  promote(nodeId, context) {
    return this.#call(nodeId, 'promote', context);
  }
  release(nodeId, context) {
    return this.#call(nodeId, 'release', context);
  }
  reprepare(nodeId, context) {
    return this.#call(nodeId, 'reprepare', context);
  }
  rollback(nodeId, context) {
    return this.#call(nodeId, 'rollback', context);
  }
  discardStage(nodeId, context) {
    return this.#call(nodeId, 'discard-stage', context);
  }

  #node(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new SshTransportError('node is not configured', 'node_not_configured');
    return node;
  }

  async #call(nodeId, phase, context) {
    if (!PHASES.has(phase)) throw new SshTransportError('unsupported remote phase', 'invalid_phase');
    if (ARTIFACT_PHASES.has(phase)) reviewedArtifactPaths(context);
    const node = this.#node(nodeId);
    const destination = node.user ? `${node.user}@${node.host}` : node.host;
    const argv = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15'];
    if (node.hostKeyAlias) argv.push('-o', `HostKeyAlias=${node.hostKeyAlias}`);
    if (node.port) argv.push('-p', String(node.port));
    argv.push(destination, ...node.remoteCommand, phase, '--json');
    const request = {
      argv,
      input: `${JSON.stringify(publicContext(context))}\n`,
      timeoutMs: this.#timeoutFor(phase, context),
      phase,
      nodeId
    };
    let result;
    try {
      result = await this.runSsh(node, request);
    } catch (error) {
      throw publicError(error, phase);
    }
    if (!result || result.code !== 0) throw new SshTransportError(`remote ${phase} failed`, 'remote_failure');
    let receipt;
    try {
      const output = String(result.stdout ?? '').trim();
      receipt = JSON.parse(output);
    } catch {
      throw new SshTransportError(`remote ${phase} returned invalid receipt`, 'invalid_receipt');
    }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
      throw new SshTransportError(`remote ${phase} returned invalid receipt`, 'invalid_receipt');
    return receipt;
  }

  #timeoutFor(phase, context) {
    let timeoutMs = this.timeoutMs;
    if (DRAIN_PHASES.has(phase)) {
      const drainTimeoutMs = Number(context?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
      if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1000 || drainTimeoutMs > 3_600_000) {
        throw new SshTransportError('drain timeout is invalid', 'invalid_timeout');
      }
      timeoutMs = Math.max(timeoutMs, drainTimeoutMs + DRAIN_TIMEOUT_MARGIN_MS);
    }
    if (timeoutMs > MAX_SSH_TIMEOUT_MS)
      throw new SshTransportError('remote phase timeout exceeds the safety limit', 'invalid_timeout');
    return timeoutMs;
  }
}

export const createSshDeploymentTransport = (options) => new SshDeploymentTransport(options);
