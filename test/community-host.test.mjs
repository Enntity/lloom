import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createLloomHostServer } from '../src/host-server.mjs';
import { assertSafeCommunityHost } from '../src/community-client.mjs';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-community-host-'));
const privateKeyPath = path.join(tempDir, 'signing-private.pem');
const publicKeyPath = path.join(tempDir, 'signing-public.pem');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
await fs.writeFile(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
await fs.writeFile(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));

const baseConfig = await loadConfig();
const deploymentTemplate = await loadConfig(path.join(process.cwd(), 'deploy', 'community', 'config.production.json'), {
  env: { ...process.env, COMMUNITY_DOMAIN: 'lloom.enntity.com' }
});
assert.deepEqual(deploymentTemplate.communityHost.corsOrigins, ['https://lloom.enntity.com']);
assert.throws(() => assertSafeCommunityHost('http://lloom.enntity.com'), /must use HTTPS/);
assert.throws(() => assertSafeCommunityHost('https://lloom.enntity.com'), /pinned trusted signing key/);
assert.throws(
  () => assertSafeCommunityHost('https://lloom.enntity.com', { trustedKeys: ['publisher=key'], trustHostKeys: true }),
  /trustHostKeys is development-only/
);
assert.equal(
  assertSafeCommunityHost('https://lloom.enntity.com', { trustedKeys: ['publisher=key'] }).hostname,
  'lloom.enntity.com'
);
const productionConfig = {
  ...baseConfig,
  communityHost: {
    ...baseConfig.communityHost,
    mode: 'production',
    siteName: 'LLooM Community Test',
    contributionUrl: 'https://github.com/Enntity/lloom/issues/new/choose',
    corsOrigins: ['https://lloom.enntity.com'],
    maxRequestBytes: 1024,
    rateLimitPerMinute: 120,
    privateKeyPath,
    publicKeyPath
  }
};

assert.throws(
  () =>
    createLloomHostServer({
      ...productionConfig,
      communityHost: { ...productionConfig.communityHost, privateKeyPath: '/missing' }
    }),
  /requires a configured private signing key/
);
assert.throws(
  () =>
    createLloomHostServer({
      ...productionConfig,
      communityHost: { ...productionConfig.communityHost, submissionsEnabled: true }
    }),
  /does not accept public submissions/
);

const app = createLloomHostServer(productionConfig, { host: '127.0.0.1', port: 0 });
try {
  await app.listen();
} catch (error) {
  if (error?.code === 'EPERM') {
    await fs.rm(tempDir, { recursive: true, force: true });
    console.log('community-host tests skipped: loopback listens are blocked by this sandbox');
    process.exit(0);
  }
  throw error;
}
const port = app.server.address().port;
const origin = `http://127.0.0.1:${port}`;

const home = await fetch(`${origin}/`);
assert.equal(home.status, 200);
assert.match(await home.text(), /Signed, admin-curated registry/);
assert.equal(home.headers.get('access-control-allow-origin'), null);
assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);

const health = await fetch(`${origin}/health`, { headers: { origin: 'https://lloom.enntity.com' } });
assert.equal(health.status, 200);
assert.equal(health.headers.get('access-control-allow-origin'), 'https://lloom.enntity.com');
assert.equal((await health.json()).submissionsEnabled, false);

const forbiddenCors = await fetch(`${origin}/v1/recipes`, {
  method: 'OPTIONS',
  headers: { origin: 'https://evil.example' }
});
assert.equal(forbiddenCors.status, 403);

const disabledSubmission = await fetch(`${origin}/v1/recipe-packs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}'
});
assert.equal(disabledSubmission.status, 405);

const tooLarge = await fetch(`${origin}/v1/recipe-packs/recommended`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ machineProfile: { platform: 'linux', arch: 'x64' }, padding: 'x'.repeat(2048) })
});
assert.equal(tooLarge.status, 413);

const pack = await fetch(`${origin}/v1/recipe-packs/apple-silicon-qwen36-35b-a3b-mtplx-pack`);
assert.equal(pack.status, 200);
assert.equal((await pack.json()).signatures[0].keyId, 'lloom-dev-seed');

await app.close();

const rateLimitedApp = createLloomHostServer(
  {
    ...productionConfig,
    communityHost: { ...productionConfig.communityHost, rateLimitPerMinute: 2, trustProxy: false }
  },
  { host: '127.0.0.1', port: 0 }
);
await rateLimitedApp.listen();
const rateLimitedPort = rateLimitedApp.server.address().port;
const rateLimitedOrigin = `http://127.0.0.1:${rateLimitedPort}`;
assert.equal((await fetch(`${rateLimitedOrigin}/health`)).status, 200);
assert.equal((await fetch(`${rateLimitedOrigin}/health`)).status, 200);
assert.equal((await fetch(`${rateLimitedOrigin}/health`)).status, 429);
await rateLimitedApp.close();
await fs.rm(tempDir, { recursive: true, force: true });
console.log('community-host tests passed');
