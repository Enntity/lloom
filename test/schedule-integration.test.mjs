import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { loadConfig } from '../src/config.mjs';
import { resourceID } from '../src/accord-resources.mjs';
import { readHostMemory } from '../src/host-memory.mjs';
import { accordFixture, eventually, stop, delay } from './accord-fixture.mjs';
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
for (const crash of ['coordinator', 'gateway'])
  test(
    `two agents use Accord through LLooM: ${crash} crash, real workload stop, telemetry, jobs and messaging`,
    { timeout: 60000 },
    async (t) => {
      const h = await accordFixture();
      const prior = process.env.ACCORD_PROFILE;
      process.env.ACCORD_PROFILE = h.profile;
      t.after(async () => {
        if (prior) process.env.ACCORD_PROFILE = prior;
        else delete process.env.ACCORD_PROFILE;
        await h.close();
      });
      const runtimePort = await port(),
        gatewayPort = await port(),
        script = path.join(h.dir, 'backend.mjs'),
        pidFile = path.join(h.dir, 'backend.pid');
      await fs.writeFile(
        script,
        `import http from 'node:http';import fs from 'node:fs';fs.writeFileSync(process.argv[3],String(process.pid));const s=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({data:[{id:'borrowed'}]}));});s.listen(Number(process.argv[2]),'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`
      );
      const sourcePath = path.join(h.dir, 'config.json');
      const raw = {
        server: { host: '127.0.0.1', port: gatewayPort },
        security: { adminApiKeys: ['test-admin'] },
        logging: { metricsPersistence: false },
        runtimePolicy: { enabled: true, memoryBudgetGb: 4 },
        backends: { fixture: { type: 'openai', baseUrl: `http://127.0.0.1:${runtimePort}/v1` } },
        runtimes: {
          borrowed: {
            enabled: true,
            keepWarm: false,
            command: process.execPath,
            args: [script, String(runtimePort), pidFile],
            port: runtimePort,
            healthUrl: `http://127.0.0.1:${runtimePort}/health`,
            startupTimeoutMs: 5000,
            memoryGb: 0.01
          }
        },
        models: [{ id: 'borrowed', backend: 'fixture', runtime: 'borrowed', upstreamModel: 'borrowed' }],
        reservations: {
          resources: {
            gpu: {
              asset: 'test:lloom-managed-backend',
              description: 'CPU-only fixture workload',
              workloads: ['borrowed']
            }
          }
        }
      };
      await fs.writeFile(sourcePath, JSON.stringify(raw));
      const config = await loadConfig(sourcePath);
      const gatewayScript = path.join(h.dir, 'gateway.mjs');
      await fs.writeFile(
        gatewayScript,
        `import {loadConfig} from ${JSON.stringify(new URL('../src/config.mjs', import.meta.url).href)};import {createLloomServer} from ${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)};const app=createLloomServer(await loadConfig(process.argv[2]),{logger:{info(){},warn(){},error(){}}});await app.listen();process.send({ready:true});process.on('SIGTERM',async()=>{await app.close({stopRuntimes:true,httpGraceMs:100});process.exit(0);});`
      );
      async function startGateway() {
        const p = fork(gatewayScript, [sourcePath], {
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: { ...process.env, HOME: h.home, ACCORD_PROFILE: h.profile }
        });
        h.children.push(p);
        let ready = false,
          error = '';
        p.stderr.on('data', (b) => {
          error += b;
        });
        p.on('message', (v) => {
          ready = v.ready;
        });
        await eventually(() => {
          if (p.exitCode !== null) throw Error(error);
          return ready;
        });
        return p;
      }
      let gateway = await startGateway();
      t.after(() => stop(gateway));
      const resource = resourceID(config, 'gpu'),
        a = h.client('agent-a'),
        b = h.client('agent-b');
      await eventually(async () => (await a.resources()).resources.some((r) => r.localId === resource));
      const providerPort = JSON.parse(await fs.readFile(path.join(h.dir, 'accord-provider.json'), 'utf8')).port;
      assert.notEqual(providerPort, gatewayPort);
      const privateOnly = await fetch(
        `http://127.0.0.1:${providerPort}/gateway/accord/resources/gpu%230/availability`,
        { method: 'POST', headers: { authorization: 'Bearer test-admin' } }
      );
      assert.equal(privateOnly.status, 403, 'gateway credentials cannot perform provider effects');
      await h.client('admin').collaborate('manager-configure', {
        name: 'legacy-ui',
        url: `http://127.0.0.1:${gatewayPort}`,
        key: 'test-admin'
      });
      const migrated = await a.resources();
      assert.equal(migrated.resources.filter((r) => r.localId === resource).length, 1);
      assert(!migrated.resources.some((r) => r.manager === 'legacy-ui'));
      const oldBridge = await h.client('admin').collaborate('manager-schedules');
      assert.equal(oldBridge.managers[0].state, 'migrated');
      await a.announce({ label: 'Fixture A', activity: 'work' });
      await b.announce({ label: 'Fixture B', activity: 'waiting' });
      const me = await b.me();
      await a.send(`${(await b.host()).authority}/${me.id}`, 'resource handoff');
      await eventually(async () => (await b.inbox()).messages.length === 1);
      const ra = await a.reserve(resource, { leaseMs: 20000 });
      await eventually(async () => (await a.reservation(ra.id)).state === 'running');
      // LLooM starts a real supervised process through Accord's registered provider.
      await a.collaborate('start', { id: ra.id, key: 'workload-one' });
      const pid = Number(await fs.readFile(pidFile, 'utf8'));
      process.kill(pid, 0);
      await a.collaborate('job', {
        key: 'job-one',
        title: 'Managed fixture workload',
        reservationId: ra.id,
        state: 'working'
      });
      const board = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/schedule`, {
        headers: { authorization: 'Bearer test-admin' }
      }).then((r) => r.json());
      assert.equal(board.authority, 'accord');
      assert.equal(board.jobs.length, 1);
      assert.equal(board.resources[0].holders.length, 1);
      const removed = await fetch(`http://127.0.0.1:${gatewayPort}/gateway/schedule/reservations`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-admin', 'content-type': 'application/json' },
        body: JSON.stringify({ resource: 'gpu', owner: 'spoofed', apply: true, yes: true })
      });
      assert.equal(removed.status, 410);
      const telemetry = await a.telemetry();
      assert(telemetry.host.memory.totalBytes > 0);
      const rb = await b.reserve(resource, { leaseMs: 20000 });
      assert.notEqual((await b.reservation(rb.id)).state, 'running');
      const accordPort = Number(new URL(h.url).port);
      if (crash === 'coordinator') {
        await stop(h.server, 'SIGKILL');
        await assert.rejects(readHostMemory(), 'unavailable telemetry must fail admission closed');
        await delay(650);
        await h.start(accordPort);
      } else {
        await stop(gateway, 'SIGKILL');
        // The runtime supervisor survives the gateway. An unavailable provider
        // must keep the next agent queued even after revocation is requested.
        process.kill(pid, 0);
        await a.release(ra.id);
        await delay(700);
        assert.notEqual((await b.reservation(rb.id)).state, 'running');
        process.kill(pid, 0);
        gateway = await startGateway();
      }
      await eventually(async () => (await b.reservation(rb.id)).state === 'running', 20000);
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      await assert.rejects(a.collaborate('start', { id: ra.id, key: 'stale' }));
      await b.release(rb.id);
      await eventually(async () => (await b.reservation(rb.id)).state === 'released');
      const after = JSON.parse(await fs.readFile(path.join(h.dir, 'schedule-accord-effects.json'), 'utf8'));
      assert(Object.values(after.resources).every((r) => r.phase === 'idle'));
      assert.equal(
        await fs.stat(path.join(h.dir, 'schedule.json')).then(
          () => true,
          () => false
        ),
        false,
        'no parallel LLooM reservation database'
      );
    }
  );
