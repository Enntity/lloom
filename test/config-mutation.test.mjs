import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mutateConfigSource } from '../src/config-mutation.mjs';
import { loadConfig } from '../src/config.mjs';

const okValidate = async () => {};
const directories = [];
after(async () => {
  await Promise.all(directories.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tmpFile(contents, mode = 0o600) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgmut-'));
  directories.push(dir);
  const p = path.join(dir, 'config.json');
  await fs.writeFile(p, contents, { mode });
  return p;
}

// A minimal config that satisfies the real loadConfig schema, mirroring the
// shape the source loader expects.
const MINIMAL_VALID_CONFIG = {
  models: [{ id: 'm1', runtime: 'rt1', backend: 'test' }],
  runtimes: {
    rt1: { command: 'echo' }
  },
  backends: { test: { type: 'openai', baseUrl: 'http://127.0.0.1:12345/v1' } },
  aliases: {}
};

test('concurrent different mutators preserve both changes', async () => {
  const p = await tmpFile('{"a":1,"b":2}\n');
  await Promise.all([
    mutateConfigSource(
      { sourcePath: p },
      (o) => {
        o.a = 10;
      },
      { validate: okValidate }
    ),
    mutateConfigSource(
      { sourcePath: p },
      (o) => {
        o.b = 20;
      },
      { validate: okValidate }
    )
  ]);
  const out = JSON.parse(await fs.readFile(p, 'utf8'));
  assert.equal(out.a, 10);
  assert.equal(out.b, 20);
});

test('failed mutation does not poison later operation', async () => {
  const p = await tmpFile('{"a":1}\n');
  await assert.rejects(
    mutateConfigSource(
      { sourcePath: p },
      () => {
        throw new Error('boom');
      },
      { validate: okValidate }
    )
  );
  await mutateConfigSource(
    { sourcePath: p },
    (o) => {
      o.a = 2;
    },
    { validate: okValidate }
  );
  assert.equal(JSON.parse(await fs.readFile(p, 'utf8')).a, 2);
});

test('invalid candidate preserves original and removes temp', async () => {
  const p = await tmpFile('{"a":1}\n');
  const bad = async () => {
    throw new Error('invalid');
  };
  await assert.rejects(
    mutateConfigSource(
      { sourcePath: p },
      (o) => {
        o.a = 9;
      },
      { validate: bad }
    )
  );
  assert.equal(await fs.readFile(p, 'utf8'), '{"a":1}\n');
  const leftovers = (await fs.readdir(path.dirname(p))).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('external write during validation causes refusal, preserves external bytes', async () => {
  const p = await tmpFile('{"a":1}\n');
  const external = '{"external":true}\n';
  const slow = async () => {
    await fs.writeFile(p, external);
  };
  await assert.rejects(
    mutateConfigSource(
      { sourcePath: p },
      (o) => {
        o.a = 2;
      },
      { validate: slow }
    )
  );
  assert.equal(await fs.readFile(p, 'utf8'), external);
});

test('raw env placeholder remains literal while expanded input ignored', async () => {
  const raw = '{"token":"${SECRET_TOKEN}","a":1}\n';
  const p = await tmpFile(raw);
  const expanded = { sourcePath: p, token: 'leaked-real-value', a: 1 };
  await mutateConfigSource(
    expanded,
    (o) => {
      o.a = 2;
    },
    { validate: okValidate }
  );
  const out = JSON.parse(await fs.readFile(p, 'utf8'));
  assert.equal(out.token, '${SECRET_TOKEN}');
  assert.equal(out.a, 2);
});

test('source mode 0600 retained', async () => {
  const p = await tmpFile('{"a":1}\n', 0o600);
  await mutateConfigSource(
    { sourcePath: p },
    (o) => {
      o.a = 2;
    },
    { validate: okValidate }
  );
  const st = await fs.stat(p);
  assert.equal(st.mode & 0o777, 0o600);
});

test('no-op does not call validator', async () => {
  const p = await tmpFile('{"a":1}\n');
  let called = 0;
  const v = async () => {
    called += 1;
  };
  const r = await mutateConfigSource({ sourcePath: p }, (o) => o, { validate: v });
  assert.deepEqual(r, { changed: false });
  assert.equal(called, 0);
  assert.equal(await fs.readFile(p, 'utf8'), '{"a":1}\n');
});

test('missing source rejects', async () => {
  await assert.rejects(
    mutateConfigSource({ sourcePath: '/nonexistent/definitely-missing.json' }, (o) => o, { validate: okValidate })
  );
});

test('async mutator rejects', async () => {
  const p = await tmpFile('{"a":1}\n');
  await assert.rejects(
    mutateConfigSource(
      { sourcePath: p },
      async (o) => {
        o.a = 2;
      },
      { validate: okValidate }
    )
  );
  assert.equal(await fs.readFile(p, 'utf8'), '{"a":1}\n');
});

test('in-place mutation with no return value serializes mutated object', async () => {
  const p = await tmpFile('{"a":1}\n');
  await mutateConfigSource(
    { sourcePath: p },
    (o) => {
      o.a = 42;
    },
    { validate: okValidate }
  );
  assert.equal(await fs.readFile(p, 'utf8'), '{\n  "a": 42\n}\n');
});

test('mutator returning assigned primitive still serializes object', async () => {
  const p = await tmpFile('{"a":1}\n');
  await mutateConfigSource(
    { sourcePath: p },
    (o) => {
      o.a = 7;
      return 7;
    },
    { validate: okValidate }
  );
  assert.equal(await fs.readFile(p, 'utf8'), '{\n  "a": 7\n}\n');
});

test('mutator returning same object with real change is detected', async () => {
  const p = await tmpFile('{"a":1}\n');
  const r = await mutateConfigSource(
    { sourcePath: p },
    (o) => {
      o.a = 2;
      return o;
    },
    { validate: okValidate }
  );
  assert.deepEqual(r, { changed: true });
  assert.equal(JSON.parse(await fs.readFile(p, 'utf8')).a, 2);
});

test('no-op mutator returning undefined preserves original formatting', async () => {
  const original = '{ "a": 1 }\n';
  const p = await tmpFile(original);
  const r = await mutateConfigSource({ sourcePath: p }, () => undefined, { validate: okValidate });
  assert.deepEqual(r, { changed: false });
  assert.equal(await fs.readFile(p, 'utf8'), original);
});

test('write failure cleans up temp file', async () => {
  const p = await tmpFile('{"a":1}\n');
  const origOpen = fs.open;
  // Mock fs.open so the returned handle is a real FileHandle wrapping a real
  // file descriptor, then patch writeFile on that actual instance to throw
  // exactly once. Patching the shared prototype is avoided.
  fs.open = async function (...args) {
    const fh = await origOpen.apply(this, args);
    if (typeof fh.writeFile === 'function') {
      fh.writeFile = async function () {
        const err = new Error('no space left on device');
        err.code = 'ENOSPC';
        throw err;
      };
    }
    return fh;
  };
  try {
    await assert.rejects(
      mutateConfigSource(
        { sourcePath: p },
        (o) => {
          o.a = 2;
        },
        { validate: okValidate }
      ),
      /no space left on device/
    );
    const leftovers = (await fs.readdir(path.dirname(p))).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
    assert.equal(await fs.readFile(p, 'utf8'), '{"a":1}\n');
  } finally {
    fs.open = origOpen;
  }
});

test('source mode 0640 retained under umask 0077', async () => {
  const p = await tmpFile('{"a":1}\n', 0o640);
  const prevUmask = process.umask(0o077);
  try {
    await mutateConfigSource(
      { sourcePath: p },
      (o) => {
        o.a = 2;
      },
      { validate: okValidate }
    );
  } finally {
    process.umask(prevUmask);
  }
  const st = await fs.stat(p);
  assert.equal(st.mode & 0o777, 0o640);
});

test('symlink refuses', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfgmut-'));
  directories.push(dir);
  const target = path.join(dir, 'real.json');
  const link = path.join(dir, 'link.json');
  await fs.writeFile(target, '{"a":1}\n');
  await fs.symlink(target, link);
  await assert.rejects(
    mutateConfigSource(
      { sourcePath: link },
      (o) => {
        o.a = 2;
      },
      { validate: okValidate }
    )
  );
  assert.equal(await fs.readFile(target, 'utf8'), '{"a":1}\n');
  assert.ok((await fs.lstat(link)).isSymbolicLink());
});

test('default loadConfig validation accepts a minimal valid config', async () => {
  // Mutating the config while relying on the real loadConfig as the default
  // validator ensures the produced candidate passes schema validation.
  const p = await tmpFile(JSON.stringify(MINIMAL_VALID_CONFIG, null, 2) + '\n');
  const r = await mutateConfigSource({ sourcePath: p }, (o) => {
    o.models[0].runtime = 'rt1';
  });
  assert.deepEqual(r, { changed: false });
  // A real change must also validate through the default validator.
  const r2 = await mutateConfigSource({ sourcePath: p }, (o) => {
    o.aliases = { a1: { members: ['m1'] } };
  });
  assert.deepEqual(r2, { changed: true });
  const written = JSON.parse(await fs.readFile(p, 'utf8'));
  assert.deepEqual(written.aliases, { a1: { members: ['m1'] } });
  // Sanity check that our fixture is genuinely valid for the real loader.
  const cfg = await loadConfig(p);
  assert.ok(cfg);
});

test('default loadConfig validation rejects an invalid candidate', async () => {
  const p = await tmpFile(JSON.stringify(MINIMAL_VALID_CONFIG, null, 2) + '\n');
  await assert.rejects(
    mutateConfigSource({ sourcePath: p }, (o) => {
      o.models[0].backend = 'missing';
    })
  );
  const after = JSON.parse(await fs.readFile(p, 'utf8'));
  assert.ok(Array.isArray(after.models));
});

test('exclusive temp open failure never removes a file it did not create', async () => {
  const sourcePath = await tmpFile('{"a":1}');
  const open = fs.open;
  let conflicting;
  fs.open = async (name, ...args) => {
    conflicting = name;
    await fs.writeFile(name, 'another writer');
    return open(name, ...args);
  };
  try {
    await assert.rejects(
      mutateConfigSource(
        { sourcePath },
        (raw) => {
          raw.a = 2;
        },
        { validate: okValidate }
      ),
      { code: 'EEXIST' }
    );
    assert.equal(await fs.readFile(conflicting, 'utf8'), 'another writer');
    assert.equal(await fs.readFile(sourcePath, 'utf8'), '{"a":1}');
  } finally {
    fs.open = open;
  }
});
