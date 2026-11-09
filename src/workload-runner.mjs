// LLooM creates workloads; Accord owns their identity, launch fence and recovery.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { withReservation } from '../vendor/accord/src/client.mjs';
const exec = promisify(execFile);
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const check = (ok, message) => {
  if (!ok) throw Error(message);
};
const words = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && !s.includes('\0'));
const key = (v) => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(v);
export function validateWorkloadPlan(plan) {
  const addresses = plan?.resources ?? [plan?.resource];
  check(
    plan?.schema === 1 &&
      (plan.resources === undefined || plan.resource === undefined) &&
      Array.isArray(addresses) &&
      addresses.length >= 1 &&
      addresses.length <= 8 &&
      new Set(addresses).size === addresses.length &&
      addresses.every((a) => typeof a === 'string' && a.split('/').length === 2) &&
      new Set(addresses.map((a) => a.split('/')[0])).size === 1,
    'Use schema 1 and one authority/resource address, or resources: addresses on one authority'
  );
  check(
    Array.isArray(plan.containers) && plan.containers.length > 0 && plan.containers.length <= 16,
    'Specify 1..16 containers'
  );
  check(Array.isArray(plan.supervisors ?? []) && (plan.supervisors ?? []).length <= 16, 'At most 16 supervisors');
  const names = new Set();
  for (const c of [...plan.containers, ...(plan.supervisors ?? [])]) {
    check(key(c.name) && key(c.host) && !names.has(c.name), 'Use unique workload names and host aliases');
    names.add(c.name);
    check(words(c.command), 'Each workload needs an argv command');
  }
  for (const c of plan.containers) {
    check(typeof c.image === 'string' && c.image.length > 0 && !c.image.startsWith('-'), 'Specify a cached image');
    check(
      !c.args || (Array.isArray(c.args) && c.args.every((s) => typeof s === 'string')),
      'Container args must be strings'
    );
    // Identity, lifecycle and isolation options belong to this launcher.
    const permitted = new Set([
      '--network',
      '--runtime',
      '--cpus',
      '--memory',
      '--pids-limit',
      '--gpus',
      '--env',
      '--volume',
      '--mount',
      '--workdir',
      '--user',
      '--shm-size',
      '--ipc',
      '--cpuset-cpus',
      '--memory-swap',
      '--cap-add',
      '--device',
      '--ulimit'
    ]);
    const args = c.args ?? [];
    for (let i = 0; i < args.length; i += 2) {
      if (args[i] === '--init') {
        i--;
        continue;
      }
      check(
        permitted.has(args[i]) && typeof args[i + 1] === 'string' && !args[i + 1].includes('\0'),
        'Use supported container option/value pairs'
      );
    }
  }
  for (const [host, c] of Object.entries(plan.hosts ?? {})) {
    check(
      key(host) && (c.local === true || (typeof c.ssh === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(c.ssh))),
      'Invalid host transport'
    );
    for (const f of ['identityFile', 'knownHostsFile'])
      check(
        c[f] === undefined || (typeof c[f] === 'string' && c[f].startsWith('/')),
        'SSH files must be absolute paths'
      );
  }
  return plan;
}
export function workloadExecutor(plan) {
  return async (host, args) => {
    const c = plan.hosts?.[host] ?? { ssh: host };
    const options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5'];
    if (c.identityFile) options.push('-o', 'IdentitiesOnly=yes', '-i', c.identityFile);
    if (c.knownHostsFile) options.push('-o', 'UserKnownHostsFile=' + c.knownHostsFile);
    const result = c.local
      ? await exec(args[0], args.slice(1), { timeout: 30000, maxBuffer: 1048576 })
      : await exec('/usr/bin/ssh', [...options, c.ssh, args.map(quote).join(' ')], {
          timeout: 30000,
          maxBuffer: 1048576
        });
    return result.stdout.trim();
  };
}
const unitArg = (s) =>
  '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export async function runWorkload(
  plan,
  {
    client,
    execute = workloadExecutor(plan),
    signal,
    leaseMs = 300000,
    waitMs = 3600000,
    pollMs = 1000,
    onEvent = () => {}
  }
) {
  validateWorkloadPlan(plan);
  // A job on several Sparks holds each one. Every holder acquires in the same
  // (sorted) order, so two jobs that need overlapping Sparks queue instead of
  // each holding half.
  const addresses = [...(plan.resources ?? [plan.resource])].sort();
  const host = addresses[0].split('/')[0];
  const catalog = await client.collaborate('resources', {}, host);
  const capabilities = addresses.map((address) => {
    const capability = catalog.resources.find((r) => r.localId === address.split('/')[1])?.externalWorkloads;
    check(capability?.enabled, 'External workload registration is unavailable; no work started');
    return capability;
  });
  // Each workload belongs to the first held resource that approves its host.
  const owner = new Map();
  for (const c of [...plan.containers, ...(plan.supervisors ?? [])]) {
    const index = capabilities.findIndex((capability) => capability.hosts.includes(c.host));
    check(index >= 0, 'Workload host is not approved for this resource');
    check(
      capabilities[index].plugins.includes(plan.containers.includes(c) ? 'docker-container' : 'systemd-user-unit'),
      'Workload plugin is unavailable'
    );
    owner.set(c, index);
  }
  // No image pulls, residency changes or launch before ownership.
  for (const c of plan.containers)
    await execute(c.host, ['docker', 'image', 'inspect', c.image, '--format', '{{.Id}}']);
  const created = [],
    units = [];
  let released = false,
    result;
  const options = { leaseMs, waitMs, purpose: plan.title ?? 'LLooM workload', releaseWaitMs: 60000 };
  const holdAll = (index, held, outer) =>
    index === addresses.length
      ? work(held, outer)
      : withReservation(
          client,
          addresses[index],
          (owned) => holdAll(index + 1, [...held, owned], AbortSignal.any([outer, owned.signal])),
          { ...options, signal: outer }
        );
  const work = async (held, owned) => {
    const grants = [];
    for (const { reservationId } of held) {
      const grant = await client.reservation(reservationId, host);
      check(grant.state === 'running' && grant.claimId && grant.workloadUnitPrefix, 'No running workload grant');
      grants.push(grant);
      onEvent({ state: 'preparing', reservationId, host });
    }
    const targets = held.map(() => []);
    for (const c of plan.containers) {
      owned.throwIfAborted();
      const grant = grants[owner.get(c)];
      const name =
        'lloom-' +
        createHash('sha256')
          .update(grant.claimId + '/' + c.name)
          .digest('hex')
          .slice(0, 24);
      // A timed-out create can leave a stopped container, but can never launch it.
      const id = await execute(c.host, [
        'docker',
        'create',
        '--pull=never',
        '--name',
        name,
        '--restart=no',
        '--label',
        'accord.authority=' + grant.authority,
        '--label',
        'accord.claim=' + grant.claimId,
        '--label',
        'accord.generation=' + grant.generation,
        ...(c.args ?? []),
        '--entrypoint',
        c.command[0],
        c.image,
        ...c.command.slice(1)
      ]);
      check(/^[a-f0-9]{64}$/.test(id), 'Container creation identity unconfirmed');
      const target = { host: c.host, plugin: 'docker-container', id };
      created.push({ ...target, name: c.name });
      targets[owner.get(c)].push(target);
    }
    for (const s of plan.supervisors ?? []) {
      owned.throwIfAborted();
      const name = grants[owner.get(s)].workloadUnitPrefix + s.name + '.service';
      const command = s.command.map((arg) =>
        arg.replace(/\{container:([a-zA-Z0-9_.-]+)\}/g, (_, n) => {
          const c = created.find((c) => c.name === n && c.host === s.host);
          check(c, 'Supervisor container reference must be on the same host');
          return c.id;
        })
      );
      check(
        command[0].startsWith('/') && command.every((x) => !/[\r\n]/.test(x)),
        'Use an absolute supervisor executable and single-line arguments'
      );
      const definition =
        '[Unit]\nDescription=LLooM registered workload supervisor\n[Service]\nType=simple\nExecStart=' +
        command.map(unitArg).join(' ') +
        '\nKillMode=control-group\nRestart=no\nTimeoutStopSec=10\n';
      await execute(s.host, [
        'python3',
        '-c',
        "import pathlib,sys,base64; p=pathlib.Path.home()/'.config/systemd/user'/sys.argv[1];p.parent.mkdir(parents=True,exist_ok=True);f=p.open('xb');f.write(base64.b64decode(sys.argv[2]));f.close()",
        name,
        Buffer.from(definition).toString('base64')
      ]);
      units.push({ host: s.host, name });
      await execute(s.host, ['systemctl', '--user', 'daemon-reload']);
      targets[owner.get(s)].push({ host: s.host, plugin: 'systemd-user-unit', id: name });
    }
    owned.throwIfAborted();
    // Registration and launch retries retain identical keys. No direct docker start.
    const retry = async (op, args) => {
      let error;
      for (let n = 0; n < 3; n++) {
        owned.throwIfAborted();
        try {
          return await client.collaborate(op, args, host);
        } catch (e) {
          error = e;
        }
      }
      throw error;
    };
    // Register every hold's entire set before starting any member. Launch containers before watchers.
    const launches = [];
    for (const [index, { reservationId }] of held.entries()) {
      if (!targets[index].length) continue;
      const registered = await retry('workload-register', {
        id: reservationId,
        key: randomUUID(),
        targets: targets[index]
      });
      check(registered.workloads.length === targets[index].length, 'Registration is incomplete');
      for (const target of targets[index]) {
        const binding = registered.workloads.find((w) => w.target?.id === target.id && w.target?.host === target.host);
        check(binding, 'Registered target is missing');
        launches.push({ id: reservationId, workload: binding.id });
      }
    }
    for (const launch of launches) await retry('workload-launch', { ...launch, key: randomUUID() });
    const reservationIds = held.map((h) => h.reservationId);
    onEvent({
      state: 'running',
      reservationId: reservationIds[0],
      reservationIds,
      host,
      containers: created.map((c) => ({ host: c.host, id: c.id })),
      supervisors: units
    });
    for (;;) {
      owned.throwIfAborted();
      const states = [];
      for (const c of created)
        states.push(JSON.parse(await execute(c.host, ['docker', 'inspect', '--format', '{{json .State}}', c.id])));
      check(
        !states.some((s) => !s.Running && !s.Restarting && !s.Paused && s.ExitCode !== 0),
        'A workload exited unsuccessfully'
      );
      if (states.every((s) => !s.Running && !s.Restarting && !s.Paused)) {
        return { reservationId: reservationIds[0], reservationIds, host, exitCodes: states.map((s) => s.ExitCode) };
      }
      await delay(pollMs);
    }
  };
  try {
    result = await holdAll(0, [], signal ?? new AbortController().signal);
    released = true;
  } catch (error) {
    // withReservation already requested recovery. Never delete potentially active objects.
    onEvent({ state: 'recovery-requested', error: error.message });
    throw error;
  } finally {
    if (released) {
      // Release is the only stop authority. Cleanup removes exact stopped fixture objects.
      for (const c of created) await execute(c.host, ['docker', 'rm', c.id]);
      for (const u of units) {
        await execute(u.host, [
          'python3',
          '-c',
          "import pathlib,sys;(pathlib.Path.home()/'.config/systemd/user'/sys.argv[1]).unlink()",
          u.name
        ]);
        await execute(u.host, ['systemctl', '--user', 'daemon-reload']);
      }
    }
  }
  onEvent({ state: 'released', ...result });
  return { state: 'released', ...result };
}
