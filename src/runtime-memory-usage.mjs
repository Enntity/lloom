import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const LSOF = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';
const MAX_MODEL_BODY_BYTES = 64 * 1024;

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function commandBasename(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return (
    String(first ?? '')
      .trim()
      .split(/\s+/)[0]
      .split(/[\\/]/)
      .pop() ?? ''
  );
}

function loopbackHostname(hostname) {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(String(hostname ?? '').toLowerCase());
}

function loopbackUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? (loopbackHostname(url.hostname) ? url : null) : null;
  } catch {
    return null;
  }
}

function endpointUrl(runtime, path = '/') {
  const configured = loopbackUrl(runtime?.healthUrl);
  if (runtime?.healthUrl && !configured) return null;
  if (configured) {
    if (path === '/') return configured;
    const url = new URL(configured);
    url.pathname = path;
    url.search = '';
    url.hash = '';
    return url;
  }
  const port = positiveInteger(runtime?.port);
  return port ? new URL(`http://127.0.0.1:${port}${path.startsWith('/') ? path : `/${path}`}`) : null;
}

function parseProcessRows(text) {
  const rows = new Map();
  for (const match of String(text ?? '').matchAll(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/gm)) {
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (pid > 0 && ppid >= 0) rows.set(pid, { pid, ppid, rss: Number(match[3]) * 1024 });
  }
  return [...rows.values()];
}

function parseLoopbackListeners(text) {
  const listeners = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*\S+\s+(\d+)\s+.*?\sTCP\s+(\S+)\s*(?:\(\s*LISTEN\s*\))?$/i);
    if (!match) continue;
    const pid = Number(match[1]);
    const address = match[2];
    const separator = address.lastIndexOf(':');
    if (!Number.isInteger(pid) || pid <= 0 || separator < 1) continue;
    const host = address.slice(0, separator);
    const port = Number(address.slice(separator + 1));
    if (!loopbackHostname(host) || !positiveInteger(port)) continue;
    if (!listeners.has(port)) listeners.set(port, new Set());
    listeners.get(port).add(pid);
  }
  return listeners;
}

function expandProcessTree(rootPids, rowsByPid) {
  const selected = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rowsByPid ?? []) {
      if (selected.has(row.ppid) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return [...selected];
}

function boundedText(response, maxBytes) {
  const stream = response?.body;
  if (stream && typeof stream.getReader === 'function') {
    return (async () => {
      const reader = stream.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value?.byteLength ?? value?.length ?? 0;
          if (bytes > maxBytes) throw new Error('memory usage response too large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    })();
  }
  return response.text().then((text) => {
    if (Buffer.byteLength(text) > maxBytes) throw new Error('memory usage response too large');
    return text;
  });
}

function extractLoadedModelIds(payload, kind) {
  if (payload == null || typeof payload !== 'object') throw new Error('unexpected model response');
  if (kind === 'ollama') {
    if (!Array.isArray(payload.models)) throw new Error('missing model residency list');
    return (Array.isArray(payload.models) ? payload.models : [])
      .map((item) => (typeof item === 'string' ? item : (item?.model ?? item?.name ?? item?.id)))
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => value.trim());
  }
  if (!Array.isArray(payload.tts_loaded) || !Array.isArray(payload.stt_loaded))
    throw new Error('missing audio residency lists');
  const values = [
    ...(Array.isArray(payload.tts_loaded) ? payload.tts_loaded : []),
    ...(Array.isArray(payload.stt_loaded) ? payload.stt_loaded : [])
  ];
  return values
    .map((value) => (typeof value === 'string' ? value : (value?.id ?? value?.name ?? value?.model)))
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
}

export function createRuntimeMemoryUsageSampler({
  nodeId = null,
  platform = process.platform,
  psReader = async () => {
    const result = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {
      timeout: 1000,
      maxBuffer: 2 * 1024 * 1024
    });
    return result.stdout;
  },
  listenerReader = async () => {
    const result = await execFileAsync(LSOF, ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      timeout: 1000,
      maxBuffer: 2 * 1024 * 1024
    });
    return result.stdout;
  },
  footprintReader = async (pids) => {
    const result = await execFileAsync(
      'python3',
      [fileURLToPath(new URL('./darwin-memory-usage.py', import.meta.url)), ...pids.map(String)],
      { timeout: 1000, maxBuffer: 2 * 1024 * 1024 }
    );
    return JSON.parse(result.stdout);
  },
  fetchImpl = globalThis.fetch,
  clock = Date.now,
  nowIso = () => new Date().toISOString(),
  scheduleTimeout = (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    timer.unref?.();
    return timer;
  },
  cacheTtlMs = 5000,
  modelTimeoutMs = 500
} = {}) {
  const now = typeof clock?.now === 'function' ? clock.now.bind(clock) : (clock ?? Date.now);
  let processInFlight = null;
  let processCache = null;
  const modelInFlight = new Map();
  const modelCache = new Map();

  async function readProcessSnapshot() {
    const at = now();
    if (processCache && at < processCache.expiresAt) return processCache.value;
    if (processInFlight) return processInFlight;
    processInFlight = Promise.allSettled([psReader(), listenerReader()])
      .then(async ([ps, lsof]) => {
        const value = {
          rows: ps.status === 'fulfilled' ? parseProcessRows(ps.value) : [],
          listeners: lsof.status === 'fulfilled' ? parseLoopbackListeners(lsof.value) : new Map(),
          processOk: ps.status === 'fulfilled',
          listenerOk: lsof.status === 'fulfilled'
        };
        if (platform === 'darwin' && value.rows.length) {
          try {
            const footprints = await footprintReader(value.rows.map((row) => row.pid));
            for (const row of value.rows) {
              const bytes = footprints?.[row.pid];
              if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) row.footprint = bytes;
            }
          } catch {
            /* Python or per-process accounting may be unavailable; retain RSS. */
          }
        }
        processCache = { value, expiresAt: at + cacheTtlMs };
        return value;
      })
      .finally(() => {
        processInFlight = null;
      });
    return processInFlight;
  }

  async function readModelIds(url, kind) {
    const key = url.toString();
    const at = now();
    const cached = modelCache.get(key);
    if (cached && at < cached.expiresAt) return cached.value;
    const inFlight = modelInFlight.get(key);
    if (inFlight) return inFlight;
    const request = (async () => {
      let timer = null;
      let signal = null;
      if (typeof AbortController === 'function' && modelTimeoutMs > 0) {
        const controller = new AbortController();
        signal = controller.signal;
        timer = scheduleTimeout(() => controller.abort(new Error('model residency request timed out')), modelTimeoutMs);
      }
      try {
        const response = await fetchImpl(url, { signal, redirect: 'error' });
        if (!response?.ok) throw new Error(`model residency request failed (${response?.status ?? 'unknown'})`);
        const body = await boundedText(response, MAX_MODEL_BODY_BYTES);
        return extractLoadedModelIds(JSON.parse(body), kind);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })()
      .then(
        (value) => {
          const result = { value, expiresAt: now() + cacheTtlMs };
          modelCache.set(key, result);
          return value;
        },
        () => {
          const result = { value: null, expiresAt: now() + cacheTtlMs };
          modelCache.set(key, result);
          return null;
        }
      )
      .finally(() => {
        modelInFlight.delete(key);
      });
    modelInFlight.set(key, request);
    return request;
  }

  function runtimeRoots(runtime, snapshot) {
    const roots = [];
    const adapter = String(runtime?.adapter ?? '').toLowerCase();
    if (adapter === 'docker') {
      if (platform !== 'linux') return [];
      const pid = positiveInteger(runtime?.containerPid ?? runtime?.container?.pid);
      if (pid) roots.push(pid);
    } else {
      const pid = positiveInteger(runtime?.pid);
      if (pid) roots.push(pid);
    }
    const url = endpointUrl(runtime);
    const port = url ? positiveInteger(url.port || (url.protocol === 'https:' ? 443 : 80)) : null;
    if (port) for (const pid of snapshot.listeners.get(port) ?? []) roots.push(pid);
    return [...new Set(roots)];
  }

  return {
    nodeId,
    async sample({ runtimes = {}, runtimeIds = [] } = {}) {
      if (!runtimeIds.length) return {};
      const ids = [...new Set(runtimeIds)].filter((runtimeId) => {
        const runtime = runtimes[runtimeId];
        return (
          runtime &&
          runtime.remote !== true &&
          runtime.distributed !== true &&
          runtime.placement?.mode !== 'distributed' &&
          (!nodeId ||
            !(runtime.node ?? runtime.placement?.node) ||
            (runtime.node ?? runtime.placement?.node) === nodeId) &&
          ['running', 'external', 'starting', 'warming', 'stopping', 'draining'].includes(runtime.status)
        );
      });
      if (!ids.length) return {};
      const snapshot = await readProcessSnapshot();
      const expansions = new Map();
      const roots = new Map();
      for (const runtimeId of ids) {
        const runtime = runtimes[runtimeId];
        const selectedRoots = runtimeRoots(runtime, snapshot);
        roots.set(runtimeId, selectedRoots);
        expansions.set(runtimeId, expandProcessTree(selectedRoots, snapshot.rows));
      }
      const parent = new Map();
      const find = (pid) => {
        if (!parent.has(pid)) return pid;
        const root = find(parent.get(pid));
        parent.set(pid, root);
        return root;
      };
      const union = (left, right) => {
        const a = find(left);
        const b = find(right);
        if (a === b) return;
        parent.set(b, a);
      };
      for (const pids of expansions.values()) {
        if (pids.length > 1) for (const pid of pids.slice(1)) union(pids[0], pid);
      }
      const groups = new Map();
      for (const runtimeId of ids) {
        const pids = expansions.get(runtimeId) ?? [];
        const groupKey = pids.length ? `proc:${find(pids[0])}` : `runtime:${runtimeId}`;
        if (!groups.has(groupKey)) {
          groups.set(groupKey, { runtimeIds: [], pids: new Set(), urls: [] });
        }
        const group = groups.get(groupKey);
        group.runtimeIds.push(runtimeId);
        for (const pid of pids) group.pids.add(pid);
      }
      const result = {};
      await Promise.all(
        [...groups].map(async ([groupKey, group]) => {
          group.runtimeIds.sort();
          let residentBytes = null;
          const usesFootprint =
            platform === 'darwin' &&
            group.pids.size > 0 &&
            [...group.pids].every((pid) => snapshot.rows.find((row) => row.pid === pid)?.footprint != null);
          let rowsAvailable = snapshot.rows.length > 0;
          if (rowsAvailable && group.pids.size) {
            let sum = 0;
            for (const pid of group.pids) {
              const row = snapshot.rows.find((row) => row.pid === pid);
              if (!row) {
                rowsAvailable = false;
                break;
              }
              sum += usesFootprint ? row.footprint : row.rss;
            }
            if (rowsAvailable) residentBytes = sum;
          }
          const loadedByRuntime = new Map();
          const modelCalls = [];
          for (const runtimeId of group.runtimeIds) {
            const runtime = runtimes[runtimeId];
            loadedByRuntime.set(runtimeId, null);
            const base = commandBasename(runtime.command);
            const audio = [base, ...(runtime.args ?? []).map(commandBasename)].some((part) =>
              ['lloom-audio-server', 'lloom_audio_server.py', 'lloom_audio_server'].includes(part)
            );
            const kind = base === 'ollama' ? 'ollama' : audio ? 'audio' : null;
            if (!kind) continue;
            const url = kind === 'ollama' ? endpointUrl(runtime, '/api/ps') : endpointUrl(runtime, '/health');
            if (!url) continue;
            modelCalls.push(
              readModelIds(url, kind).then((value) => {
                loadedByRuntime.set(runtimeId, value);
              })
            );
          }
          await Promise.all(modelCalls.splice(0, modelCalls.length));
          const knownLists = [...loadedByRuntime.values()].filter((value) => Array.isArray(value));
          const loadedModelIds =
            knownLists.length === group.runtimeIds.length
              ? [...new Set(knownLists.flat())].sort((left, right) => left.localeCompare(right))
              : null;
          const memoryUsage = {
            residentBytes,
            source: usesFootprint ? 'process-footprint' : 'process-rss',
            sampledAt: nowIso(),
            groupId: groupKey,
            sharedRuntimeIds: group.runtimeIds,
            loadedModelIds,
            residencyKnown: loadedModelIds !== null
          };
          for (const runtimeId of group.runtimeIds) result[runtimeId] = { ...memoryUsage };
        })
      );
      return result;
    }
  };
}
