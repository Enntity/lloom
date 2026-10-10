import { URL } from 'node:url';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const PROTOCOL = 1;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export class NodeGatewayAdapterError extends Error {
  constructor(message, code = 'gateway_adapter_failure') {
    super(message);
    this.name = 'NodeGatewayAdapterError';
    this.code = code;
  }
}

function publicValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

// Keep the historical adapter export independent of the gateway's richer
// preservation contract. The status endpoint includes volatile gateway-local
// fields; this compatibility view retains only owned runtime/process state.
function stablePreservationSnapshot(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const runtimes = {};
  const sourceRuntimes =
    source.runtimes && typeof source.runtimes === 'object' && !Array.isArray(source.runtimes) ? source.runtimes : {};
  for (const [runtimeId, runtime] of Object.entries(sourceRuntimes).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const entry = runtime && typeof runtime === 'object' && !Array.isArray(runtime) ? runtime : {};
    const stable = {};
    for (const key of ['status', 'healthy', 'pid', 'node', 'remote', 'distributed', 'containerName']) {
      if (entry[key] !== undefined) stable[key] = entry[key];
    }
    if (Array.isArray(entry.members)) {
      stable.members = entry.members
        .filter((member) => member && typeof member === 'object' && !Array.isArray(member))
        .map((member) => ({
          ...(member.runtime === undefined ? {} : { runtime: member.runtime }),
          ...(member.status === undefined ? {} : { status: member.status }),
          ...(member.healthy === undefined ? {} : { healthy: member.healthy })
        }));
    }
    if (entry.container && typeof entry.container === 'object' && !Array.isArray(entry.container)) {
      stable.container = {};
      for (const key of ['id', 'name', 'image', 'imageId', 'running', 'status']) {
        if (entry.container[key] !== undefined) stable.container[key] = entry.container[key];
      }
    }
    runtimes[runtimeId] = stable;
  }
  return { runtimes };
}

function identity(value, label) {
  const source = publicValue(value);
  if (!source) throw new NodeGatewayAdapterError(`${label} is unavailable`, 'identity_unknown');
  const required = [
    'releaseId',
    'artifactSha256',
    'manifestSha256',
    'configSha256',
    'effectiveConfigSha256',
    'dependencyDigest',
    'runtimeContractDigest'
  ];
  if (required.some((field) => typeof source[field] !== 'string' || !source[field]))
    throw new NodeGatewayAdapterError(`${label} is incomplete`, 'identity_incomplete');
  return Object.fromEntries(required.map((field) => [field, source[field]]));
}

function extractIdentity(...sources) {
  for (const source of sources) {
    const candidate = source?.releaseIdentity ?? source?.loadedIdentity ?? source?.identity?.releaseIdentity;
    if (candidate) return candidate;
  }
  return null;
}

// Preserve the historical adapter export while sharing the fence's stable
// preservation contract with the gateway endpoint.
export const stableRuntimeSnapshot = stablePreservationSnapshot;

function validatePreservationSnapshot(value, effectiveConfigSha256) {
  const source = publicValue(value);
  if (!source || source.schemaVersion !== 1 || source.effectiveConfigSha256 !== effectiveConfigSha256)
    throw new NodeGatewayAdapterError('gateway preservation snapshot is invalid', 'preservation_snapshot_invalid');
  const runtimes = publicValue(source.runtimes);
  if (!runtimes)
    throw new NodeGatewayAdapterError('gateway preservation runtimes are missing', 'preservation_snapshot_invalid');
  for (const runtime of Object.values(runtimes)) {
    if (!publicValue(runtime?.contract) || !publicValue(runtime?.observed))
      throw new NodeGatewayAdapterError(
        'gateway preservation runtime evidence is incomplete',
        'preservation_snapshot_invalid'
      );
    if (runtime.members !== undefined && !Array.isArray(runtime.members))
      throw new NodeGatewayAdapterError('gateway preservation members are invalid', 'preservation_snapshot_invalid');
  }
  return source;
}

function safeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new NodeGatewayAdapterError('gateway URL is invalid', 'invalid_gateway_url');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.protocol !== 'http:' || !LOOPBACK.has(hostname) || parsed.username || parsed.password)
    throw new NodeGatewayAdapterError(
      'node agent only accepts an authenticated loopback gateway',
      'unsupported_gateway_url'
    );
  return parsed.origin;
}

async function readCappedResponse(response) {
  const declaredLength = Number(response.headers?.get?.('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES)
    throw new NodeGatewayAdapterError('gateway response is too large', 'response_too_large');

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
      throw new NodeGatewayAdapterError('gateway response is too large', 'response_too_large');
    return text;
  }

  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value ?? '');
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel('response_too_large').catch(() => {});
        throw new NodeGatewayAdapterError('gateway response is too large', 'response_too_large');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class NodeGatewayAdapter {
  constructor({
    baseUrl = 'http://127.0.0.1:8100',
    adminApiKey,
    fetchFn = globalThis.fetch,
    timeoutMs = 30000,
    drainTimeoutMs = 300000
  } = {}) {
    this.baseUrl = safeBaseUrl(baseUrl);
    if (typeof adminApiKey !== 'string' || !adminApiKey)
      throw new NodeGatewayAdapterError('gateway admin key is required', 'admin_key_missing');
    if (typeof fetchFn !== 'function')
      throw new NodeGatewayAdapterError('fetch implementation is required', 'fetch_missing');
    this.adminApiKey = adminApiKey;
    this.fetch = fetchFn;
    this.timeoutMs = timeoutMs;
    this.drainTimeoutMs = drainTimeoutMs;
    this.fenceGenerations = new Map();
  }

  async inspect() {
    const fence = await this.#request('/gateway/deployment-fence/status');
    const gateway = await this.#request('/gateway/status');
    if (fence.protocol !== PROTOCOL && fence.fenceProtocolVersion !== PROTOCOL)
      throw new NodeGatewayAdapterError('gateway fence protocol is unsupported', 'fence_protocol_mismatch');
    if (fence.ok !== true || !['open', 'draining', 'prepared', 'canary'].includes(fence.state))
      throw new NodeGatewayAdapterError('gateway fence status is unavailable', 'fence_unavailable');
    const fenceIdentity = identity(extractIdentity(fence, fence.deploymentFence), 'gateway fence identity');
    const gatewayIdentity = identity(
      extractIdentity(gateway.node, gateway.deploymentFence, gateway),
      'gateway identity'
    );
    if (JSON.stringify(fenceIdentity) !== JSON.stringify(gatewayIdentity))
      throw new NodeGatewayAdapterError('gateway identities disagree', 'identity_drift');
    const serviceActive = gateway.serviceActive ?? gateway.runtimeManager?.serviceActive;
    if (serviceActive !== true) throw new NodeGatewayAdapterError('gateway service is inactive', 'service_inactive');
    const gatewayProtocol = gateway.gatewayProtocol ?? gateway.protocol;
    if (gatewayProtocol !== PROTOCOL)
      throw new NodeGatewayAdapterError('gateway protocol is unsupported', 'protocol_mismatch');
    const atomicLayout = gateway.atomicLayout === true || gateway.atomicLayout === 'atomic';
    if (!atomicLayout)
      throw new NodeGatewayAdapterError('gateway release layout is not atomic', 'atomic_layout_required');
    const rawRuntimeSnapshot = gateway.runtimeSnapshot ?? gateway.runtimeManager?.deploymentSnapshot;
    if (!rawRuntimeSnapshot || typeof rawRuntimeSnapshot !== 'object' || Array.isArray(rawRuntimeSnapshot))
      throw new NodeGatewayAdapterError('gateway runtime snapshot is unavailable', 'runtime_snapshot_missing');
    const runtimeSnapshot = stableRuntimeSnapshot(rawRuntimeSnapshot);
    const effectiveConfigSha256 =
      fence.effectiveConfigSha256 ?? gateway.effectiveConfigSha256 ?? fenceIdentity.effectiveConfigSha256;
    if (effectiveConfigSha256 !== fenceIdentity.effectiveConfigSha256)
      throw new NodeGatewayAdapterError('gateway effective config identity disagrees', 'config_identity_drift');
    const preservationSnapshot = validatePreservationSnapshot(gateway.preservationSnapshot, effectiveConfigSha256);
    return {
      gatewayProtocol,
      fenceProtocolVersion: PROTOCOL,
      atomicLayout,
      currentIdentity: fenceIdentity,
      loadedIdentity: gatewayIdentity,
      serviceActive: true,
      fenced: fence.fenced === true,
      drained: fence.state === 'prepared' || fence.state === 'canary',
      runtimeSnapshot,
      preservationSnapshot,
      effectiveConfigSha256
    };
  }

  async prepare(context) {
    const timeoutMs = Number(context?.drainTimeoutMs ?? this.drainTimeoutMs);
    const result = await this.#request(
      '/gateway/deployment-fence/prepare',
      {
        method: 'POST',
        body: { opId: context.operationId, timeoutMs }
      },
      Math.max(this.timeoutMs, timeoutMs + 5000)
    );
    this.#rememberGeneration(context.operationId, result);
    return this.#fenceReceipt(result, 'prepare');
  }

  async reprepare(context) {
    const timeoutMs = Number(context?.drainTimeoutMs ?? this.drainTimeoutMs);
    const result = await this.#request(
      '/gateway/deployment-fence/prepare',
      {
        method: 'POST',
        body: { opId: context.operationId, timeoutMs }
      },
      Math.max(this.timeoutMs, timeoutMs + 5000)
    );
    this.#rememberGeneration(context.operationId, result);
    return this.#fenceReceipt(result, 'reprepare');
  }

  async release(context) {
    const generation = await this.#fenceGeneration(context.operationId);
    const result = await this.#request('/gateway/deployment-fence/release', {
      method: 'POST',
      body: { opId: context.operationId, generation }
    });
    if (result.released !== true || result.fenced !== false)
      throw new NodeGatewayAdapterError('gateway did not affirm release', 'release_not_affirmed');
    return { released: true, fenced: false };
  }

  async canary(context) {
    const generation = await this.#fenceGeneration(context.operationId);
    const result = await this.#request('/gateway/deployment-fence/canary', {
      method: 'POST',
      body: {
        opId: context.operationId,
        generation,
        request: {
          model: context.canary?.gatewayModelId,
          messages: [{ role: 'user', content: 'deployment canary' }],
          max_tokens: 8,
          stream: false,
          metadata: { deploymentCanary: true, expectedRuntimeId: context.canary?.runtimeId }
        }
      }
    });
    const required = [
      'healthy',
      'fenced',
      'privileged',
      'aliasUsed',
      'cloudFallback',
      'source',
      'gatewayModelId',
      'runtimeId'
    ];
    if (
      required.some((field) => result[field] === undefined) ||
      result.healthy !== true ||
      result.fenced !== true ||
      result.privileged !== true ||
      result.aliasUsed !== false ||
      result.cloudFallback !== false ||
      result.source !== 'local' ||
      result.gatewayModelId !== context.canary?.gatewayModelId ||
      result.runtimeId !== context.canary?.runtimeId
    )
      throw new NodeGatewayAdapterError('gateway canary receipt is incomplete or mismatched', 'canary_receipt_invalid');
    return Object.fromEntries(required.map((field) => [field, result[field]]));
  }

  async #fenceGeneration(operationId) {
    const status = await this.#request('/gateway/deployment-fence/status');
    const record = status.operation;
    if (!record || record.opId !== operationId || !Number.isInteger(record.generation) || record.generation < 1)
      throw new NodeGatewayAdapterError('gateway fence generation is unknown', 'fence_generation_unknown');
    this.fenceGenerations.set(operationId, record.generation);
    return record.generation;
  }

  #rememberGeneration(operationId, result) {
    const generation = result.generation ?? result.operation?.generation;
    if (!Number.isInteger(generation) || generation < 1)
      throw new NodeGatewayAdapterError('gateway fence did not return a generation', 'fence_generation_unknown');
    this.fenceGenerations.set(operationId, generation);
  }

  #fenceReceipt(result, phase) {
    if (result.protocol !== undefined && result.protocol !== PROTOCOL)
      throw new NodeGatewayAdapterError(`${phase} returned an unsupported fence protocol`, 'fence_protocol_mismatch');
    if (result.fenced !== true || result.drained !== true || !['prepared', 'canary'].includes(result.state))
      throw new NodeGatewayAdapterError(`${phase} did not affirm a drained fence`, 'fence_not_ready');
    return { fenced: true, drained: true };
  }

  async #request(pathname, { method = 'GET', body } = {}, requestTimeoutMs = this.timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await this.fetch(`${this.baseUrl}${pathname}`, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.adminApiKey}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const text = await readCappedResponse(response);
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        /* sanitized below */
      }
      if (!response.ok || !payload || typeof payload !== 'object')
        throw new NodeGatewayAdapterError(
          'gateway request failed',
          response.status >= 500 ? 'gateway_unavailable' : 'gateway_rejected'
        );
      return payload;
    } catch (error) {
      if (error instanceof NodeGatewayAdapterError) throw error;
      throw new NodeGatewayAdapterError(
        'gateway request failed',
        error?.name === 'AbortError' ? 'timeout' : 'gateway_unavailable'
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export const createNodeGatewayAdapter = (options) => new NodeGatewayAdapter(options);
