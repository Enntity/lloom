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
