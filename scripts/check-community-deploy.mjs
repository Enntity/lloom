import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const communityDeploy = path.join(root, 'deploy', 'community');
const read = (name) => fs.readFile(path.join(communityDeploy, name), 'utf8');

const [configText, compose, dockerfile, caddyfile, envExample] = await Promise.all([
  read('config.production.json'),
  read('docker-compose.prod.yml'),
  read('Dockerfile'),
  read('Caddyfile'),
  read('.env.example')
]);
const config = JSON.parse(configText);
const service = compose.split('\n  lloom-community:\n')[1]?.split('\n\nnetworks:')[0] ?? '';

assert.equal(config.communityHost.mode, 'production');
assert.notEqual(config.communityHost.submissionsEnabled, true);
assert.equal(config.communityHost.rateLimitPerMinute, 120);
assert.match(config.communityHost.privateKeyPath, /^\/run\/secrets\//);
assert.match(config.communityHost.publicKeyPath, /^\/run\/secrets\//);
assert.match(config.communityHost.contributionUrl, /^https:\/\//);
assert.match(compose, /CADDY_IMAGE:\?Set CADDY_IMAGE to an immutable digest-pinned Caddy image/);
assert.match(compose, /LLOOM_COMMUNITY_IMAGE:\?Set LLOOM_COMMUNITY_IMAGE to an immutable digest-pinned release image/);
assert.doesNotMatch(compose, /docker\.sock/);
assert.doesNotMatch(service, /^\s+ports:/m);
assert.match(service, /read_only: true/);
assert.match(service, /user: "10001:10001"/);
assert.match(service, /COMMUNITY_DOMAIN: \$\{COMMUNITY_DOMAIN:\?Set COMMUNITY_DOMAIN\}/);
assert.match(service, /- ALL/);
assert.match(service, /no-new-privileges:true/);
assert.match(service, /pids_limit:/);
assert.match(service, /mem_limit:/);
assert.match(service, /healthcheck:/);
assert.match(dockerfile, /USER 10001:10001/);
assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
assert.match(caddyfile, /request_body/);
assert.match(caddyfile, /reverse_proxy lloom-community:8110/);
assert.doesNotMatch(envExample, /:latest\b/);
assert.match(envExample, /@sha256:replace-with-/);

console.log('community deployment policy ok');
