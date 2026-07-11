import assert from 'node:assert/strict';
import {
  assertBindAllowed,
  authorizeRequest,
  classifyRoute,
  corsHeaders,
  hasValidApiKey,
  isLoopbackAddress,
  securityPublicStatus
} from '../src/security.mjs';

assert.equal(isLoopbackAddress('127.0.0.1'), true);
assert.equal(isLoopbackAddress('::1'), true);
assert.equal(isLoopbackAddress('localhost'), true);
assert.equal(isLoopbackAddress('0.0.0.0'), false);
assert.equal(isLoopbackAddress('192.168.1.10'), false);

assert.equal(classifyRoute('GET', '/health'), 'public');
assert.equal(classifyRoute('GET', '/'), 'public');
assert.equal(classifyRoute('OPTIONS', '/v1/chat/completions'), 'public');
assert.equal(classifyRoute('GET', '/gateway/status'), 'admin-read');
assert.equal(classifyRoute('POST', '/gateway/setup/apply'), 'admin-write');
assert.equal(classifyRoute('POST', '/v1/chat/completions'), 'inference');

const loopbackConfig = {
  server: { host: '127.0.0.1', port: 8100 },
  security: {
    allowMissingAuth: true,
    allowRemoteAdmin: false,
    apiKeys: ['sk-lloom-local']
  }
};

assert.equal(
  authorizeRequest({ headers: {} }, loopbackConfig, {
    method: 'POST',
    pathname: '/v1/chat/completions'
  }).ok,
  true
);
assert.equal(
  authorizeRequest({ headers: {} }, loopbackConfig, {
    method: 'POST',
    pathname: '/gateway/setup/apply'
  }).ok,
  true
);

const lockedLoopback = {
  ...loopbackConfig,
  security: { ...loopbackConfig.security, allowMissingAuth: false }
};
assert.equal(
  authorizeRequest({ headers: {} }, lockedLoopback, {
    method: 'GET',
    pathname: '/v1/models'
  }).ok,
  false
);
assert.equal(
  authorizeRequest({ headers: { authorization: 'Bearer sk-lloom-local' } }, lockedLoopback, {
    method: 'GET',
    pathname: '/v1/models'
  }).ok,
  true
);
assert.equal(
  authorizeRequest({ headers: {} }, lockedLoopback, {
    method: 'GET',
    pathname: '/health'
  }).ok,
  true
);

const remoteConfig = {
  server: { host: '0.0.0.0', port: 8100 },
  security: {
    allowMissingAuth: true,
    allowRemoteAdmin: false,
    apiKeys: ['sk-lloom-local']
  }
};

const remoteWrite = authorizeRequest({ headers: {} }, remoteConfig, {
  method: 'POST',
  pathname: '/gateway/onboarding/apply'
});
assert.equal(remoteWrite.ok, false);
assert.equal(remoteWrite.status, 403);
assert.equal(remoteWrite.code, 'remote_admin_disabled');

const remoteInferenceNoKey = authorizeRequest({ headers: {} }, remoteConfig, {
  method: 'POST',
  pathname: '/v1/chat/completions'
});
assert.equal(remoteInferenceNoKey.ok, false);
assert.equal(remoteInferenceNoKey.status, 401);

const remoteInferenceWithKey = authorizeRequest({ headers: { 'x-api-key': 'sk-lloom-local' } }, remoteConfig, {
  method: 'POST',
  pathname: '/v1/chat/completions'
});
assert.equal(remoteInferenceWithKey.ok, true);

const publicTelemetryConfig = {
  ...remoteConfig,
  security: { ...remoteConfig.security, publicTelemetry: true }
};
assert.equal(
  authorizeRequest({ headers: {} }, publicTelemetryConfig, {
    method: 'GET',
    pathname: '/gateway/status'
  }).ok,
  true
);
assert.equal(
  authorizeRequest({ headers: {} }, publicTelemetryConfig, {
    method: 'GET',
    pathname: '/gateway/metrics'
  }).ok,
  true
);
assert.equal(
  authorizeRequest({ headers: {} }, publicTelemetryConfig, {
    method: 'GET',
    pathname: '/gateway/backends'
  }).ok,
  false
);

const remoteAdminAllowed = {
  ...remoteConfig,
  security: { ...remoteConfig.security, allowRemoteAdmin: true }
};
assert.equal(
  authorizeRequest({ headers: { authorization: 'Bearer sk-lloom-local' } }, remoteAdminAllowed, {
    method: 'POST',
    pathname: '/gateway/setup/apply'
  }).ok,
  true
);
assert.equal(
  authorizeRequest({ headers: {} }, remoteAdminAllowed, {
    method: 'POST',
    pathname: '/gateway/setup/apply'
  }).ok,
  false
);

assert.equal(hasValidApiKey({ headers: { authorization: 'Bearer sk-lloom-local' } }, loopbackConfig), true);
assert.equal(hasValidApiKey({ headers: {} }, loopbackConfig), false);

assert.equal(corsHeaders(loopbackConfig)['access-control-allow-origin'], '*');
assert.equal(corsHeaders(remoteConfig)['access-control-allow-origin'], 'null');
assert.equal(
  corsHeaders({
    ...remoteConfig,
    security: { ...remoteConfig.security, allowWildcardCors: true }
  })['access-control-allow-origin'],
  '*'
);

// adminApiKeys force admin auth even on loopback with allowMissingAuth
{
  const adminLoopback = {
    server: { host: '127.0.0.1' },
    security: {
      allowMissingAuth: true,
      apiKeys: ['sk-infer'],
      adminApiKeys: ['sk-admin']
    }
  };
  assert.equal(
    authorizeRequest({ headers: {} }, adminLoopback, {
      method: 'POST',
      pathname: '/v1/chat/completions'
    }).ok,
    true
  );
  assert.equal(
    authorizeRequest({ headers: {} }, adminLoopback, {
      method: 'POST',
      pathname: '/gateway/setup/apply'
    }).ok,
    false
  );
  assert.equal(
    authorizeRequest({ headers: { authorization: 'Bearer sk-admin' } }, adminLoopback, {
      method: 'POST',
      pathname: '/gateway/setup/apply'
    }).ok,
    true
  );
  assert.equal(
    authorizeRequest({ headers: { authorization: 'Bearer sk-infer' } }, adminLoopback, {
      method: 'GET',
      pathname: '/gateway/status'
    }).ok,
    false
  );
}

assert.equal(assertBindAllowed({ server: { host: '127.0.0.1' } }).ok, true);
assert.equal(assertBindAllowed({ server: { host: '0.0.0.0' }, security: {} }).ok, false);
assert.equal(
  assertBindAllowed({
    server: { host: '0.0.0.0' },
    security: { allowNonLoopbackBind: true }
  }).ok,
  true
);

const pub = securityPublicStatus(loopbackConfig);
assert.equal(pub.loopback, true);
assert.equal(pub.authRequired, false);
assert.equal(classifyRoute('GET', '/gateway/security'), 'public');

console.log('security tests passed');
