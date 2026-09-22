/**
 * OpenRouter provider-preference policy.
 *
 * OpenRouter routes each chat completion across multiple upstream providers and
 * accepts a `provider` object on the request body. That object lets a caller
 * constrain routing. LLooM exposes an operator-owned policy at
 * `backends.<id>.openrouterProvider` so a configured lane always routes the way
 * the operator intends.
 *
 * The policy is deliberately narrow:
 *
 *   { "openrouterProvider": { "only": ["z-ai"], "allow_fallbacks": false } }
 *
 * - `only` is required, non-empty, and every entry must be a non-empty string.
 * - `allow_fallbacks` is optional and must be a boolean.
 * - Any other key is rejected so the operator cannot believe a setting took
 *   effect when the gateway did not enforce it.
 *
 * Enforcement is fail-closed. A malformed policy on an OpenRouter backend
 * throws instead of silently sending an unconstrained request. Non-OpenRouter
 * backends and backends without a policy leave the body untouched.
 */

const POLICY_KEY = 'openrouterProvider';
const ALLOWED_KEYS = new Set(['only', 'allow_fallbacks']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True only for the real OpenRouter API host, never a lookalike name. */
export function isOpenRouterBackend(backend = {}) {
  const baseUrl = backend?.baseUrl;
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return false;
  try {
    return new URL(baseUrl).hostname === 'openrouter.ai';
  } catch {
    return false;
  }
}

/**
 * Validate the configured policy. Returns the normalized policy, `null` when no
 * policy is configured, and throws for any malformed configuration.
 */
export function normalizeOpenRouterProviderPolicy(configured, { backendId } = {}) {
  if (configured === undefined || configured === null) return null;
  const where = backendId ? `backends.${backendId}.${POLICY_KEY}` : POLICY_KEY;
  if (!isPlainObject(configured)) {
    throw new Error(`${where} must be an object`);
  }
  for (const key of Object.keys(configured)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`${where} has unsupported key "${key}"; allowed keys are only, allow_fallbacks`);
    }
  }
  if (!Object.hasOwn(configured, 'only')) {
    throw new Error(`${where}.only is required`);
  }
  if (!Array.isArray(configured.only)) {
    throw new Error(`${where}.only must be an array of provider slugs`);
  }
  if (configured.only.length === 0) {
    throw new Error(`${where}.only must not be empty`);
  }
  const only = configured.only.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error(`${where}.only entries must be non-empty strings`);
    }
    return entry.trim();
  });
  if (Object.hasOwn(configured, 'allow_fallbacks') && typeof configured.allow_fallbacks !== 'boolean') {
    throw new Error(`${where}.allow_fallbacks must be a boolean`);
  }
  return {
    only,
    // Fail closed: an operator who constrains `only` almost never wants
    // OpenRouter to silently substitute a different provider.
    allow_fallbacks: configured.allow_fallbacks ?? false
  };
}

/**
 * Apply the OpenRouter provider policy to an outbound chat-completions body.
 *
 * Configured values win over caller-supplied `provider` fields while every
 * other caller field is preserved. Bodies that are not plain objects, backends
 * on another host, and backends without a policy are returned unchanged.
 */
export function applyOpenRouterProviderPolicy(body, backend = {}) {
  if (!isPlainObject(body)) return body;
  // Only the real OpenRouter host is ever treated as OpenRouter. Every other
  // backend, including lookalike hostnames, is left exactly as the caller sent
  // it and never has a policy applied to it.
  if (!isOpenRouterBackend(backend)) return body;
  const policy = normalizeOpenRouterProviderPolicy(backend?.[POLICY_KEY], { backendId: backend?.id });
  if (!policy) return body;
  const callerProvider = isPlainObject(body.provider) ? body.provider : {};
  return {
    ...body,
    provider: { ...callerProvider, only: [...policy.only], allow_fallbacks: policy.allow_fallbacks }
  };
}
