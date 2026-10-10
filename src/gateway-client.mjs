import { Agent as UndiciAgent, fetch as undiciFetch } from 'undici';
import { resolveManagedEnvironmentValue } from './managed-environment.mjs';
import { readErrorDiagnostic } from './protocol/upstream-error.mjs';

/**
 * Shared gateway request helper for the CLI and diagnostics.
 *
 * The CLI must never pretend an authenticated gateway is unreachable. Every
 * failure is normalised into a typed {@link LLooMGatewayError} that keeps the
 * HTTP status, a stable LLooM error code, and a `kind` that distinguishes
 * authentication, authorization, connection refusal, timeout, and server
 * errors. Upstream bodies are hostile input: they may echo the credential we
 * sent, so arbitrary upstream text is never surfaced and every configured
 * credential value is redacted defensively.
 */

export const GATEWAY_ERROR_CODES = Object.freeze({
  AUTH_FAILED: 'gateway_auth_failed',
  FORBIDDEN: 'gateway_forbidden',
  CONNECTION_REFUSED: 'gateway_connection_refused',
  TIMEOUT: 'gateway_timeout',
  SERVER_ERROR: 'gateway_server_error',
  HTTP_ERROR: 'gateway_http_error',
  UNREACHABLE: 'gateway_unreachable'
});

const DEFAULT_ADMIN_KEY_ENV = 'LLOOM_ADMIN_API_KEY';
const MAX_GATEWAY_ERROR_BODY_BYTES = 16 * 1024;

function createAbortError() {
  if (typeof globalThis.DOMException === 'function') {
    return new globalThis.DOMException('This operation was aborted', 'AbortError');
  }
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** Collect raw configured credential values we may need to redact. */
function rawCredentialValues(config, env) {
  const raw = [];
  const credentialField = (key) =>
    /(?:api[_-]?key|token|secret|password|credential)/i.test(String(key)) && !/env$/i.test(String(key));
  const visit = (value, key = '') => {
    if (Array.isArray(value)) {
      if (credentialField(key)) raw.push(...value);
      else value.forEach((entry) => visit(entry, key));
      return;
    }
    if (!value || typeof value !== 'object') {
      if (credentialField(key)) raw.push(value);
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
  };
  visit(config);
  const values = new Set();
  for (const value of raw) {
    if (typeof value !== 'string' || value.length === 0) continue;
    values.add(value);
    const resolved = resolveManagedEnvironmentValue(value, env);
    if (typeof resolved === 'string' && resolved.length > 0) values.add(resolved);
  }
  return [...values];
}

/** Remove every configured credential value (and `${NAME}` placeholders) from text. */
export function redactGatewaySecrets(text, { config, env = process.env, extraValues = [] } = {}) {
  const effectiveEnv = env ?? {};
  let output = typeof text === 'string' ? text : String(text ?? '');
  const values = [
    ...new Set([...extraValues, effectiveEnv[DEFAULT_ADMIN_KEY_ENV], ...rawCredentialValues(config, effectiveEnv)])
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    output = output.split(value).join('[redacted]');
  }
  output = output.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, '[redacted-credential]');
  return output;
}

function redactDiagnosticValue(value, options) {
  if (typeof value === 'string') return redactGatewaySecrets(value, options);
  if (Array.isArray(value)) return value.map((entry) => redactDiagnosticValue(entry, options));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDiagnosticValue(entry, options)]));
}

/**
 * Return the stable, JSON-safe gateway diagnostic fields.
 *
 * Only the fields documented by the CLI envelope are projected. Every string
 * in that projection is redacted, including codes and kinds if a configured
 * credential happens to collide with one of them.
 */
export function safeGatewayDiagnostic(error, { config, env = process.env, extraValues = [] } = {}) {
  const diagnostic = {
    code: error?.code ?? 'cli_error',
    kind: error?.kind ?? null,
    ...(error?.upstreamCode ? { upstreamCode: error.upstreamCode } : {}),
    status: Number.isInteger(error?.status) ? error.status : null,
    message: typeof error?.message === 'string' ? error.message : String(error?.message ?? error)
  };
  return redactDiagnosticValue(diagnostic, { config, env, extraValues });
}

export class LLooMGatewayError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LLooMGatewayError';
    this.kind = options.kind ?? 'server';
    this.code = options.code ?? GATEWAY_ERROR_CODES.UNREACHABLE;
    if (Number.isInteger(options.status)) this.status = options.status;
    if (options.sslOnly !== undefined) this.sslOnly = options.sslOnly;
    if (options.upstreamCode !== undefined) this.upstreamCode = options.upstreamCode;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** A safe, fixed human sentence for a gateway failure. Never contains upstream text. */
export function gatewayErrorMessage(error) {
  const status = error?.status;
  switch (error?.kind) {
    case 'auth':
      return status === 401
        ? 'gateway rejected the request: 401 unauthorized; check the configured admin credential (missing or invalid)'
        : `gateway rejected the request: HTTP ${status ?? 401}; check the configured admin credential`;
    case 'authorization':
      return `gateway rejected the request: HTTP ${status ?? 403} forbidden; the configured credential is not authorized for this admin route`;
    case 'refused':
      return 'gateway refused the connection; no gateway is listening on the configured address';
    case 'timeout':
      return 'gateway request timed out before the gateway answered';
    case 'http':
      return `gateway rejected the request: HTTP ${status ?? 400}`;
    case 'server':
      return `gateway returned HTTP ${status ?? 500} (server error)`;
    default:
      return 'gateway is unreachable';
  }
}

function classifyStatus(status) {
  if (status === 401) return { kind: 'auth', code: GATEWAY_ERROR_CODES.AUTH_FAILED };
  if (status === 403) return { kind: 'authorization', code: GATEWAY_ERROR_CODES.FORBIDDEN };
  if (status >= 500) return { kind: 'server', code: GATEWAY_ERROR_CODES.SERVER_ERROR };
  return { kind: 'http', code: GATEWAY_ERROR_CODES.HTTP_ERROR };
}

/**
 * Walk the error/cause chain collecting names, codes, and messages.
 *
 * Undici reports socket failures as a `TypeError: fetch failed` whose real
 * transport error (`ECONNREFUSED`, `UND_ERR_HEADERS_TIMEOUT`, ...) lives on
 * `.cause`, sometimes several levels deep, so a flat inspection would
 * misclassify a refused connection as merely unreachable.
 */
function transportErrorSignals(error) {
  const names = [];
  const codes = [];
  const messages = [];
  let node = error;
  for (let depth = 0; node && depth < 8; depth += 1) {
    if (node.name) names.push(String(node.name));
    if (node.code) codes.push(String(node.code));
    if (node.message) messages.push(String(node.message));
    if (node.errno) codes.push(String(node.errno));
    node = node.cause;
  }
  messages.push(String(error ?? ''));
  return { names, codes, messages };
}

function classifyTransportError(error, { timedOut }) {
  const { names, codes, messages } = transportErrorSignals(error);
  const text = messages.join(' ');
  const isTimeoutCode = codes.some((code) =>
    ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(code)
  );
  if (
    timedOut ||
    names.includes('AbortError') ||
    names.includes('TimeoutError') ||
    isTimeoutCode ||
    /timed out|timeout/i.test(text)
  ) {
    return { kind: 'timeout', code: GATEWAY_ERROR_CODES.TIMEOUT };
  }
  if (codes.includes('ECONNREFUSED') || /ECONNREFUSED/.test(text)) {
    return { kind: 'refused', code: GATEWAY_ERROR_CODES.CONNECTION_REFUSED };
  }
  return { kind: 'unreachable', code: GATEWAY_ERROR_CODES.UNREACHABLE };
}

/**
 * Perform a gateway request.
 *
 * @param {object} config LLooM config (server host/port + security credentials).
 * @param {string} url absolute URL or pathname relative to the gateway base URL.
 * @param {object} [options]
 */
export async function gatewayRequest(
  config,
  url,
  {
    method = 'GET',
    body,
    timeoutMs = 2000,
    throwOnError = true,
    fallbackOnRefused = false,
    urlFor = null,
    headers = {},
    fetchImpl = undiciFetch,
    env = process.env,
    explicitEnvName
  } = {}
) {
  const target = /^https?:\/\//i.test(url) ? url : `${(urlFor ?? (() => gatewayBaseUrl(config)))(config)}${url}`;
  const adminKey = resolveAdminCredential(config, { explicitEnvName, env });

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(createAbortError());
  }, timeoutMs);
  // Node's built-in fetch otherwise inherits Undici's roughly five-minute
  // response-header timeout, which is shorter than a cold multi-node model
  // start. Keep the transport timeout aligned with LLooM's explicit request
  // timeout while the AbortSignal remains the per-call deadline.
  const dispatcher = new UndiciAgent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  try {
    const response = await fetchImpl(target, {
      method,
      headers: {
        ...(adminKey ? { authorization: `Bearer ${adminKey}` } : {}),
        ...(body == null ? {} : { 'content-type': 'application/json' }),
        ...headers
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
      dispatcher
    });
    if (!response.ok) {
      // Read (and discard) the body so the connection can be reused; never
      // surface upstream text because it may echo the credential.
      const rawDetail = response.body?.getReader
        ? await readErrorDiagnostic(response, {
            timeoutMs: Math.min(timeoutMs, 1000),
            maxBytes: MAX_GATEWAY_ERROR_BODY_BYTES
          })
        : '';
      let detail = null;
      try {
        detail = JSON.parse(rawDetail);
      } catch {
        // A malformed or over-sized diagnostic body cannot change the HTTP
        // classification that was already established from the response.
      }
      const status = response.status;
      const { kind, code } = classifyStatus(status);
      const allowedCodes = new Set([
        'missing_api_key',
        'invalid_api_key',
        'unauthorized',
        'forbidden',
        'remote_admin_disabled',
        'admin_key_required',
        'worker_control_plane_only',
        'standby_read_only',
        'deployment_in_progress',
        'runtime_authority_required',
        'RUNTIME_RECONFIGURING',
        'RUNTIME_ADMISSION_BUSY'
      ]);
      const upstreamCode = allowedCodes.has(detail?.error?.code) ? detail.error.code : undefined;
      throw new LLooMGatewayError(gatewayErrorMessage({ kind, status }), { kind, code, status, upstreamCode });
    }
    return await response.json();
  } catch (error) {
    if (error instanceof LLooMGatewayError) {
      if (fallbackOnRefused && error.kind === 'refused') return null;
      if (throwOnError) throw error;
      return null;
    }
    const { kind, code } = classifyTransportError(error, { timedOut });
    const wrapped = new LLooMGatewayError(gatewayErrorMessage({ kind }), { kind, code, cause: error });
    // Local fallback is permitted ONLY for an actual connection refusal.
    if (fallbackOnRefused && kind === 'refused') return null;
    if (throwOnError) throw wrapped;
    return null;
  } finally {
    clearTimeout(timer);
    await dispatcher.close().catch(() => undefined);
  }
}

/** Gateway base URL resolved exactly the way CLI diagnostics expect. */
export function gatewayBaseUrl(config) {
  const configuredHost = config?.server?.host ?? '127.0.0.1';
  const host = ['0.0.0.0', '::', '[::]'].includes(configuredHost) ? '127.0.0.1' : configuredHost;
  const port = config?.server?.port ?? 8100;
  const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${address}:${port}`;
}

/**
 * Explicit environment-backed admin credential resolution.
 *
 * Service-managed installs store the admin key in an environment variable.
 * Callers may select the variable explicitly (`--admin-api-key-env`); otherwise
 * the documented default is used. Credentials are never accepted through argv.
 */
export function resolveAdminCredential(config, { explicitEnvName, env = process.env } = {}) {
  if (explicitEnvName !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(explicitEnvName)) {
      throw new Error('--admin-api-key-env requires a valid environment variable name');
    }
    const value = env[explicitEnvName];
    if (typeof value !== 'string' || !value)
      throw new Error('Selected admin credential environment variable is empty or unset');
    return value;
  }
  if (typeof env[DEFAULT_ADMIN_KEY_ENV] === 'string' && env[DEFAULT_ADMIN_KEY_ENV]) return env[DEFAULT_ADMIN_KEY_ENV];
  const admins = config?.security?.adminApiKeys ?? [];
  const candidates = admins.length ? admins : (config?.security?.apiKeys ?? []);
  return candidates
    .map((value) => resolveManagedEnvironmentValue(value, env))
    .find((value) => typeof value === 'string' && value.length > 0 && !/^\$\{[^}]+\}$/.test(value));
}

/** The option selects an environment variable name, never a literal key. */
export function adminApiKeyEnvFromArgs(args = []) {
  const index = args.indexOf('--admin-api-key-env');
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error('--admin-api-key-env requires a valid environment variable name');
  }
  return value;
}
