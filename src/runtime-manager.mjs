import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultShimDirFor } from './backend-catalog.mjs';
import { cleanupPortListener, terminateProcessTree } from './process-control.mjs';

function nowIso() {
  return new Date().toISOString();
}

const MTPLX_SESSION_CACHE_FLAGS = new Set([
  '--ssd-session-cache',
  '--ssd-session-cache-dir',
  '--ssd-session-cache-max-size',
  '--ssd-session-cache-min-prefix-tokens'
]);

const LLAMA_CPP_SESSION_CACHE_FLAGS = new Set([
  '--cache-prompt',
  '--no-cache-prompt',
  '--cache-reuse',
  '--slot-save-path'
]);

function compactRuntime(runtimeId, runtime) {
  if (!runtime) return null;
  return {
    enabled: runtime.enabled === true,
    keepWarm: runtime.keepWarm === true,
    maxConcurrency: runtimeMaxConcurrency(runtime),
    command: runtime.command,
    args: runtime.args,
    effectiveArgs: effectiveRuntimeArgs(runtimeId, runtime),
    cwd: runtime.cwd,
    port: runtime.port,
    healthUrl: runtime.healthUrl,
    startupTimeoutMs: runtime.startupTimeoutMs,
    sessionCache: runtime.sessionCache ?? null
  };
}

async function healthOk(url, timeoutMs = 1500) {
  if (!url) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function runtimeMaxConcurrency(runtime) {
  const value = Number(runtime?.maxConcurrency ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function commandName(command) {
  return command ? path.basename(String(command)) : '';
}

function runtimeAdapter(runtime) {
  const explicit = runtime?.adapter ?? runtime?.runtimeAdapter ?? runtime?.backendKind;
  if (explicit) return String(explicit).toLowerCase();
  const command = commandName(runtime?.command).toLowerCase();
  if (command === 'mtplx') return 'mtplx';
  if (command === 'llama-server') return 'llama-cpp';
  return null;
}

function runtimeEnvironment(config, runtime) {
  const shimDir = config?.paths?.shimDir ?? defaultShimDirFor();
  return {
    ...process.env,
    PATH: `${shimDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
    ...(runtime.env ?? {})
  };
}

function sessionCacheKind(cache, runtime) {
  const explicit = cache?.kind ?? cache?.type ?? cache?.adapter;
  if (explicit) return String(explicit).toLowerCase();
  const adapter = runtimeAdapter(runtime);
  if (adapter === 'mtplx') return 'mtplx-ssd-session';
  if (adapter === 'llama-cpp') return 'llama-cpp-kv-cache';
  return null;
}

function hasAnyFlag(args, flags) {
  return args.some((arg) => flags.has(arg));
}

function mtplxSessionCacheArgs(runtimeId, runtime, cache) {
  const args = Array.isArray(runtime.args) ? runtime.args : [];
  if (hasAnyFlag(args, MTPLX_SESSION_CACHE_FLAGS)) return [];

  const mode = cache.mode ?? (cache.enabled === false ? 'off' : 'on');
  if (!['off', 'on', 'write-only'].includes(mode)) {
    throw new Error(`runtime ${runtimeId} sessionCache.mode must be off, on, or write-only`);
  }

  const result = ['--ssd-session-cache', mode];
  if (mode === 'off') return result;

  if (cache.dir) result.push('--ssd-session-cache-dir', String(cache.dir));
  if (cache.maxSize) result.push('--ssd-session-cache-max-size', String(cache.maxSize));
  if (cache.minPrefixTokens != null) {
    result.push('--ssd-session-cache-min-prefix-tokens', String(cache.minPrefixTokens));
  }
  return result;
}

function llamaCppSessionCacheArgs(runtimeId, runtime, cache) {
  const args = Array.isArray(runtime.args) ? runtime.args : [];
  if (hasAnyFlag(args, LLAMA_CPP_SESSION_CACHE_FLAGS)) return [];

  const mode = cache.mode ?? (cache.enabled === false ? 'off' : 'on');
  if (!['off', 'on', 'write-only'].includes(mode)) {
    throw new Error(`runtime ${runtimeId} sessionCache.mode must be off, on, or write-only`);
  }

  if (mode === 'off') return ['--no-cache-prompt'];
  if (mode === 'write-only') {
    return ['--cache-prompt', '--slot-save-path', String(cache.dir)];
  }
  return [
    '--cache-prompt',
    '--cache-reuse',
    String(cache.minPrefixTokens ?? 256),
    '--slot-save-path',
    String(cache.dir)
  ];
}

function sessionCacheDirectory(runtime) {
  const cache = runtime?.sessionCache;
  if (!cache?.dir) return null;
  const mode = cache.mode ?? (cache.enabled === false ? 'off' : 'on');
  if (mode === 'off') return null;
  const dir = String(cache.dir);
  if (path.isAbsolute(dir)) return dir;
  return path.resolve(runtime?.cwd ?? process.cwd(), dir);
}

async function prepareRuntimeFilesystem(runtime) {
  const dir = sessionCacheDirectory(runtime);
  if (dir) await fs.mkdir(dir, { recursive: true });
}

function sessionCacheArgs(runtimeId, runtime) {
  const cache = runtime?.sessionCache;
  if (!cache) return [];

  const kind = sessionCacheKind(cache, runtime);
  if (kind === 'mtplx-ssd-session' || kind === 'mtplx') {
    return mtplxSessionCacheArgs(runtimeId, runtime, cache);
  }
  if (kind === 'llama-cpp-kv-cache' || kind === 'llama-cpp') {
    return llamaCppSessionCacheArgs(runtimeId, runtime, cache);
  }

  throw new Error(
    `runtime ${runtimeId} sessionCache is not supported by adapter ${runtimeAdapter(runtime) ?? 'unknown'}`
  );
}

export function effectiveRuntimeArgs(runtimeId, runtime) {
  return [...(Array.isArray(runtime?.args) ? runtime.args : []), ...sessionCacheArgs(runtimeId, runtime)];
}

export class RuntimeManager {
  constructor(config, { logger = console, captureOutput = true } = {}) {
    this.config = config;
    this.logger = logger;
    this.captureOutput = captureOutput;
    this.processes = new Map();
    this.state = new Map();
    this.queues = new Map();
    this.lifecycleQueues = new Map();
    this.admissionQueue = Promise.resolve();
    this.events = [];
  }

  stateFor(runtimeId) {
    if (!this.state.has(runtimeId)) {
      this.state.set(runtimeId, {
        status: 'idle',
        starts: 0,
        stops: 0,
        activeRequests: 0,
        queuedRequests: 0,
        startedAt: null,
        stoppedAt: null,
        lastWarmup: null,
        lastError: null,
        lastStderr: null
      });
    }
    return this.state.get(runtimeId);
  }

  record(event) {
    this.events.unshift({
      at: nowIso(),
      ...event
    });
    this.events = this.events.slice(0, 100);
  }

  getRuntime(runtimeId) {
    return this.config.runtimes?.[runtimeId] ?? null;
  }

  keepWarmRuntimeIds() {
    return [
      ...new Set([
        ...(this.config.keepWarm ?? []),
        ...Object.entries(this.config.runtimes ?? {})
          .filter(([, runtime]) => runtime.keepWarm === true)
          .map(([runtimeId]) => runtimeId)
      ])
    ];
  }

  processRunning(runtimeId) {
    const child = this.processes.get(runtimeId);
    return Boolean(child?.pid && child.exitCode == null && child.signalCode == null);
  }

  queueFor(runtimeId) {
    if (!this.queues.has(runtimeId)) this.queues.set(runtimeId, []);
    return this.queues.get(runtimeId);
  }

  withAdmissionLock(fn) {
    const run = this.admissionQueue.catch(() => {}).then(fn);
    this.admissionQueue = run.catch(() => {});
    return run;
  }

  withRuntimeLifecycleLock(runtimeId, fn) {
    if (!runtimeId) return fn();
    const previous = this.lifecycleQueues.get(runtimeId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    this.lifecycleQueues.set(
      runtimeId,
      run.catch(() => {})
    );
    return run;
  }

  async status() {
    const runtimes = {};
    const keepWarm = new Set(this.keepWarmRuntimeIds());
    for (const [runtimeId, runtime] of Object.entries(this.config.runtimes ?? {})) {
      const state = this.stateFor(runtimeId);
      const process = this.processes.get(runtimeId);
      const healthy = await healthOk(runtime.healthUrl);
      let status = state.status;
      if (this.processRunning(runtimeId)) {
        status = healthy ? 'running' : 'starting';
      } else if (healthy) {
        status = 'external';
      }
      runtimes[runtimeId] = {
        ...compactRuntime(runtimeId, runtime),
        pid: process?.pid ?? null,
        healthy,
        status,
        keepWarm: keepWarm.has(runtimeId),
        starts: state.starts,
        stops: state.stops,
        activeRequests: state.activeRequests,
        queuedRequests: state.queuedRequests,
        startedAt: state.startedAt,
        stoppedAt: state.stoppedAt,
        lastWarmup: state.lastWarmup,
        lastError: state.lastError
      };
    }
    return {
      runtimes,
      events: this.events
    };
  }

  async withSlot(runtimeId, fn) {
    const release = await this.acquireSlot(runtimeId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  acquireSlot(runtimeId) {
    if (!runtimeId) return () => {};
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) return () => {};
    const state = this.stateFor(runtimeId);
    const maxConcurrency = runtimeMaxConcurrency(runtime);
    if (state.activeRequests < maxConcurrency) {
      state.activeRequests += 1;
      return () => this.releaseSlot(runtimeId);
    }
    const queue = this.queueFor(runtimeId);
    state.queuedRequests = queue.length + 1;
    return new Promise((resolve) => {
      queue.push(resolve);
    });
  }

  releaseSlot(runtimeId) {
    const state = this.stateFor(runtimeId);
    state.activeRequests = Math.max(0, state.activeRequests - 1);
    const queue = this.queueFor(runtimeId);
    const next = queue.shift();
    state.queuedRequests = queue.length;
    if (!next) return;
    state.activeRequests += 1;
    next(() => this.releaseSlot(runtimeId));
  }

  async ensure(runtimeId) {
    return this.start(runtimeId, {
      force: false,
      warmup: true,
      reason: 'model-request'
    });
  }

  async start(runtimeId, { force = false, warmup = true, reason = 'manual-start' } = {}) {
    return this.withRuntimeLifecycleLock(runtimeId, () =>
      this.startUnlocked(runtimeId, {
        force,
        warmup,
        reason
      })
    );
  }

  async startUnlocked(runtimeId, { force = false, warmup = true, reason = 'manual-start' } = {}) {
    if (!runtimeId) return { runtimeId, started: false, reason: 'no-runtime' };
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) return { runtimeId, started: false, reason: 'unknown-runtime' };
    const state = this.stateFor(runtimeId);

    if (await healthOk(runtime.healthUrl)) {
      state.status = 'running';
      const warmupResult = warmup ? await this.warmup(runtimeId, runtime) : null;
      return {
        runtimeId,
        started: false,
        healthy: true,
        reason: 'already-healthy',
        ...(warmupResult ? { warmup: warmupResult } : {})
      };
    }

    if (runtime.enabled !== true && !force) {
      return { runtimeId, started: false, healthy: false, reason: 'runtime-disabled' };
    }

    if (!runtime.command) {
      throw new Error(`runtime ${runtimeId} is enabled but has no command`);
    }

    const existing = this.processes.get(runtimeId);
    if (existing && existing.exitCode == null) {
      return this.waitForHealth(runtimeId, runtime, existing);
    }

    state.status = 'starting';
    state.lastError = null;
    const args = effectiveRuntimeArgs(runtimeId, runtime);
    await prepareRuntimeFilesystem(runtime);
    // Pipe stderr always so Metal/backend aborts leave a trail in gateway events.
    // stdout only when captureOutput is enabled (can be noisy).
    const child = spawn(runtime.command, args, {
      cwd: runtime.cwd,
      env: runtimeEnvironment(this.config, runtime),
      stdio: ['ignore', this.captureOutput ? 'pipe' : 'ignore', 'pipe'],
      detached: true
    });
    child.unref();
    this.processes.set(runtimeId, child);
    state.starts += 1;
    state.startedAt = nowIso();
    this.record({ runtimeId, event: 'start', pid: child.pid, reason, force, effectiveArgs: args });

    if (this.captureOutput) {
      child.stdout?.on('data', (chunk) => {
        const line = String(chunk).trim();
        if (line) this.record({ runtimeId, event: 'stdout', message: line.slice(0, 500) });
      });
    }
    child.stderr?.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (!line) return;
      this.record({ runtimeId, event: 'stderr', message: line.slice(0, 800) });
      // Keep last stderr snippet for doctor/status after Metal abort etc.
      state.lastStderr = line.slice(0, 800);
    });
    child.on('error', (error) => {
      state.status = 'failed';
      state.lastError = error?.message ?? String(error);
      this.record({ runtimeId, event: 'error', message: state.lastError });
    });
    child.on('exit', (code, signal) => {
      const expectedStop = state.status === 'stopping' || ['SIGTERM', 'SIGKILL'].includes(signal);
      state.status = code === 0 || expectedStop ? 'stopped' : 'failed';
      state.stoppedAt = nowIso();
      const base = state.status === 'stopped' ? null : `process exited code=${code} signal=${signal ?? ''}`.trim();
      state.lastError = base
        ? state.lastStderr
          ? `${base}; stderr=${state.lastStderr}`
          : base
        : null;
      this.record({ runtimeId, event: 'exit', code, signal, lastError: state.lastError });
      // Drop dead handle so the next ensure()/start can relaunch.
      if (this.processes.get(runtimeId) === child) {
        this.processes.delete(runtimeId);
      }
    });

    const result = await this.waitForHealth(runtimeId, runtime, child);
    let warmupResult = null;
    if (result.healthy && warmup && runtime.warmup) {
      warmupResult = await this.warmup(runtimeId, runtime);
    }
    return {
      ...result,
      started: true,
      pid: child.pid,
      ...(warmupResult ? { warmup: warmupResult } : {})
    };
  }

  async waitForHealth(runtimeId, runtime, child = null) {
    const state = this.stateFor(runtimeId);
    const deadline = Date.now() + (runtime.startupTimeoutMs ?? 300000);
    while (Date.now() < deadline) {
      if (await healthOk(runtime.healthUrl)) {
        state.status = 'running';
        this.record({ runtimeId, event: 'healthy' });
        return { runtimeId, healthy: true };
      }
      if (child && child.exitCode != null) {
        const message = `runtime ${runtimeId} exited before becoming healthy`;
        state.status = 'failed';
        state.lastError = message;
        throw new Error(message);
      }
      await delay(500);
    }
    state.status = 'failed';
    state.lastError = `runtime ${runtimeId} did not become healthy before timeout`;
    throw new Error(`runtime ${runtimeId} did not become healthy before timeout`);
  }

  async warmupById(runtimeId) {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) return { runtimeId, warmed: false, reason: 'unknown-runtime' };
    if (!(await healthOk(runtime.healthUrl))) {
      const result = { runtimeId, warmed: false, reason: 'not-healthy' };
      this.stateFor(runtimeId).lastWarmup = result;
      return result;
    }
    return this.warmup(runtimeId, runtime);
  }

  async warmup(runtimeId, runtime) {
    const state = this.stateFor(runtimeId);
    const warmup = runtime.warmup;
    if (!warmup?.url) return { runtimeId, warmed: false, reason: 'no-warmup' };
    const startedAt = Date.now();
    try {
      const response = await fetch(warmup.url, {
        method: warmup.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...(warmup.headers ?? {})
        },
        body: warmup.body ? JSON.stringify(warmup.body) : undefined
      });
      const text = await response.text().catch(() => '');
      const result = {
        runtimeId,
        warmed: response.ok,
        status: response.status,
        latencyMs: Date.now() - startedAt
      };
      state.lastWarmup = result;
      this.record({
        ...result,
        event: 'warmup',
        bodyPreview: text.slice(0, 300)
      });
      return result;
    } catch (error) {
      const result = {
        runtimeId,
        warmed: false,
        latencyMs: Date.now() - startedAt,
        error: error?.message ?? String(error)
      };
      state.lastWarmup = result;
      this.record({ ...result, event: 'warmup' });
      return result;
    }
  }

  async startKeepWarm() {
    const results = [];
    for (const runtimeId of this.keepWarmRuntimeIds()) {
      const runtime = this.getRuntime(runtimeId);
      if (!runtime) {
        results.push({ runtimeId, started: false, reason: 'unknown-runtime' });
        continue;
      }
      if (runtime.enabled !== true) {
        results.push({ runtimeId, started: false, reason: 'runtime-disabled' });
        continue;
      }
      results.push(
        await this.start(runtimeId, {
          force: false,
          warmup: true,
          reason: 'keep-warm'
        })
      );
    }
    return results;
  }

  async stop(runtimeId) {
    return this.withRuntimeLifecycleLock(runtimeId, () => this.stopUnlocked(runtimeId));
  }

  async stopUnlocked(runtimeId) {
    const runtime = this.getRuntime(runtimeId);
    const state = this.stateFor(runtimeId);
    const child = this.processes.get(runtimeId);
    let processResult = null;
    if (child?.pid) {
      state.status = 'stopping';
      processResult = await terminateProcessTree([child.pid]);
      this.processes.delete(runtimeId);
    }
    let portResult = null;
    if (runtime?.port) {
      portResult = await cleanupPortListener(runtime.port);
    }
    state.status = 'stopped';
    state.stops += 1;
    state.stoppedAt = nowIso();
    this.record({ runtimeId, event: 'stop', processResult, portResult });
    return {
      runtimeId,
      stopped: true,
      processResult,
      portResult
    };
  }
}
