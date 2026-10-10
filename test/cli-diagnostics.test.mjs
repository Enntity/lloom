import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  gatewayRequest,
  gatewayErrorMessage,
  redactGatewaySecrets,
  resolveAdminCredential,
  safeGatewayDiagnostic
} from '../src/gateway-client.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(repoRoot, 'bin', 'lloom.mjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.once('error', reject);
  });
}

/** A gateway fixture that answers every request with a fixed status. */
async function startStatusGateway(status, { body = null, delayMs = 0 } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization ?? null });
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const payload = body ?? { error: { code: 'fixture_error', message: 'gateway rejected request' } };
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  const port = await listen(server);
  return {
    port,
    seen,
    config: {
      server: { host: '127.0.0.1', port },
      security: { adminApiKeys: ['${LLOOM_ADMIN_API_KEY}'] }
    },
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

/** Pick a loopback port that is currently unused so connections are refused. */
async function pickUnusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function runCli(args, { env = {}, home } = {}) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
      ...(home ? { HOME: home } : {})
    }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { code, stdout, stderr };
}

async function writeConfigFixture(raw) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-cli-diag-home-'));
  const dir = path.join(home, '.lloom');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(raw), { mode: 0o600 });
  return home;
}

const ADMIN_SECRET = 'sk-live-admin-super-secret';

function clusterConfig(port) {
  return {
    server: { host: '127.0.0.1', port },
    cluster: { nodeId: 'node-01', leaderNode: 'node-01', nodes: { 'node-01': { id: 'node-01' } } },
    security: { adminApiKeys: ['${LLOOM_ADMIN_API_KEY}'], apiKeys: [] }
  };
}

test('gatewayRequest distinguishes 401 authentication failure', async () => {
  const gateway = await startStatusGateway(401, {
    body: { error: { code: 'unauthorized', message: 'missing or invalid admin authorization token' } }
  });
  try {
    await assert.rejects(gatewayRequest(gateway.config, '/gateway/cluster', { throwOnError: true }), (error) => {
      assert.equal(error.kind, 'auth');
      assert.equal(error.status, 401);
      assert.match(error.code, /gateway_auth_failed/);
      assert.match(error.message, /401|unauthorized/i);
      return true;
    });
  } finally {
    await gateway.close();
  }
});

test('gatewayRequest distinguishes 403 authorization failure from 401', async () => {
  const gateway = await startStatusGateway(403, {
    body: { error: { code: 'remote_admin_disabled', message: 'Admin write endpoints are disabled' } }
  });
  try {
    await assert.rejects(gatewayRequest(gateway.config, '/gateway/cluster', { throwOnError: true }), (error) => {
      assert.equal(error.kind, 'authorization');
      assert.equal(error.status, 403);
      assert.match(error.code, /gateway_forbidden/);
      return true;
    });
  } finally {
    await gateway.close();
  }
});

test('gatewayRequest distinguishes 5xx server errors', async () => {
  const gateway = await startStatusGateway(500);
  try {
    await assert.rejects(gatewayRequest(gateway.config, '/gateway/cluster', { throwOnError: true }), (error) => {
      assert.equal(error.kind, 'server');
      assert.equal(error.status, 500);
      assert.match(error.code, /gateway_server_error/);
      return true;
    });
  } finally {
    await gateway.close();
  }
});

test('gatewayRequest marks connection refusal distinctly and allows fallback', async () => {
  const port = await pickUnusedPort();
  const config = { server: { host: '127.0.0.1', port }, security: {} };
  await assert.rejects(gatewayRequest(config, '/gateway/cluster', { throwOnError: true, timeoutMs: 1500 }), (error) => {
    assert.equal(error.kind, 'refused');
    assert.match(error.code, /gateway_connection_refused/);
    return true;
  });
  const fallback = await gatewayRequest(config, '/gateway/cluster', {
    throwOnError: true,
    fallbackOnRefused: true,
    timeoutMs: 1500
  });
  assert.equal(fallback, null);
});

test('gatewayRequest marks timeouts distinctly from refusal', async () => {
  const gateway = await startStatusGateway(200, { body: { ok: true }, delayMs: 500 });
  try {
    await assert.rejects(
      gatewayRequest(gateway.config, '/gateway/cluster', { throwOnError: true, timeoutMs: 75 }),
      (error) => {
        assert.equal(error.kind, 'timeout');
        assert.match(error.code, /gateway_timeout/);
        return true;
      }
    );
  } finally {
    await gateway.close();
  }
});

test('fallback is never applied to 401 or 403', async () => {
  for (const status of [401, 403]) {
    const gateway = await startStatusGateway(status);
    try {
      await assert.rejects(
        gatewayRequest(gateway.config, '/gateway/cluster', {
          throwOnError: true,
          fallbackOnRefused: true
        }),
        (error) => {
          assert.equal(error.status, status);
          assert.ok(['auth', 'authorization'].includes(error.kind));
          return true;
        }
      );
    } finally {
      await gateway.close();
    }
  }
});

test('malicious upstream body cannot echo the configured credential', async () => {
  const gateway = await startStatusGateway(500, {
    body: { error: { code: 'boom', message: `upstream echoed ${ADMIN_SECRET} in its error` } }
  });
  const previous = process.env.LLOOM_ADMIN_API_KEY;
  process.env.LLOOM_ADMIN_API_KEY = ADMIN_SECRET;
  try {
    let captured;
    await assert.rejects(gatewayRequest(gateway.config, '/gateway/cluster', { throwOnError: true }), (error) => {
      captured = error;
      return true;
    });
    assert.doesNotMatch(captured.message, new RegExp(ADMIN_SECRET));
    assert.equal(captured.status, 500);
  } finally {
    await gateway.close();
    if (previous === undefined) delete process.env.LLOOM_ADMIN_API_KEY;
    else process.env.LLOOM_ADMIN_API_KEY = previous;
  }
});

test('redactGatewaySecrets strips resolved credentials and placeholders', () => {
  const config = { security: { adminApiKeys: ['${LLOOM_ADMIN_API_KEY}', 'literal-admin-key'] } };
  const text = redactGatewaySecrets(`leak ${ADMIN_SECRET} and literal-admin-key and \${LLOOM_ADMIN_API_KEY}`, {
    config,
    env: { LLOOM_ADMIN_API_KEY: ADMIN_SECRET }
  });
  assert.doesNotMatch(text, new RegExp(ADMIN_SECRET));
  assert.doesNotMatch(text, /literal-admin-key/);
  assert.doesNotMatch(text, /\$\{LLOOM_ADMIN_API_KEY\}/);
});

test('cluster status reports 401 as authentication, not unreachable', async () => {
  const gateway = await startStatusGateway(401);
  const home = await writeConfigFixture(clusterConfig(gateway.port));
  try {
    const result = await runCli(['cluster', 'status', '--json'], { home });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /401|unauthorized|authentication/i);
    assert.doesNotMatch(result.stderr, /not reachable|unreachable/i);
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.status, 401);
    assert.match(parsed.error.code, /gateway_auth_failed/);
  } finally {
    await gateway.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('cluster status distinguishes 403 from 401', async () => {
  const gateway = await startStatusGateway(403);
  const home = await writeConfigFixture(clusterConfig(gateway.port));
  try {
    const result = await runCli(['cluster', 'status', '--json'], { home });
    assert.equal(result.code, 3);
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.error.kind, 'authorization');
    assert.equal(parsed.error.status, 403);
  } finally {
    await gateway.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('runtime status surfaces 500 without pretending the gateway is down', async () => {
  const gateway = await startStatusGateway(500);
  const home = await writeConfigFixture(clusterConfig(gateway.port));
  try {
    const result = await runCli(['runtime-status', '--json'], { home });
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.error.status, 500);
    assert.match(parsed.error.code, /gateway_server_error/);
    assert.doesNotMatch(result.stderr, /not reachable/i);
  } finally {
    await gateway.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('runtime status reports connection refusal distinctly', async () => {
  const port = await pickUnusedPort();
  const home = await writeConfigFixture(clusterConfig(port));
  try {
    const result = await runCli(['runtime-status', '--json'], { home });
    assert.notEqual(result.code, 0);
    const parsed = JSON.parse(result.stderr);
    assert.equal(parsed.error.kind, 'refused');
    assert.match(parsed.error.code, /gateway_connection_refused/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('env-backed admin credential succeeds and never reaches argv/stderr', async () => {
  const gateway = await startStatusGateway(200, {
    body: { cluster: { id: 'fixture', leaderNode: 'node-01', nodes: {} } }
  });
  const home = await writeConfigFixture(clusterConfig(gateway.port));
  try {
    const result = await runCli(['cluster', 'status', '--json', '--admin-api-key-env', 'LLOOM_ADMIN_API_KEY'], {
      home,
      env: { LLOOM_ADMIN_API_KEY: ADMIN_SECRET }
    });
    assert.equal(result.code, 0);
    assert.equal(gateway.seen.length > 0, true);
    assert.equal(gateway.seen.at(-1).authorization, `Bearer ${ADMIN_SECRET}`);
    assert.doesNotMatch(result.stdout, new RegExp(ADMIN_SECRET));
    assert.doesNotMatch(result.stderr, new RegExp(ADMIN_SECRET));
  } finally {
    await gateway.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('gatewayErrorMessage never embeds upstream text', () => {
  const message = gatewayErrorMessage({ kind: 'auth', status: 401 });
  assert.match(message, /401/);
  assert.doesNotMatch(message, /token|Boom|secret/i);
});

test('explicit credential variable overrides a stale literal saved key', async () => {
  const gateway = await startStatusGateway(200, { body: { cluster: { nodes: {} } } });
  const raw = clusterConfig(gateway.port);
  raw.security.adminApiKeys = ['stale-key'];
  const home = await writeConfigFixture(raw);
  try {
    const result = await runCli(['cluster', 'status', '--json', '--admin-api-key-env', 'ALT_ADMIN_KEY'], {
      home,
      env: { ALT_ADMIN_KEY: ADMIN_SECRET }
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(gateway.seen.at(-1).authorization, `Bearer ${ADMIN_SECRET}`);
    assert.ok(!result.stderr.includes(ADMIN_SECRET));
  } finally {
    await gateway.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('malformed credential options fail even without a gateway command', async () => {
  for (const args of [
    ['help', '--admin-api-key-env'],
    ['help', '--admin-api-key-env', 'bad-name']
  ]) {
    const result = await runCli(args);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /valid environment variable name/);
  }
});

test('safe gateway error codes survive; arbitrary upstream codes do not', async () => {
  for (const code of ['remote_admin_disabled', ADMIN_SECRET]) {
    const gateway = await startStatusGateway(403, { body: { error: { code, message: ADMIN_SECRET } } });
    try {
      await assert.rejects(gatewayRequest(gateway.config, '/gateway/cluster'), (error) => {
        assert.equal(error.upstreamCode, code === 'remote_admin_disabled' ? code : undefined);
        assert.ok(!error.message.includes(ADMIN_SECRET));
        return true;
      });
    } finally {
      await gateway.close();
    }
  }
});

test('short configured credentials are redacted', () => {
  assert.equal(
    redactGatewaySecrets('a xy b', { config: { security: { adminApiKeys: ['xy'] } }, env: {} }),
    'a [redacted] b'
  );
});

test('default and explicitly selected credential environments have documented precedence', () => {
  const config = { security: { adminApiKeys: ['saved-key'] } };
  assert.equal(
    resolveAdminCredential(config, {
      explicitEnvName: 'SELECTED_ADMIN_KEY',
      env: { SELECTED_ADMIN_KEY: 'selected-key', LLOOM_ADMIN_API_KEY: 'default-key' }
    }),
    'selected-key'
  );
  assert.equal(resolveAdminCredential(config, { env: { LLOOM_ADMIN_API_KEY: 'default-key' } }), 'default-key');
  assert.equal(resolveAdminCredential(config, { env: {} }), 'saved-key');
});

test('default environment credential overrides a stale literal saved key on the request', async () => {
  const gateway = await startStatusGateway(200, { body: { cluster: { nodes: {} } } });
  try {
    const config = { ...gateway.config, security: { adminApiKeys: ['stale-saved-key'] } };
    await gatewayRequest(config, '/gateway/cluster', {
      env: { LLOOM_ADMIN_API_KEY: ADMIN_SECRET },
      throwOnError: true
    });
    assert.equal(gateway.seen.at(-1).authorization, `Bearer ${ADMIN_SECRET}`);
  } finally {
    await gateway.close();
  }
});

test('missing selected credential fails before gateway HTTP is attempted', async () => {
  let requests = 0;
  await assert.rejects(
    gatewayRequest(
      { server: { host: '127.0.0.1', port: 1 }, security: { adminApiKeys: ['saved-key'] } },
      '/gateway/status',
      {
        explicitEnvName: 'MISSING_SELECTED_ADMIN_KEY',
        env: {},
        fetchImpl: async () => {
          requests += 1;
          throw new Error('fetch must not be called');
        }
      }
    ),
    /Selected admin credential environment variable is empty or unset/
  );
  assert.equal(requests, 0);
});

test('bounded rejected response bodies are cancelled at the diagnostic limit', async () => {
  let reads = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode('x'.repeat(2048));
  const response = {
    ok: false,
    status: 500,
    body: {
      getReader() {
        return {
          async read() {
            reads += 1;
            return { done: false, value: chunk };
          },
          async cancel() {
            cancelled = true;
          }
        };
      }
    }
  };
  await assert.rejects(
    gatewayRequest({ server: { host: '127.0.0.1', port: 8100 }, security: {} }, '/gateway/status', {
      env: {},
      timeoutMs: 100,
      fetchImpl: async () => response
    }),
    (error) => error.kind === 'server' && error.status === 500
  );
  assert.equal(reads, 8);
  assert.equal(cancelled, true);
});

test('safeGatewayDiagnostic redacts every stable string field, including exact collisions', () => {
  const diagnostic = safeGatewayDiagnostic(
    {
      code: ADMIN_SECRET,
      kind: ADMIN_SECRET,
      upstreamCode: ADMIN_SECRET,
      status: 500,
      message: `upstream exposed ${ADMIN_SECRET}`
    },
    { config: { security: { adminApiKeys: ['${DIAGNOSTIC_ADMIN_KEY}'] } }, env: { DIAGNOSTIC_ADMIN_KEY: ADMIN_SECRET } }
  );
  assert.deepEqual(diagnostic, {
    code: '[redacted]',
    kind: '[redacted]',
    upstreamCode: '[redacted]',
    status: 500,
    message: 'upstream exposed [redacted]'
  });
});

test('service doctor loads explicit environment file before templated config and credential inspection', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/health' ? { ok: true, pid: 42 } : { node: { id: 'custom-node' } }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const home = await writeConfigFixture({
    server: { host: '127.0.0.1', port },
    cluster: { nodeId: '${LLOOM_SERVICE_TEST_NODE}', leaderNode: '${LLOOM_SERVICE_TEST_NODE}' },
    security: { adminApiKeys: ['${LLOOM_SERVICE_TEST_KEY}'], apiKeys: [] }
  });
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const envFile = path.join(home, 'custom.env');
  await fs.writeFile(envFile, 'LLOOM_SERVICE_TEST_NODE=custom-node\nLLOOM_SERVICE_TEST_KEY=custom-file-secret\n');
  const child = await runCli(['service', 'doctor', '--environment-file', envFile, '--json'], {
    home,
    // No service-manager executable is available: this test checks only CLI
    // configuration expansion and authenticated inspection, never a real unit.
    env: { PATH: home, LLOOM_ADMIN_API_KEY: '' }
  });
  assert.equal(child.code, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.gateway.expectedNodeId, 'custom-node');
  assert.equal(result.gateway.nodeIdMatch, true);
  assert.equal(result.environmentFile.path, envFile);
  assert.deepEqual(seen, ['Bearer custom-file-secret', 'Bearer custom-file-secret']);
  assert.doesNotMatch(child.stdout + child.stderr, /custom-file-secret/);
});
