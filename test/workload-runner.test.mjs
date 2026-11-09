import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkload, validateWorkloadPlan } from '../src/workload-runner.mjs';
const plan = {
  schema: 1,
  resource: 'authority/gpu',
  containers: [{ name: 'job', host: 'worker', image: 'cached', command: ['/bin/sh', '-c', 'exit 0'] }],
  supervisors: [{ name: 'watch', host: 'worker', command: ['/bin/sleep', '60'] }]
};
function fixture({ registrationFails = false, launchAmbiguous = false, exitCode = 0 } = {}) {
  const trace = [],
    id = 'a'.repeat(64);
  let released = false,
    registered = [],
    launched = false;
  const client = {
    reserve: async () => ({ id: 'r' }),
    reservation: async () => ({
      id: 'r',
      state: released ? 'released' : 'running',
      authority: 'authority',
      claimId: 'claim',
      generation: 1,
      workloadUnitPrefix: 'accord-prefix-'
    }),
    release: async () => {
      trace.push('release');
      released = true;
    },
    collaborate: async (op, args) => {
      if (op === 'resources')
        return {
          resources: [
            {
              localId: 'gpu',
              externalWorkloads: {
                enabled: true,
                hosts: ['worker'],
                plugins: ['docker-container', 'systemd-user-unit']
              }
            }
          ]
        };
      trace.push(op);
      if (op === 'workload-register') {
        if (registrationFails) throw Error('register unavailable');
        registered = args.targets;
        return { workloads: args.targets.map((target, i) => ({ id: String(i), target })) };
      }
      if (op === 'workload-launch') {
        assert.equal(registered.length, 2);
        if (launchAmbiguous && !launched) {
          launched = args.key;
          throw Error('lost reply');
        }
        if (launched && typeof launched === 'string') {
          assert.equal(args.key, launched);
          launched = true;
        }
        return {};
      }
    }
  };
  const execute = async (host, args) => {
    trace.push(args.slice(0, 2).join(' '));
    if (args[0] === 'docker' && args[1] === 'create') return id;
    if (args[1] === 'inspect') return JSON.stringify({ Running: false, ExitCode: exitCode });
    if (args[1] === 'rm') assert(released);
    return '';
  };
  return { client, execute, trace };
}
test('normal launch registers complete set, retries same launch key, then releases before cleanup', async () => {
  const f = fixture({ launchAmbiguous: true });
  const result = await runWorkload(plan, { ...f, pollMs: 1 });
  assert.equal(result.state, 'released');
  assert(f.trace.indexOf('workload-register') < f.trace.indexOf('workload-launch'));
  assert(f.trace.indexOf('release') < f.trace.indexOf('docker rm'));
});
test('failed registration never starts a container or supervisor and requests release', async () => {
  const f = fixture({ registrationFails: true });
  await assert.rejects(runWorkload(plan, { ...f }), /register unavailable/);
  assert(!f.trace.includes('workload-launch'));
  assert(f.trace.includes('release'));
  assert(!f.trace.includes('docker rm'));
});
test('nonzero workload exit propagates after requesting release; retains stopped objects for inspection', async () => {
  const f = fixture({ exitCode: 2 });
  await assert.rejects(runWorkload(plan, { ...f }), /unsuccessfully/);
  assert(f.trace.includes('release'));
  assert(!f.trace.includes('docker rm'));
});
test('identity and restart overrides are rejected before any effect', () => {
  for (const args of [
    ['--restart', 'always'],
    ['--label', 'accord.claim=other'],
    ['--name', 'collision']
  ])
    assert.throws(() => validateWorkloadPlan({ ...plan, containers: [{ ...plan.containers[0], args }] }));
});
test('unapproved host is rejected before reservation or creation', async () => {
  const f = fixture();
  await assert.rejects(
    runWorkload({ ...plan, containers: [{ ...plan.containers[0], host: 'other' }] }, f),
    /not approved/
  );
  assert.deepEqual(f.trace, []);
});

test('one failed rank releases the group while another rank is still running', async () => {
  const f = fixture();
  const execute = async (host, args) =>
    args[1] === 'inspect'
      ? JSON.stringify(host === 'worker' ? { Running: false, ExitCode: 1 } : { Running: true, ExitCode: 0 })
      : f.execute(host, args);
  const collaborate = f.client.collaborate;
  f.client.collaborate = async (...args) => {
    const result = await collaborate(...args);
    if (args[0] === 'resources') result.resources[0].externalWorkloads.hosts.push('peer');
    return result;
  };
  await assert.rejects(
    runWorkload(
      {
        ...plan,
        supervisors: [],
        containers: [plan.containers[0], { ...plan.containers[0], name: 'peer', host: 'peer' }]
      },
      { ...f, execute }
    ),
    /unsuccessfully/
  );
  assert(f.trace.includes('release'));
});

test('distributed training options retain launcher-owned identity and lifecycle', () => {
  validateWorkloadPlan({
    ...plan,
    containers: [
      {
        ...plan.containers[0],
        args: [
          '--init',
          '--ipc',
          'host',
          '--device',
          '/dev/infiniband',
          '--cap-add',
          'IPC_LOCK',
          '--ulimit',
          'memlock=-1:-1',
          '--memory-swap',
          '70g',
          '--cpuset-cpus',
          '5-9'
        ]
      }
    ]
  });
  assert.throws(() =>
    validateWorkloadPlan({ ...plan, containers: [{ ...plan.containers[0], args: ['--init', '--restart', 'always'] }] })
  );
});

test('a job on two Sparks reserves them in sorted order and registers each container under its own hold', async () => {
  const trace = [];
  const id = (n) => String(n).repeat(64);
  let created = 0;
  const holds = { 'authority/spark04': 'r4', 'authority/spark03': 'r3' };
  const released = new Set();
  const client = {
    reserve: async (address) => {
      trace.push('reserve ' + address);
      return { id: holds[address] };
    },
    reservation: async (reservationId) => ({
      id: reservationId,
      state: released.has(reservationId) ? 'released' : 'running',
      authority: 'authority',
      claimId: 'claim-' + reservationId,
      generation: 1,
      workloadUnitPrefix: 'accord-' + reservationId + '-'
    }),
    release: async (reservationId) => {
      trace.push('release ' + reservationId);
      released.add(reservationId);
    },
    collaborate: async (op, args) => {
      if (op === 'resources')
        return {
          resources: ['spark03', 'spark04'].map((localId) => ({
            localId,
            externalWorkloads: { enabled: true, hosts: [localId], plugins: ['docker-container', 'systemd-user-unit'] }
          }))
        };
      if (op === 'workload-register') {
        trace.push(`register ${args.id} ${args.targets.map((t) => t.host).join(',')}`);
        return { workloads: args.targets.map((target, i) => ({ id: args.id + i, target })) };
      }
      if (op === 'workload-launch') trace.push('launch ' + args.id);
      if (op === 'renew') return {};
      return {};
    }
  };
  const execute = async (host, args) => {
    if (args[1] === 'create') {
      assert(args.includes('accord.claim=claim-' + (host === 'spark03' ? 'r3' : 'r4')), 'labelled with its own hold');
      return id(++created);
    }
    if (args[1] === 'inspect') return JSON.stringify({ Running: false, ExitCode: 0 });
    return '';
  };
  const result = await runWorkload(
    {
      schema: 1,
      resources: ['authority/spark04', 'authority/spark03'],
      containers: [
        { name: 'rank1', host: 'spark04', image: 'cached', command: ['/bin/true'] },
        { name: 'rank0', host: 'spark03', image: 'cached', command: ['/bin/true'] }
      ]
    },
    { client, execute, pollMs: 1 }
  );
  assert.deepEqual(result.reservationIds, ['r3', 'r4']);
  const at = (step) => trace.indexOf(step);
  assert(at('reserve authority/spark03') < at('reserve authority/spark04'), 'Sparks are acquired in sorted order');
  assert(at('register r3 spark03') >= 0 && at('register r4 spark04') >= 0);
  assert(Math.max(at('register r3 spark03'), at('register r4 spark04')) < at('launch r3'), 'register all, then launch');
  assert(at('release r4') < at('release r3'), 'the last hold taken is released first');
});

test('a plan names one authority and no Spark twice', () => {
  const base = { schema: 1, containers: plan.containers };
  for (const bad of [
    { resource: 'authority/a', resources: ['authority/b'] },
    { resources: ['authority/a', 'other/b'] },
    { resources: ['authority/a', 'authority/a'] },
    { resources: [] }
  ])
    assert.throws(() => validateWorkloadPlan({ ...base, ...bad }), /authority/);
  validateWorkloadPlan({ ...base, resources: ['authority/a', 'authority/b'] });
});
