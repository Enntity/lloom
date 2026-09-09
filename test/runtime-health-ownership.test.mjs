import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RuntimeManager } from '../src/runtime-manager.mjs';

// Two managed appliances intentionally share an endpoint and served model ID.
// Docker is stubbed; the HTTP listener is real and belongs only to the live one.
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-health-owner-'));
const originalPath = process.env.PATH;
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'shared-model' }] }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  await fs.writeFile(
    path.join(directory, 'docker'),
    `#!/usr/bin/env node
const name = process.argv.at(-1);
if (name === 'missing') process.exit(1);
const running = name.startsWith('live');
console.log(JSON.stringify({State:{Running:running,Status:running?'running':'exited'}}));
`,
    { mode: 0o755 }
  );
  process.env.PATH = directory + path.delimiter + originalPath;
  const healthUrl = `http://127.0.0.1:${server.address().port}/v1/models`;
  const member = (containerName, extra = {}) => ({
    adapter: 'docker',
    management: 'managed',
    containerName,
    healthUrl,
    healthModel: 'shared-model',
    ...extra
  });
  const group = (prefix) => ({
    management: 'managed',
    healthUrl,
    healthModel: 'shared-model',
    placement: {
      mode: 'distributed',
      members: [
        { runtime: prefix + '-worker', order: 10 },
        { runtime: prefix + '-head', order: 20 }
      ]
    }
  });
  const manager = new RuntimeManager({
    runtimes: {
      'live-head': member('live-head'),
      'live-worker': member('live-worker', { healthStrategy: 'container' }),
      'stopped-head': member('stopped-head'),
      'stopped-worker': member('stopped-worker', { healthStrategy: 'container' }),
      missing: member('missing'),
      external: member('missing', { management: 'external' }),
      'wrong-model': member('live-wrong', { healthModel: 'other-model' }),
      live: group('live'),
      stopped: group('stopped')
    }
  });
  const { runtimes } = await manager.status();
  assert.equal(runtimes['stopped-head'].healthy, false);
  assert.equal(runtimes['stopped-head'].status, 'exited');
  assert.equal(runtimes.stopped.status, 'stopped');
  assert.equal(runtimes.live.status, 'running');
  assert.equal(runtimes.missing.healthy, false);
  assert.equal(runtimes.external.healthy, true);
  assert.equal(runtimes.external.status, 'external');
  assert.equal(runtimes['wrong-model'].healthy, false);
  assert.equal(await manager.isHealthy('stopped-head'), false);
  assert.equal(await manager.isHealthy('live-head'), true);
  assert.equal(await manager.runtimeAppearsLoaded('stopped-head'), false);
  assert.equal(await manager.runtimeAppearsLoaded('live-head'), true);
  console.log('Runtime health ownership: stopped/missing/shared-port, distributed and external cases passed');
} finally {
  process.env.PATH = originalPath;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(directory, { recursive: true, force: true });
}
