import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntimeMemoryUsageSampler } from '../src/runtime-memory-usage.mjs';

const KiB = 1024;

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body)
  };
}

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    advance(amount) {
      value += amount;
    }
  };
}

function sampler(options = {}) {
  const calls = { ps: 0, listeners: 0, fetches: [] };
  return {
    calls,
    sampler: createRuntimeMemoryUsageSampler({
      fetchImpl: options.fetchImpl ?? null,
      clock: options.clock,
      scheduleTimeout: () => 0,
      cacheTtlMs: options.cacheTtlMs ?? 5000,
      footprintReader: async () => ({}),
      ...options,
      nowIso: () => new Date(options.clock?.now?.() ?? 0).toISOString(),
      psReader: async () => {
        calls.ps++;
        return options.psReader ? options.psReader() : '';
      },
      listenerReader: async () => {
        calls.listeners++;
        return options.listenerReader ? options.listenerReader() : '';
      }
    })
  };
}

test('parses one unique process tree from listener fallback', async () => {
  const { calls, sampler: usage } = sampler({
    psReader: async () => ['  101     1       100', '  102   101        50', '  103   102        20'].join('\n'),
    listenerReader: async () => 'lloom  101  user  12u  IPv4 100  TCP 127.0.0.1:8201 (LISTEN)'
  });
  const result = await usage.sample({
    runtimes: { runtime: { id: 'runtime', status: 'running', port: 8201 } },
    runtimeIds: ['runtime']
  });
  assert.equal(result.runtime.residentBytes, 170 * KiB);
  assert.equal(result.runtime.groupId, 'proc:101');
  assert.deepEqual(result.runtime.sharedRuntimeIds, ['runtime']);
  assert.equal(result.runtime.loadedModelIds, null);
  assert.equal(result.runtime.residencyKnown, false);
  assert.match(result.runtime.sampledAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls.ps, 1);
  assert.equal(calls.listeners, 1);
});

test('shared runtimes are grouped and their process tree is counted once', async () => {
  const { sampler: usage } = sampler({
    psReader: async () => ['  101     1        50', '  102   101        25'].join('\n'),
    listenerReader: async () => 'a 101 1u TCP 127.0.0.1:8201 (LISTEN)'
  });
  const runtimes = {
    a: { id: 'a', status: 'running', port: 8201 },
    b: { id: 'b', status: 'running', port: 8201 }
  };
  const result = await usage.sample({ runtimes, runtimeIds: ['b', 'a'] });
  assert.equal(result.a.residentBytes, 75 * KiB);
  assert.equal(result.b.residentBytes, 75 * KiB);
  assert.equal(result.a.groupId, 'proc:101');
  assert.equal(result.b.groupId, 'proc:101');
  assert.deepEqual(result.a.sharedRuntimeIds, ['a', 'b']);
  assert.deepEqual(result.b.sharedRuntimeIds, ['a', 'b']);
});

test('shared backend observations use one residency request', async () => {
  const fetches = [];
  const { sampler: usage } = sampler({
    psReader: async () => '  101     1        80',
    listenerReader: async () => 'ollama 101 1u TCP localhost:11434 (LISTEN)',
    fetchImpl: async (url) => {
      fetches.push(url.toString());
      return response({ models: [{ model: 'llama3' }, { name: 'qwen' }] });
    }
  });
  const result = await usage.sample({
    runtimes: {
      a: { id: 'a', status: 'running', command: 'ollama', port: 8201, healthUrl: 'http://localhost:8201' },
      b: { id: 'b', status: 'running', command: 'ollama', port: 8201, healthUrl: 'http://localhost:8201' }
    },
    runtimeIds: ['a', 'b']
  });
  assert.deepEqual([...fetches], ['http://localhost:8201/api/ps']);
  assert.deepEqual(result.a.loadedModelIds, ['llama3', 'qwen']);
  assert.deepEqual(result.b.loadedModelIds, ['llama3', 'qwen']);
  assert.equal(result.a.residencyKnown, true);
});

test('confirmed empty Ollama residency stays empty and is known', async () => {
  const { sampler: usage } = sampler({
    psReader: async () => '',
    listenerReader: async () => '',
    fetchImpl: async () => response({ models: [] })
  });
  const result = await usage.sample({
    runtimes: { ollama: { id: 'ollama', status: 'running', command: '/usr/local/bin/ollama', port: 8201 } },
    runtimeIds: ['ollama']
  });
  assert.equal(result.ollama.residentBytes, null);
  assert.deepEqual(result.ollama.loadedModelIds, []);
  assert.equal(result.ollama.residencyKnown, true);
});

test('audio server residency reads only its configured loopback health endpoint', async () => {
  const fetches = [];
  const { sampler: usage } = sampler({
    psReader: async () => '',
    listenerReader: async () => '',
    fetchImpl: async (url) => {
      fetches.push(url.toString());
      return response({ tts_loaded: [{ id: 'voice' }], stt_loaded: ['ears'] });
    }
  });
  const result = await usage.sample({
    runtimes: {
      audio: {
        id: 'audio',
        status: 'running',
        command: '/usr/local/bin/lloom-audio-server',
        healthUrl: 'http://127.0.0.1:8300/'
      }
    },
    runtimeIds: ['audio']
  });
  assert.deepEqual(fetches, ['http://127.0.0.1:8300/health']);
  assert.deepEqual(result.audio.loadedModelIds, ['ears', 'voice']);
});

test('sampling failures and failed residency calls remain unknown and do not throw', async () => {
  const { sampler: usage } = sampler({
    psReader: async () => {
      throw new Error('ps failed');
    },
    listenerReader: async () => {
      throw new Error('lsof failed');
    },
    fetchImpl: async () => {
      throw new Error('model endpoint failed');
    }
  });
  const result = await usage.sample({
    runtimes: { ollama: { id: 'ollama', status: 'running', command: 'ollama', port: 8201 } },
    runtimeIds: ['ollama']
  });
  assert.equal(result.ollama.residentBytes, null);
  assert.equal(result.ollama.loadedModelIds, null);
  assert.equal(result.ollama.residencyKnown, false);
});

test('concurrent samples share the process and residency caches', async () => {
  const clock = fakeClock();
  const { calls, sampler: usage } = sampler({
    clock,
    psReader: async () => '  101     1        20',
    listenerReader: async () => 'a 101 1u TCP 127.0.0.1:8201 (LISTEN)',
    fetchImpl: async () => response({ models: [] })
  });
  const request = { runtimes: { a: { id: 'a', status: 'running', command: 'ollama', port: 8201 } }, runtimeIds: ['a'] };
  const [first, second] = await Promise.all([usage.sample(request), usage.sample(request)]);
  assert.deepEqual(first, second);
  assert.equal(calls.ps, 1);
  assert.equal(calls.listeners, 1);
});

test('cached samples expire after the configured TTL', async () => {
  const clock = fakeClock();
  const { calls, sampler: usage } = sampler({
    clock,
    psReader: async () => '  101     1        20',
    listenerReader: async () => ''
  });
  const request = { runtimes: { a: { id: 'a', status: 'running', pid: 101 } }, runtimeIds: ['a'] };
  await usage.sample(request);
  clock.advance(4999);
  await usage.sample(request);
  clock.advance(1);
  await usage.sample(request);
  assert.equal(calls.ps, 2);
  assert.equal(calls.listeners, 2);
});

test('remote and distributed runtimes are not attributed locally', async () => {
  const { calls, sampler: usage } = sampler({
    psReader: async () => '  101     1        20',
    listenerReader: async () => ''
  });
  const result = await usage.sample({
    runtimes: {
      remote: { id: 'remote', remote: true, node: 'node-b', status: 'running', pid: 101 },
      distributed: { id: 'distributed', distributed: true, status: 'running', pid: 101 }
    },
    runtimeIds: ['remote', 'distributed']
  });
  assert.deepEqual(result, {});
  assert.equal(calls.ps, 0);
  assert.equal(calls.listeners, 0);
});

test('Docker container PIDs are used only on Linux; macOS VM memory stays unattributed', async () => {
  const processRows = '   999       1        30\n   201       1        10';
  const listeners = 'docker 201 1u TCP 127.0.0.1:8201 (LISTEN)';
  const runtimes = {
    docker: {
      id: 'docker',
      status: 'running',
      adapter: 'docker',
      container: { pid: 999 },
      port: 8201
    }
  };
  const darwin = sampler({
    platform: 'darwin',
    psReader: async () => processRows,
    listenerReader: async () => listeners
  });
  const darwinResult = await darwin.sampler.sample({ runtimes, runtimeIds: ['docker'] });
  assert.equal(darwinResult.docker.residentBytes, null);

  const linux = sampler({
    platform: 'linux',
    psReader: async () => processRows,
    listenerReader: async () => listeners
  });
  const linuxResult = await linux.sampler.sample({ runtimes, runtimeIds: ['docker'] });
  assert.equal(linuxResult.docker.residentBytes, 40 * KiB);
});

test('lazy model calls are not made for unconfigured or remote hosts', async () => {
  const fetches = [];
  const { sampler: usage } = sampler({
    psReader: async () => '',
    listenerReader: async () => '',
    fetchImpl: async (url) => {
      fetches.push(url.toString());
      return response({ models: [] });
    }
  });
  const result = await usage.sample({
    runtimes: {
      remote: { id: 'remote', remote: true, command: 'ollama', port: 8201 },
      external: {
        id: 'external',
        status: 'running',
        command: 'ollama',
        port: 8202,
        healthUrl: 'https://example.invalid'
      }
    },
    runtimeIds: ['remote', 'external']
  });
  assert.deepEqual(fetches, []);
  assert.equal(result.external.loadedModelIds, null);
});

test('overlapping parent and child ownership is one memory group', async () => {
  const { sampler: usage } = sampler({
    psReader: async () => '101 1 20\n102 101 40\n103 102 10'
  });
  const result = await usage.sample({
    runtimes: {
      parent: { status: 'running', pid: 101 },
      child: { status: 'running', pid: 102 }
    },
    runtimeIds: ['child', 'parent']
  });
  assert.equal(result.parent.groupId, result.child.groupId);
  assert.equal(result.parent.residentBytes, 70 * KiB);
  assert.deepEqual(result.parent.sharedRuntimeIds, ['child', 'parent']);
});

test('malformed residency is unknown even when process memory is known', async () => {
  const { sampler: usage } = sampler({
    psReader: async () => '101 1 20',
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, 'error');
      return response({ ok: true });
    }
  });
  const result = await usage.sample({
    runtimes: { a: { pid: 101, status: 'running', command: 'ollama', port: 8201 } },
    runtimeIds: ['a']
  });
  assert.equal(result.a.residentBytes, 20 * KiB);
  assert.equal(result.a.loadedModelIds, null);
  assert.equal(result.a.residencyKnown, false);
});

test('a slow residency endpoint is aborted and becomes unknown', async () => {
  const usage = createRuntimeMemoryUsageSampler({
    psReader: async () => '',
    listenerReader: async () => '',
    modelTimeoutMs: 20,
    scheduleTimeout: (callback, ms) => setTimeout(callback, ms),
    fetchImpl: async (_url, { signal }) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  });
  const result = await usage.sample({
    runtimes: { a: { status: 'running', command: 'ollama', port: 8201 } },
    runtimeIds: ['a']
  });
  assert.equal(result.a.residencyKnown, false);
});

test('routing status avoids dashboard-only sampling', async () => {
  const { RuntimeManager } = await import('../src/runtime-manager.mjs');
  let calls = 0;
  const manager = new RuntimeManager(
    { runtimes: { a: { enabled: false } }, models: [], cluster: {} },
    {
      memoryUsageSampler: {
        sample: async () => {
          calls++;
          return { a: { residentBytes: 12 } };
        }
      }
    }
  );
  await manager.status();
  assert.equal(calls, 0);
  const status = await manager.status({ includeMemoryUsage: true });
  assert.equal(calls, 1);
  assert.equal(status.runtimes.a.memoryUsage.residentBytes, 12);
});

test('Darwin footprint includes charged memory omitted by RSS and falls back cleanly', async () => {
  const request = { runtimes: { a: { status: 'running', pid: 101 } }, runtimeIds: ['a'] };
  const measured = sampler({
    platform: 'darwin',
    psReader: async () => '101 1 20',
    footprintReader: async () => ({ 101: 8 * 1024 ** 3 })
  });
  const result = await measured.sampler.sample(request);
  assert.equal(result.a.residentBytes, 8 * 1024 ** 3);
  assert.equal(result.a.source, 'process-footprint');
  const fallback = sampler({
    platform: 'darwin',
    psReader: async () => '101 1 20',
    footprintReader: async () => {
      throw Error('unavailable');
    }
  });
  const absent = await fallback.sampler.sample(request);
  assert.equal(absent.a.residentBytes, 20 * 1024);
  assert.equal(absent.a.source, 'process-rss');
});

test('an endpoint that ignores abort cannot hold status forever', async () => {
  const usage = createRuntimeMemoryUsageSampler({
    psReader: async () => '',
    listenerReader: async () => '',
    modelTimeoutMs: 10,
    fetchImpl: async () => new Promise(() => {})
  });
  const result = await usage.sample({
    runtimes: { a: { status: 'running', command: 'ollama', port: 8201 } },
    runtimeIds: ['a']
  });
  assert.equal(result.a.residencyKnown, false);
});

test('runtime status exposes inherited maintenance to the dashboard', async () => {
  const { RuntimeManager } = await import('../src/runtime-manager.mjs');
  const manager = new RuntimeManager({
    cluster: {},
    models: [],
    runtimes: {
      a: { enabled: false },
      group: {
        enabled: false,
        placement: { mode: 'distributed', members: [{ runtime: 'a' }] },
        maintenance: { state: 'suspended' }
      }
    }
  });
  const result = await manager.status();
  assert.equal(result.runtimes.a.maintenance.state, 'suspended');
});
