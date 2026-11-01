// Opt-in real host proof. Isolated authority and CPU-only objects; no production lease or route changes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workloadExecutor } from '../src/workload-runner.mjs';
import { accordFixture, eventually } from './accord-proof-fixture.mjs';
import { createHttp, listen, readBody, request } from '../vendor/accord/src/common.mjs';
const argv = process.argv.slice(2),
  option = (flag) => argv[argv.indexOf(flag) + 1];
assert(
  ['--policy', '--hosts', '--image', '--output'].every((f) => argv.includes(f)),
  'Use --policy FILE --hosts HOST_A,HOST_B --image CACHED_IMAGE --output FILE (disposable CPU host fixtures)'
);
const policy = JSON.parse(readFileSync(option('--policy'), 'utf8')),
  selected = option('--hosts').split(',');
assert.equal(selected.length, 2);
assert(selected.every((h) => policy.hosts[h]));
const h = await accordFixture(),
  events = [],
  effects = [];
let next, first;
const hosts = Object.fromEntries(
  selected.map((host) => {
    const c = policy.hosts[host];
    return [
      host,
      c.transport === 'local'
        ? { local: true }
        : { ssh: c.host, identityFile: c.identityFile, knownHostsFile: c.knownHostsFile }
    ];
  })
);
const image = option('--image');
const plan = {
  schema: 1,
  resource: '',
  title: 'Automatic LLooM CPU proof',
  hosts,
  containers: selected.map((host, i) => ({
    name: 'job' + i,
    host,
    image,
    command: ['/bin/sh', '-c', 'sleep 4'],
    args: [
      '--runtime',
      'runc',
      '--network',
      'none',
      '--cpus',
      '0.1',
      '--memory',
      '64m',
      '--pids-limit',
      '32',
      '--env',
      'NVIDIA_VISIBLE_DEVICES=void'
    ]
  })),
  supervisors: [{ name: 'watch', host: selected[0], command: ['/bin/sleep', '300'] }]
};
const execute = workloadExecutor(plan);
const provider = createHttp(async (req, res, url) => {
  const body = await readBody(req),
    action = url.pathname.slice(1);
  if (action === 'restore' && body.generation === 1) {
    assert(first);
    for (const c of first.containers)
      assert.equal(await execute(c.host, ['docker', 'inspect', '--format', '{{.State.Running}}', c.id]), 'false');
    for (const u of first.supervisors)
      assert.equal(
        await execute(u.host, ['systemctl', '--user', 'show', u.name, '--property=ActiveState', '--value']),
        'inactive'
      );
    effects.push({ kind: 'restored-after-stop', at: Date.now() });
  }
  return { ...body, [action]: true };
});
try {
  const endpoint = await listen(provider),
    tokenFile = join(h.data, 'provider.token');
  writeFileSync(tokenFile, 'fixture-only');
  await h.client('admin').registerResource({
    schema: 1,
    id: 'auto-workload',
    asset: 'cpu-auto-proof',
    plugin: 'managed-http',
    endpoint,
    tokenFile
  });
  writeFileSync(
    join(h.data, 'workload-policy.json'),
    JSON.stringify({
      schema: 1,
      hosts: policy.hosts,
      resources: { 'auto-workload': { hosts: selected, plugins: ['docker-container', 'systemd-user-unit'] } }
    })
  );
  const authority = (await h.client('admin').host()).authority;
  plan.resource = authority + '/auto-workload';
  // Local authority: real client normally dispatches locally without an explicit host.
  const b = h.client('agent-b');
  const planFile = join(h.data, 'plan.json'),
    sessionFile = join(h.data, 'launcher-session.json');
  writeFileSync(planFile, JSON.stringify(plan));
  writeFileSync(
    sessionFile,
    JSON.stringify({ schema: 1, url: h.url, credential: readFileSync(join(h.data, 'agent-a.token'), 'utf8').trim() }),
    { mode: 0o600 }
  );
  const owner = h.client('agent-a');
  const parent = await owner.collaborate('session-report', {
    key: 'parent-start',
    title: 'Existing parent task',
    state: 'working',
    detail: 'Other agent work continues'
  });
  const cli = fileURLToPath(new URL('../bin/lloom.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, 'workload', 'run', '--file', planFile, '--apply', '--yes', '--json'], {
    env: { ...process.env, ACCORD_SESSION_FILE: sessionFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let buffer = '',
    errors = '';
  child.stderr.on('data', (b) => (errors += b));
  child.stdout.on('data', (bytes) => {
    buffer += bytes;
    for (;;) {
      const at = buffer.indexOf('\n');
      if (at < 0) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const e = JSON.parse(line);
      events.push(e);
      if (e.state === 'running') {
        first = e;
        next = b.reserve(plan.resource, { leaseMs: 60000 }).then(async (r) => {
          assert.notEqual((await b.reservation(r.id)).state, 'running');
          return r;
        });
      }
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  assert.equal(code, 0, errors);
  const result = events.find((e) => e.state === 'released');
  assert(result);
  assert.equal(result.state, 'released');
  assert(first);
  const parentAfter = (await owner.collaborate('sessions', {})).sessions.find((s) => s.id === parent.id);
  assert.equal(parentAfter.title, parent.title);
  assert.equal(parentAfter.state, 'working');
  const jobs = (await owner.collaborate('jobs', {})).jobs;
  assert(jobs.some((j) => j.title === plan.title && j.state === 'done'));
  const rb = await next;
  await eventually(async () => (await b.reservation(rb.id)).state === 'running');
  const external = (
    await request(
      h.driverUrl,
      readFileSync(join(h.data, 'driver-control.token'), 'utf8').trim(),
      '/control/workloads/audit?resource=auto-workload'
    )
  ).events;
  const audit = (
    await request(
      h.driverUrl,
      readFileSync(join(h.data, 'driver-control.token'), 'utf8').trim(),
      '/control/audit?resource=auto-workload'
    )
  ).events;
  const registrations = external.filter((e) => e.kind === 'workload.registered');
  const launches = external.filter((e) => e.kind === 'workload.launch_intent');
  assert.equal(registrations.length, 3);
  assert.equal(launches.length, 3);
  assert(registrations.every((e) => e.seq < launches[0].seq));
  const stopped = external.filter((e) => e.kind === 'workload.stopped');
  assert.equal(new Set(stopped.map((e) => e.binding)).size, 3);
  const granted = audit.find((e) => e.kind === 'grant.active' && e.generation === 2);
  assert(granted);
  assert(stopped.every((e) => e.at < granted.at));
  assert(effects[0].at < granted.at);
  for (const c of first.containers) {
    await assert.rejects(execute(c.host, ['docker', 'inspect', c.id]));
  }
  await b.release(rb.id);
  await eventually(async () => (await b.reservation(rb.id)).state === 'released');
  const proof = {
    status: 'passed',
    at: new Date().toISOString(),
    kind: 'Packaged LLooM CLI normal automatic launch and release on two real hosts',
    cpuOnly: true,
    events,
    effects,
    externalAudit: external,
    driverAudit: audit,
    assertions: [
      'LLooM created and registered both containers and supervisor automatically',
      'All registration preceded launch',
      'Ordinary packaged CLI acquired ownership automatically',
      'Normal completion released through Accord',
      'Inherited parent session preserved; workload job completed separately',
      'Supervisor and containers confirmed stopped before restoration and second agent grant',
      'Stopped containers cleaned up',
      'Production authority, models and routes untouched'
    ]
  };
  writeFileSync(option('--output'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify({ status: 'passed', assertions: proof.assertions }));
} finally {
  await h.close();
  await new Promise((r) => provider.close(r));
}
