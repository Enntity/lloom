import { isLoopbackAddress } from './security.mjs';

export const STANDBY_ROLES = new Set(['primary', 'standby']);

export function normalizeServerRole(config) {
  const role = config?.server?.role ?? 'primary';
  return STANDBY_ROLES.has(role) ? role : 'primary';
}

export function isStandby(config) {
  return config?.server?.role === 'standby';
}

function privateUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return `${label} must be an absolute HTTP(S) URL`;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return `${label} must use HTTP or HTTPS`;
  if (parsed.username || parsed.password) return `${label} must not contain credentials`;
  if (parsed.hash) return `${label} must not contain a URL fragment`;
  const host = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0];
  const ip4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  const validIp4 = ip4 && ip4.slice(1).every((octet) => Number(octet) <= 255);
  const isPrivateIp4 =
    validIp4 &&
    ((Number(ip4[1]) === 10 && Number(ip4[2]) <= 255) ||
      (Number(ip4[1]) === 172 && Number(ip4[2]) >= 16 && Number(ip4[2]) <= 31) ||
      (Number(ip4[1]) === 192 && Number(ip4[2]) === 168) ||
      (Number(ip4[1]) === 100 && Number(ip4[2]) >= 64 && Number(ip4[2]) <= 127));
  const isPrivateIp6 = /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host) || host === '::1';
  if (!isLoopbackAddress(host) && !isPrivateIp4 && !isPrivateIp6) {
    return `${label} must be loopback or private`;
  }
  if (parsed.pathname.includes('/gateway/')) {
    return `${label} must not use the LLooM management gateway contract`;
  }
  return null;
}

export function collectStandbyConfigErrors(config) {
  const errors = [];
  const configuredRole = config?.server?.role;
  if (configuredRole != null && !STANDBY_ROLES.has(configuredRole)) {
    errors.push('server.role must be either primary or standby');
  }
  if (!isStandby(config)) return errors;
  if (Object.keys(config.runtimes ?? {}).length) {
    errors.push('standby server.role forbids runtimes, including disabled or external runtimes');
  }
  if (Object.keys(config.cluster?.nodes ?? {}).length) {
    errors.push('standby server.role forbids cluster.nodes');
  }
  if (Object.keys(config.providers ?? {}).length) {
    errors.push('standby server.role forbids providers');
  }
  if (config.web != null && Object.keys(config.web).length) {
    errors.push('standby server.role forbids web functions');
  }
  for (const [index, model] of (config.models ?? []).entries()) {
    const id = model?.id ?? `models[${index}]`;
    if (model?.runtime) errors.push(`standby model ${id} forbids a runtime reference`);
    if (model?.node) errors.push(`standby model ${id} forbids a node reference`);
    if (model?.remoteRuntime) errors.push(`standby model ${id} forbids a remoteRuntime reference`);
    if (model?.targets != null) errors.push(`standby model ${id} forbids targets`);
    if (!model?.backend) {
      errors.push(`standby model ${id} must reference an explicit backend`);
      continue;
    }
    const backend = config.backends?.[model.backend];
    if (!backend) {
      errors.push(`standby model ${id} references unknown backend ${model.backend}`);
      continue;
    }
    if (backend.type !== 'openai') {
      errors.push(`standby backend ${model.backend} must be type openai`);
    }
    if (backend.audioProvider || backend.videoProvider) {
      errors.push(`standby backend ${model.backend} must use its private OpenAI-compatible endpoint directly`);
    }
    if (!backend.baseUrl) errors.push(`standby backend ${model.backend} requires baseUrl`);
    const baseUrlError = backend.baseUrl
      ? privateUrl(backend.baseUrl, `standby backend ${model.backend} baseUrl`)
      : null;
    if (baseUrlError) errors.push(baseUrlError);
    if (!backend.healthUrl) {
      errors.push(`standby backend ${model.backend} requires an explicit healthUrl`);
    } else {
      const healthUrlError = privateUrl(backend.healthUrl, `standby backend ${model.backend} healthUrl`);
      if (healthUrlError) errors.push(healthUrlError);
    }
    if (!model.upstreamModel) errors.push(`standby model ${id} requires an explicit upstreamModel`);
  }
  return errors;
}

export function assertStandbyConfig(config) {
  const errors = collectStandbyConfigErrors(config);
  if (errors.length) throw new Error(`Invalid LLooM standby config: ${errors.join('; ')}`);
}

const readinessByConfig = new WeakMap();
const READINESS_TTL_MS = 15_000;

function endpointKey(resolved) {
  return `${resolved?.model?.id ?? ''}\u0000${resolved?.model?.upstreamModel ?? ''}\u0000${resolved?.backend?.baseUrl ?? ''}`;
}

function setEndpointReadiness(config, resolved, ready) {
  if (!config || typeof config !== 'object') return;
  let entries = readinessByConfig.get(config);
  if (!entries) {
    entries = new Map();
    readinessByConfig.set(config, entries);
  }
  entries.set(endpointKey(resolved), { ready, checkedAt: Date.now() });
}

export function standbyGatewayStatus(config) {
  const standby = isStandby(config);
  const endpointCount = standby ? (config.models ?? []).length : 0;
  const readiness = standby ? [...(readinessByConfig.get(config)?.values() ?? [])] : [];
  const now = Date.now();
  const readyEndpointCount = readiness.filter(
    (entry) => entry.ready === true && now - entry.checkedAt <= READINESS_TTL_MS
  ).length;
  const lastProbeAt = readiness.reduce((latest, entry) => (entry.checkedAt > latest ? entry.checkedAt : latest), 0);
  return {
    role: normalizeServerRole(config),
    lifecycleAuthority: standby ? 'none' : 'primary',
    inferenceReady: standby ? readyEndpointCount > 0 : true,
    endpointCount,
    readyEndpointCount,
    lastProbeAt: lastProbeAt ? new Date(lastProbeAt).toISOString() : null,
    configFrozen: standby,
    endpointContract: {
      mode: 'ordered-authenticated-gateway-endpoints',
      retry: 'new-requests-only',
      streamMigration: false
    }
  };
}

function healthHeaders(backend, env = process.env) {
  const apiKey = backend.apiKeyEnv ? env[backend.apiKeyEnv] : backend.apiKey;
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

async function readBoundedResponse(response, maxBytes) {
  if (!response.body?.getReader) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
      const remaining = maxBytes - bytes;
      const part = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      bytes += part.byteLength;
      text += decoder.decode(part, { stream: true });
      if (part.byteLength < chunk.byteLength) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text: text + decoder.decode(), truncated };
}

function healthFailure(status) {
  return unavailable(`standby endpoint health check failed with status ${status}`);
}

export async function standbyEndpointGate(config, resolved, { timeoutMs = 5000, env = process.env } = {}) {
  if (!isStandby(config)) return null;
  if (collectStandbyConfigErrors(config).length) {
    setEndpointReadiness(config, resolved, false);
    return unavailable('standby configuration is invalid');
  }
  const backend = resolved.backend;
  const model = resolved.model;
  if (!backend?.healthUrl || !backend.baseUrl || !model?.upstreamModel) {
    setEndpointReadiness(config, resolved, false);
    return {
      status: 503,
      body: {
        error: {
          message: 'standby endpoint is not completely configured',
          type: 'service_unavailable',
          code: 'standby_backend_unavailable'
        }
      }
    };
  }
  if (backend.apiKeyEnv && !env[backend.apiKeyEnv]) {
    setEndpointReadiness(config, resolved, false);
    return unavailable('standby backend credential is not configured');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = healthHeaders(backend, env);
    const health = await fetch(backend.healthUrl, {
      signal: controller.signal,
      // A health URL may be a separate local probe endpoint. Never send the
      // backend credential to that unrelated origin; /models stays on the
      // authenticated base URL below.
      headers: sameOrigin(backend.healthUrl, backend.baseUrl) ? headers : {},
      redirect: 'error'
    });
    if (!health.ok) {
      await readBoundedResponse(health, 1024);
      setEndpointReadiness(config, resolved, false);
      return healthFailure(health.status);
    }
    await readBoundedResponse(health, 1024);
    const models = await fetch(`${String(backend.baseUrl).replace(/\/$/, '')}/models`, {
      signal: controller.signal,
      headers,
      redirect: 'error'
    });
    if (!models.ok) {
      await readBoundedResponse(models, 1024);
      setEndpointReadiness(config, resolved, false);
      return unavailable(`standby model identity check failed with status ${models.status}`);
    }
    const body = await readBoundedResponse(models, 64 * 1024);
    if (body.truncated) {
      setEndpointReadiness(config, resolved, false);
      return unavailable('standby model identity response exceeded the safety limit');
    }
    const catalog = JSON.parse(body.text || 'null');
    const ids = new Set(Array.isArray(catalog?.data) ? catalog.data.map((entry) => entry?.id).filter(Boolean) : []);
    if (!ids.has(model.upstreamModel)) {
      setEndpointReadiness(config, resolved, false);
      return {
        status: 503,
        body: {
          error: {
            message: `standby endpoint does not advertise model ${model.upstreamModel}`,
            type: 'service_unavailable',
            code: 'standby_model_mismatch'
          }
        }
      };
    }
    setEndpointReadiness(config, resolved, true);
    return null;
  } catch {
    setEndpointReadiness(config, resolved, false);
    return unavailable('standby endpoint health or model identity check failed');
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(message) {
  return {
    status: 503,
    body: {
      error: {
        message,
        type: 'service_unavailable',
        code: 'standby_backend_unavailable'
      }
    }
  };
}
