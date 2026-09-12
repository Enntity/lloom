import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTask, codexArgs, validateTask, releaseLocks } from '../clients/examples/research-workers/runner.mjs';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

function fixture(t, behavior = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lloom-worker-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(cwd);
  const fake = path.join(root, 'fake-codex');
  fs.writeFileSync(
    fake,
    `#!${process.execPath}\nimport fs from 'node:fs';\nlet prompt='';for await(const c of process.stdin)prompt+=c;\nconst args=process.argv;const cwd=args[args.indexOf('-C')+1];\nconst marker=cwd+'/attempt';const n=fs.existsSync(marker)?Number(fs.readFileSync(marker))+1:1;fs.writeFileSync(marker,String(n));\nconsole.log(JSON.stringify({type:'item.started',item:{id:'shell1',type:'command_execution'}}));\n${behavior}\nfs.writeFileSync(args[args.indexOf('-o')+1],'Claimed success');\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:3}}));\n`,
    { mode: 0o700 }
  );
  // Extensionless Node scripts inherit this ESM scope.
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const task = {
    id: 'test',
    role: 'implementer',
    cwd,
    prompt: 'Synthetic bounded task',
    timeoutSeconds: 10,
    attempts: 2,
    checks: []
  };
  const options = {
    stateRoot: path.join(root, 'state'),
    codexCommand: fake,
    env: { PATH: process.env.PATH, LLOOM_API_KEY: 'synthetic', LLOOM_BASE_URL: 'http://127.0.0.1:1/v1' }
  };
  return { root, cwd, task, options };
}
test('profiles pin DS/GLM, disable native delegation and reject unsafe task inputs', (t) => {
  const { task } = fixture(t);
  for (const [role, model] of [
    ['implementer', 'deepseek-flash'],
    ['reviewer', 'cloud/openrouter/glm53f']
  ]) {
    const args = codexArgs({ ...task, role }, 'http://127.0.0.1:8100/v1', '/tmp/report');
    assert.equal(args[args.indexOf('-m') + 1], model);
    assert.ok(args.includes('agents.enabled=false'));
    assert.ok(args.includes('features.multi_agent=false'));
    assert.ok(args.includes('approval_policy="never"'));
  }
  assert.throws(() => validateTask({ ...task, id: '../escape' }));
  assert.throws(() => validateTask({ ...task, attempts: 100 }));
  assert.throws(() => validateTask({ ...task, role: 'gpt' }));
  assert.throws(() => codexArgs(task, 'https://user:secret@example.com/v1', '/tmp/report'));
});
test(
  'a worker success claim cannot bypass a failing check; second attempt repairs it',
  { timeout: 10000 },
  async (t) => {
    const { task, options, cwd } = fixture(t, "fs.writeFileSync(cwd+'/value',n===1?'wrong':'correct');");
    task.checks = [
      {
        name: 'correctness',
        argv: [process.execPath, '-e', "if(require('fs').readFileSync('value','utf8')!=='correct')process.exit(7)"]
      }
    ];
    const result = await runTask(task, options);
    assert.equal(result.status, 'passed');
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].checks[0].code, 7);
    assert.equal(result.attempts[1].checks[0].code, 0);
    assert.equal(fs.readFileSync(path.join(cwd, 'attempt'), 'utf8'), '2');
    assert.equal(result.attempts[0].toolCalls, 1);
    await assert.rejects(runTask(task, options), /already exists/);
  }
);
test('no checks means needs_review, never passed', async (t) => {
  const { task, options } = fixture(t);
  assert.equal((await runTask(task, options)).status, 'needs_review');
});
test('protected verification tampering blocks further attempts', async (t) => {
  const { task, options, cwd } = fixture(t, "fs.writeFileSync(cwd+'/oracle','tampered');");
  fs.writeFileSync(path.join(cwd, 'oracle'), 'original');
  task.protectedFiles = ['oracle'];
  await assert.rejects(runTask(task, options), /Protected verification/);
  const state = JSON.parse(fs.readFileSync(path.join(options.stateRoot, task.id, 'status.json')));
  assert.equal(state.status, 'blocked');
  assert.equal(state.attempts.length, 1);
});
test('failed workers exhaust bounded attempts and cannot reset allowance with resume', async (t) => {
  const { task, options } = fixture(t, 'process.exit(9);');
  assert.equal((await runTask(task, options)).status, 'failed');
  await assert.rejects(runTask(task, { ...options, resume: true }), /budget exhausted/);
});
test('shared hardware resource serializes independent workspaces', { timeout: 10000 }, async (t) => {
  const { task, options, root } = fixture(
    t,
    "fs.writeFileSync(cwd+'/start',String(Date.now()));await new Promise(r=>setTimeout(r,300));fs.writeFileSync(cwd+'/end',String(Date.now()));"
  );
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  const [a, b] = await Promise.all([
    runTask({ ...task, id: 'first', resources: ['sparks'] }, options),
    runTask({ ...task, id: 'second', cwd: other, resources: ['sparks'] }, options)
  ]);
  assert.equal(a.status, 'needs_review');
  assert.equal(b.status, 'needs_review');
  const ranges = [task.cwd, other]
    .map((p) => [Number(fs.readFileSync(path.join(p, 'start'))), Number(fs.readFileSync(path.join(p, 'end')))])
    .sort((x, y) => x[0] - y[0]);
  assert.ok(ranges[1][0] >= ranges[0][1]);
});
test('stop signal cancels the worker and preserves a resumable job', { timeout: 10000 }, async (t) => {
  const { task, options, cwd } = fixture(t, 'if(n===1)await new Promise(r=>setTimeout(r,20000));');
  const pending = runTask(task, options);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(cwd, 'attempt')); i++)
    await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(options.stateRoot, task.id, 'stop'), 'stop');
  assert.equal((await pending).status, 'stopped');
  const resumed = await runTask(task, { ...options, resume: true });
  assert.equal(resumed.status, 'needs_review');
  assert.equal(resumed.attempts.length, 2);
});

test('three independent jobs never exceed two worker slots', { timeout: 10000 }, async (t) => {
  const { task, options, root } = fixture(
    t,
    "fs.writeFileSync(cwd+'/start',String(Date.now()));await new Promise(r=>setTimeout(r,350));fs.writeFileSync(cwd+'/end',String(Date.now()));"
  );
  const dirs = [task.cwd, path.join(root, 'p2'), path.join(root, 'p3')];
  for (const p of dirs.slice(1)) fs.mkdirSync(p);
  await Promise.all(dirs.map((cwd, i) => runTask({ ...task, id: `slot-test-${i}`, cwd }, options)));
  const events = dirs
    .flatMap((p) => [
      { time: Number(fs.readFileSync(path.join(p, 'start'))), delta: 1 },
      { time: Number(fs.readFileSync(path.join(p, 'end'))), delta: -1 }
    ])
    .sort((a, b) => a.time - b.time || a.delta - b.delta);
  let active = 0;
  for (const e of events) {
    active += e.delta;
    assert.ok(active <= 2);
  }
});
test('tool overflow is stopped, quarantined, and cannot start another attempt', { timeout: 5000 }, async (t) => {
  const { task, options } = fixture(
    t,
    "console.log(JSON.stringify({type:'item.started',item:{id:'shell2',type:'command_execution'}}));await new Promise(r=>setTimeout(r,10000));"
  );
  // A worker stopped by the parent (callback_stop) is an abnormal termination:
  // with explicit resources the job ends blocked and keeps its locks instead of
  // spending another attempt on possibly still-busy hardware.
  const result = await runTask({ ...task, attempts: 2, maxToolCalls: 1, resources: ['sparks'] }, options);
  assert.equal(result.status, 'blocked');
  assert.equal(result.attempts[0].process.reason, 'callback_stop');
  assert.equal(result.attempts.length, 1);
  assert.ok(result.quarantinedResources.includes('resource-sparks'));
});
test('state cannot live in the worker checkout and role prototypes are invalid', (t) => {
  const { task, options } = fixture(t);
  assert.throws(() => validateTask({ ...task, role: '__proto__' }), /role/);
  return assert.rejects(runTask(task, { ...options, stateRoot: path.join(task.cwd, 'state') }), /outside/);
});
test('dead explicit resource owner is retained until verified release', async (t) => {
  const { task, options } = fixture(t);
  const locks = path.join(options.stateRoot, 'locks');
  fs.mkdirSync(locks, { recursive: true });
  fs.writeFileSync(
    path.join(locks, 'resource-sparks.lock'),
    JSON.stringify({ pid: 99999999, token: 'dead', taskId: 'crashed-task' })
  );
  // A dead explicit-resource owner is not proof of a clean hardware state, so
  // the lock must not be auto-reaped by an unrelated task.
  await assert.rejects(
    runTask({ ...task, id: 'waiter', resources: ['sparks'], timeoutSeconds: 1, attempts: 1 }, options),
    /Stopped while waiting for resource/
  );
  assert.deepEqual(fs.readdirSync(locks), ['resource-sparks.lock']);
  assert.throws(() => releaseLocks(options.stateRoot, 'crashed-task'), /Verified cleanup flag/);
  // The dead-but-foreign lock is retained; a verified release is only honored
  // for a task whose persisted state still owns the exact lock token.
  assert.equal(alive(99999999), false);
  assert.deepEqual(releaseLocks(options.stateRoot, 'waiter', { verifiedCleanup: true }).released, []);
  assert.deepEqual(fs.readdirSync(locks), ['resource-sparks.lock']);
});

test('timeout quarantines explicit resources until verified release, then unblocks the next task', async (t) => {
  const { task, options } = fixture(t, 'if(n===1)await new Promise(r=>setTimeout(r,30000));');
  const result = await runTask(
    { ...task, id: 'timed', resources: ['sparks'], timeoutSeconds: 1, attempts: 1 },
    options
  );
  assert.equal(result.status, 'timed_out');
  assert.equal(result.attempts[0].process.reason, 'timeout');
  assert.ok(result.quarantinedResources.includes('resource-sparks'));
  const locks = path.join(options.stateRoot, 'locks');
  assert.ok(fs.existsSync(path.join(locks, 'resource-sparks.lock')));
  // Workspace and slot locks are released normally even on timeout.
  assert.deepEqual(
    fs.readdirSync(locks).filter((f) => f.startsWith('slot-') || f.startsWith('cwd-')),
    []
  );
  // A competing task cannot take the quarantined resource.
  const { task: other, options: otherOptions, root } = fixture(t);
  const otherCwd = path.join(root, 'other');
  fs.mkdirSync(otherCwd);
  await assert.rejects(
    runTask(
      { ...other, id: 'blocked', cwd: otherCwd, resources: ['sparks'], timeoutSeconds: 1, attempts: 1 },
      { ...otherOptions, stateRoot: options.stateRoot, env: options.env }
    ),
    /Stopped while waiting for resource/
  );
  assert.deepEqual(fs.readdirSync(locks), ['resource-sparks.lock']);
  // Missing flag fails.
  await assert.rejects(async () => releaseLocks(options.stateRoot, 'timed'), /Verified cleanup flag/);
  assert.throws(() => releaseLocks(options.stateRoot, 'timed'), /Verified cleanup flag/);
  const released = releaseLocks(options.stateRoot, 'timed', { verifiedCleanup: true });
  assert.deepEqual(released.released, result.quarantinedResources);
  assert.deepEqual(fs.readdirSync(locks), []);
  // The next task can now acquire the resource.
  const next = await runTask(
    { ...other, id: 'next', cwd: otherCwd, resources: ['sparks'], attempts: 1 },
    { ...otherOptions, stateRoot: options.stateRoot, env: options.env }
  );
  assert.equal(next.status, 'needs_review');
});

test('ordinary explicit resource success releases held locks', async (t) => {
  const { task, options } = fixture(t);
  const state = await runTask({ ...task, resources: ['sparks'] }, options);
  assert.equal(state.status, 'needs_review');
  assert.deepEqual(fs.readdirSync(path.join(options.stateRoot, 'locks')), []);
});

test('protected path cannot hide a replaceable symlink behind its target hash', (t) => {
  const { task, cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, 'oracle'), 'original');
  fs.symlinkSync('oracle', path.join(cwd, 'check'));
  assert.throws(() => validateTask({ ...task, protectedFiles: ['check'] }), /symlinks/);
});

test('zero-exit worker with empty final file and no turn.completed is never passed', { timeout: 10000 }, async (t) => {
  const { task, options } = fixture(
    t,
    "fs.writeFileSync(args[args.indexOf('-o')+1],'');console.log(JSON.stringify({type:'turn.failed'}));process.exit(0);"
  );
  task.checks = [{ name: 'always-ok', argv: [process.execPath, '-e', 'process.exit(0)'] }];
  const result = await runTask(task, options);
  assert.notEqual(result.status, 'passed');
  assert.equal(result.status, 'failed');
  assert.equal(result.attempts.length, 2, 'both bounded attempts should be consumed');
  assert.equal(result.attempts[0].report, '');
  assert.notEqual(result.attempts[0].completedTurn, true);
  assert.deepEqual(result.attempts[0].checks, [], 'a passing parent check must not run without a completed turn');
});

test(
  'timeout budget admits only one attempt and does not launch a 1ms second attempt',
  { timeout: 10000 },
  async (t) => {
    const { task, options, cwd } = fixture(t, 'if(n===1)await new Promise(r=>setTimeout(r,30000));');
    const result = await runTask({ ...task, timeoutSeconds: 1, attempts: 2 }, options);
    assert.equal(result.status, 'timed_out');
    assert.equal(result.attempts.length, 1, 'only one attempt should be allocated');
    assert.equal(result.attempts[0].process.reason, 'timeout');
    assert.equal(fs.readFileSync(path.join(cwd, 'attempt'), 'utf8'), '1');
  }
);

test(
  'abnormal parent check result quarantines explicit resources and blocks further attempts',
  { timeout: 10000 },
  async (t) => {
    const { task, options, cwd } = fixture(t, "fs.writeFileSync(cwd+'/ran-'+n,'yes');");
    task.checks = [{ name: 'hang', argv: [process.execPath, '-e', 'setTimeout(()=>{},30000)'], timeoutSeconds: 1 }];
    const result = await runTask({ ...task, id: 'check-abnormal', resources: ['sparks'], attempts: 2 }, options);
    // The parent check timed out: its `reason` must set quarantine, and an
    // explicit-resource job must not spend a second attempt on that hardware.
    assert.equal(result.attempts.length, 1, 'no retry after an abnormal check with explicit resources');
    assert.equal(result.attempts[0].checks[0].reason, 'timeout');
    assert.equal(result.status, 'blocked');
    assert.ok(['sparks', 'resource-sparks'].some((n) => result.quarantinedResources.includes(n)));
    assert.ok(fs.existsSync(path.join(options.stateRoot, 'locks', 'resource-sparks.lock')));
    // No second attempt was launched.
    assert.equal(fs.existsSync(path.join(cwd, 'ran-2')), false);
    // Workspace and slot locks are not retained.
    assert.deepEqual(
      fs
        .readdirSync(path.join(options.stateRoot, 'locks'))
        .filter((f) => f.startsWith('slot-') || f.startsWith('cwd-')),
      []
    );
    // Verified release unblocks the hardware and rejects a concurrently active run.
    const statePath = path.join(options.stateRoot, 'check-abnormal', 'status.json');
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const active = { ...saved, status: 'running', attempts: saved.attempts };
    delete active.finishedAt;
    fs.writeFileSync(statePath, JSON.stringify(active));
    assert.throws(() => releaseLocks(options.stateRoot, 'check-abnormal', { verifiedCleanup: true }), /still active/);
    fs.writeFileSync(statePath, JSON.stringify(saved));
    const released = releaseLocks(options.stateRoot, 'check-abnormal', { verifiedCleanup: true });
    assert.deepEqual(released.released, ['resource-sparks']);
    assert.ok(!fs.existsSync(path.join(options.stateRoot, 'locks', 'resource-sparks.lock')));
  }
);

test('release refuses a live foreign owner lock and a swapped lock token', async (t) => {
  const { task, options } = fixture(t);
  const locks = path.join(options.stateRoot, 'locks');
  fs.mkdirSync(locks, { recursive: true });
  // Simulate a crashed run that persisted ownership before dying abnormally.
  fs.writeFileSync(path.join(locks, 'resource-sparks.lock'), JSON.stringify({ token: 'mine', taskId: 'holder' }));
  const root = path.join(options.stateRoot, 'holder');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'status.json'),
    JSON.stringify({
      id: 'holder',
      status: 'blocked',
      finishedAt: new Date().toISOString(),
      heldResources: ['resource-sparks'],
      resourceTokens: { 'resource-sparks': 'mine' }
    })
  );
  // A live owner lock (held by a concurrent run) is the serialization authority
  // even when the persisted state looks finished.
  fs.writeFileSync(
    path.join(root, 'owner.lock'),
    JSON.stringify({ pid: process.pid, token: 'live', taskId: 'holder' })
  );
  assert.throws(() => releaseLocks(options.stateRoot, 'holder', { verifiedCleanup: true }), /owner lock is held/);
  assert.ok(fs.existsSync(path.join(root, 'owner.lock')), 'the live owner lock is never stolen by release');
  fs.unlinkSync(path.join(root, 'owner.lock'));
  // A lock whose token no longer matches this task's persisted ownership belongs
  // to another run and must not be released.
  fs.writeFileSync(path.join(locks, 'resource-sparks.lock'), JSON.stringify({ token: 'foreign', taskId: 'holder' }));
  assert.throws(() => releaseLocks(options.stateRoot, 'holder', { verifiedCleanup: true }), /owned by another run/);
  fs.writeFileSync(path.join(locks, 'resource-sparks.lock'), JSON.stringify({ token: 'mine', taskId: 'holder' }));
  assert.deepEqual(releaseLocks(options.stateRoot, 'holder', { verifiedCleanup: true }), {
    id: 'holder',
    released: ['resource-sparks']
  });
  assert.deepEqual(fs.readdirSync(locks), []);
  // releaseLocks must not have resumed or otherwise claimed the task lock.
  assert.ok(!fs.existsSync(path.join(root, 'owner.lock')));
});

test('a valid 80-character resource name is still an explicit quarantined resource', { timeout: 10000 }, async (t) => {
  const name = `r${'x'.repeat(79)}`;
  assert.equal(name.length, 80);
  const { task, options } = fixture(t, 'if(n===1)await new Promise(r=>setTimeout(r,30000));');
  const result = await runTask({ ...task, id: 'longname', resources: [name], timeoutSeconds: 1, attempts: 1 }, options);
  assert.equal(result.status, 'timed_out');
  assert.equal(result.attempts[0].process.reason, 'timeout');
  const lockName = `resource-${name}`;
  assert.ok(result.quarantinedResources.includes(lockName), 'long valid name must be treated as explicit');
  const locks = path.join(options.stateRoot, 'locks');
  assert.ok(fs.existsSync(path.join(locks, `${lockName}.lock`)));
  const released = releaseLocks(options.stateRoot, 'longname', { verifiedCleanup: true });
  assert.deepEqual(released.released, [lockName]);
  assert.deepEqual(fs.readdirSync(locks), []);
});

test('quarantined lock is not stale-reaped and its owner is not resumed while held', async (t) => {
  const { task, options } = fixture(t);
  const locks = path.join(options.stateRoot, 'locks');
  fs.mkdirSync(locks, { recursive: true });
  fs.writeFileSync(
    path.join(locks, 'resource-sparks.lock'),
    JSON.stringify({ pid: 4242, token: 'held', taskId: 'held-by-dead' })
  );
  await assert.rejects(
    runTask({ ...task, id: 'contender', resources: ['sparks'], timeoutSeconds: 1, attempts: 1 }, options),
    /Stopped while waiting for resource/
  );
  assert.deepEqual(fs.readdirSync(locks), ['resource-sparks.lock']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(locks, 'resource-sparks.lock'), 'utf8')), {
    pid: 4242,
    token: 'held',
    taskId: 'held-by-dead'
  });
});

test('verified release recovers a crashed owner and rejects missing ownership tokens', async (t) => {
  const { options } = fixture(t);
  const root = path.join(options.stateRoot, 'crashed');
  const locks = path.join(options.stateRoot, 'locks');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(locks, { recursive: true });
  const owner = { pid: 99999999, token: 'crashed-token', taskId: 'crashed' };
  const state = { id: 'crashed', pid: 99999999, status: 'running', heldResources: ['resource-sparks'] };
  fs.writeFileSync(path.join(root, 'owner.lock'), JSON.stringify(owner));
  fs.writeFileSync(path.join(locks, 'resource-sparks.lock'), JSON.stringify(owner));
  fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify(state));
  assert.throws(() => releaseLocks(options.stateRoot, 'crashed', { verifiedCleanup: true }), /owned by another run/);
  assert.ok(fs.existsSync(path.join(locks, 'resource-sparks.lock')));
  state.resourceTokens = { 'resource-sparks': 'crashed-token' };
  fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify(state));
  assert.deepEqual(releaseLocks(options.stateRoot, 'crashed', { verifiedCleanup: true }).released, ['resource-sparks']);
});
