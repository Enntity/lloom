import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRequest } from '../src/security.mjs';
const config = { server: { host: '127.0.0.1', port: 8100 }, security: { allowMissingAuth: true } };
function auth(headers, method = 'POST', pathname = '/gateway/runtimes/chat/stop') {
  return authorizeRequest({ method, headers: { host: '127.0.0.1:8100', ...headers } }, config, { method, pathname });
}
test('cross-site and DNS-rebound browser requests cannot read or mutate the loopback admin API', () => {
  for (const headers of [
    { origin: 'https://attacker.example' },
    { origin: 'null' },
    { host: 'rebound.example:8100' },
    { host: '127.rebound.example:8100', origin: 'http://127.rebound.example:8100' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'http://localhost:8100' },
    { origin: 'http://127.0.0.1:8101' },
    { origin: 'http://127.0.0.1:8100/path' },
    { origin: 'https://127.0.0.1:8100' },
    { host: '127.0.0.1:8100@attacker.example' }
  ]) {
    for (const method of ['GET', 'POST']) {
      assert.equal(auth(headers, method).ok, false, JSON.stringify(headers));
    }
  }
});
test('same-origin UI and non-browser CLI retain the local management contract', () => {
  assert.equal(auth({ origin: 'http://127.0.0.1:8100', 'sec-fetch-site': 'same-origin' }).ok, true);
  assert.equal(auth({}).ok, true);
  assert.equal(auth({ host: 'localhost:8100', origin: 'http://localhost:8100' }).ok, true);
});
test('public telemetry is also protected against cross-site reads while inference compatibility remains', () => {
  const req = { method: 'GET', headers: { host: '127.0.0.1:8100', origin: 'https://attacker.example' } };
  assert.equal(
    authorizeRequest(
      req,
      { ...config, security: { ...config.security, publicTelemetry: true } },
      { pathname: '/gateway/models' }
    ).ok,
    false
  );
  assert.equal(auth({ origin: 'https://a-client.example' }, 'POST', '/v1/chat/completions').ok, true);
});
