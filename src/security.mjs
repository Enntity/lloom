/**
 * Local gateway auth and admin perimeter.
 *
 * Loopback binds keep the local-first DX (optional auth when allowMissingAuth).
 * Non-loopback binds always require API keys, and admin writes are denied unless
 * security.allowRemoteAdmin is explicitly true.
 *
 * When security.adminApiKeys is non-empty, admin-read and admin-write require one
 * of those keys even on loopback (inference may still allow missing auth).
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']);

export function isLoopbackAddress(host) {
  if (host == null || host === '') return false;
  let value = String(host).trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  value = value.split('%')[0];
  if (value.includes(':') && !value.includes('::') && value.split(':').length === 2) {
    const [maybeHost] = value.split(':');
    if (LOOPBACK_HOSTS.has(maybeHost) || maybeHost === '127.0.0.1') return true;
  }
  if (LOOPBACK_HOSTS.has(value)) return true;
  if (value.startsWith('127.')) return true;
  return false;
}

export function extractApiKey(req) {
  const bearer = String(req.headers?.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  const xApiKey = req.headers?.['x-api-key'];
  if (xApiKey == null || xApiKey === '') return null;
  return Array.isArray(xApiKey) ? xApiKey[0] : String(xApiKey);
}

function keySet(keys) {
  return new Set((keys ?? []).filter(Boolean));
}

export function hasValidApiKey(req, config, { admin = false } = {}) {
  const adminKeys = keySet(config.security?.adminApiKeys);
  const inferenceKeys = keySet(config.security?.apiKeys);
  const configured = admin
    ? adminKeys.size
      ? adminKeys
      : inferenceKeys
    : inferenceKeys.size
      ? inferenceKeys
      : adminKeys;
  if (!configured.size) return false;
  const key = extractApiKey(req);
  return key != null && configured.has(key);
}

export function adminKeysConfigured(config) {
  return keySet(config.security?.adminApiKeys).size > 0;
}

/**
 * @param {string} method
 * @param {string} pathname
 * @returns {'public' | 'inference' | 'admin-read' | 'admin-write'}
 */
export function classifyRoute(method, pathname) {
  const verb = String(method ?? 'GET').toUpperCase();
  const path = String(pathname ?? '/');
  if (verb === 'OPTIONS') return 'public';
  if (
    verb === 'GET' &&
    (path === '/health' || path === '/' || path === '/gateway/dashboard' || path === '/gateway/security')
  ) {
    return 'public';
  }
  if (path.startsWith('/gateway/')) {
    return verb === 'POST' ? 'admin-write' : 'admin-read';
  }
  return 'inference';
}

export function authorizeRequest(req, config, { method, pathname } = {}) {
  const effectiveMethod = String(method ?? req.method ?? 'GET').toUpperCase();
  const effectivePath = pathname ?? '/';
  const publicTelemetry =
    config.security?.publicTelemetry === true &&
    effectiveMethod === 'GET' &&
    ['/gateway/status', '/gateway/metrics'].includes(effectivePath);
  const routeKind = publicTelemetry ? 'public' : classifyRoute(effectiveMethod, effectivePath);
  const bindHost = config.server?.host ?? '127.0.0.1';
  const loopbackBind = isLoopbackAddress(bindHost);
  const allowMissing = config.security?.allowMissingAuth === true;
  const allowRemoteAdmin = config.security?.allowRemoteAdmin === true;
  const adminRequired = adminKeysConfigured(config);
  const validInferenceKey = hasValidApiKey(req, config, { admin: false });
  const validAdminKey = hasValidApiKey(req, config, { admin: true });

  if (routeKind === 'public') {
    return { ok: true, routeKind };
  }

  const isAdminRoute = routeKind === 'admin-write' || routeKind === 'admin-read';

  if (!loopbackBind) {
    if (routeKind === 'admin-write' && !allowRemoteAdmin) {
      return {
        ok: false,
        status: 403,
        code: 'remote_admin_disabled',
        routeKind,
        message:
          'Admin write endpoints are disabled on non-loopback binds. Bind to 127.0.0.1 or set security.allowRemoteAdmin=true with API keys.'
      };
    }
    if (isAdminRoute) {
      if (!validAdminKey) {
        return {
          ok: false,
          status: 401,
          code: 'unauthorized',
          routeKind,
          message: 'missing or invalid authorization token'
        };
      }
      return { ok: true, routeKind };
    }
    if (!validInferenceKey && !validAdminKey) {
      return {
        ok: false,
        status: 401,
        code: 'unauthorized',
        routeKind,
        message: 'missing or invalid authorization token'
      };
    }
    return { ok: true, routeKind };
  }

  // Loopback admin routes: if adminApiKeys configured, require them even when allowMissingAuth.
  if (isAdminRoute && adminRequired) {
    if (!validAdminKey) {
      return {
        ok: false,
        status: 401,
        code: 'unauthorized',
        routeKind,
        message: 'missing or invalid admin authorization token'
      };
    }
    return { ok: true, routeKind };
  }

  if (allowMissing || validInferenceKey || validAdminKey) {
    return { ok: true, routeKind };
  }

  return {
    ok: false,
    status: 401,
    code: 'unauthorized',
    routeKind,
    message: 'missing or invalid authorization token'
  };
}

/** @deprecated Prefer authorizeRequest — kept for simple key checks. */
export function hasAuth(req, config) {
  return authorizeRequest(req, config, {
    method: req.method,
    pathname: '/v1/models'
  }).ok;
}

export function corsHeaders(config = {}) {
  const bindHost = config.server?.host ?? '127.0.0.1';
  const loopbackBind = isLoopbackAddress(bindHost);
  const origin = loopbackBind || config.security?.allowWildcardCors === true ? '*' : 'null';
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-api-key'
  };
}

/** Public metadata for dashboards (no secrets). */
export function securityPublicStatus(config = {}) {
  const bindHost = config.server?.host ?? '127.0.0.1';
  const loopback = isLoopbackAddress(bindHost);
  const allowMissing = config.security?.allowMissingAuth === true;
  const adminRequired = adminKeysConfigured(config);
  const hasInferenceKeys = keySet(config.security?.apiKeys).size > 0;
  return {
    loopback,
    bindHost,
    allowMissingAuth: allowMissing,
    allowRemoteAdmin: config.security?.allowRemoteAdmin === true,
    allowNonLoopbackBind: config.security?.allowNonLoopbackBind === true,
    authRequired: !loopback || !allowMissing,
    adminAuthRequired: adminRequired || !loopback,
    inferenceKeysConfigured: hasInferenceKeys,
    adminKeysConfigured: adminRequired,
    publicTelemetry: config.security?.publicTelemetry === true
  };
}

export function assertBindAllowed(config, { logger } = {}) {
  const host = config.server?.host ?? '127.0.0.1';
  if (isLoopbackAddress(host)) return { ok: true, host };
  if (config.security?.allowNonLoopbackBind === true) {
    logger?.warn?.(
      `LLooM is binding to non-loopback host ${host}. API keys are required; admin writes need allowRemoteAdmin.`
    );
    return { ok: true, host, warned: true };
  }
  return {
    ok: false,
    host,
    message: `Refusing to bind to non-loopback host ${host}. Use 127.0.0.1 or set security.allowNonLoopbackBind=true.`
  };
}
