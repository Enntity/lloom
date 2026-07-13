import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultShimDirFor } from './backend-catalog.mjs';
import { cleanupPortListener, terminateProcessTree } from './process-control.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_TEMPLATE_OVERRIDES = new Map([
  ['qwen3-xml-tool-reminder', path.join(packageRoot, 'assets', 'chat-templates', 'qwen3-xml-tool-reminder.jinja')]
]);
const VLLM_CHAT_TEMPLATE_PATH = '/etc/lloom/chat-template.jinja';

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
    sessionCache: runtime.sessionCache ?? null,
    adapter: runtimeAdapter(runtime),
    management: runtime.management ?? (runtime.managed === false ? 'external' : 'managed'),
    containerName: runtime.containerName ?? runtime.container?.name ?? null,
    recipe: runtime.recipe ?? null,
    bootstrap: runtime.bootstrap
      ? {
          configured: true,
          adapter: runtime.bootstrap.adapter ?? runtime.bootstrap.type ?? 'docker',
          image: runtime.bootstrap.image ?? null
        }
      : null,
    cachePersistence: runtimeCacheCapability(runtime)
  };
}

function runtimeManagement(runtime) {
  return runtime?.management ?? (runtime?.managed === false ? 'external' : 'managed');
}

function dockerContainerName(runtime) {
  return runtime?.containerName ?? runtime?.container?.name ?? null;
}

function dockerBootstrap(runtime) {
  const bootstrap = runtime?.bootstrap;
  if (!bootstrap || bootstrap.enabled === false) return null;
  const adapter = String(bootstrap.adapter ?? bootstrap.type ?? 'docker').toLowerCase();
  return adapter === 'docker' ? bootstrap : null;
}

export function runtimeChatTemplateOverride(runtime) {
  const configured = runtime?.behaviorOverrides?.chatTemplate;
  if (!configured) return null;
  const id = typeof configured === 'string' ? configured : configured.id;
  if (!id || !CHAT_TEMPLATE_OVERRIDES.has(id)) {
    throw new Error(`unknown chat template behavior override: ${id || 'missing id'}`);
  }
  return { id, hostPath: CHAT_TEMPLATE_OVERRIDES.get(id), containerPath: VLLM_CHAT_TEMPLATE_PATH };
}

export function dockerCreateArgs(runtime) {
  const bootstrap = dockerBootstrap(runtime);
  if (!bootstrap) return null;
  const name = dockerContainerName(runtime);
  if (!name) throw new Error('docker runtime bootstrap requires containerName or container.name');
  if (!bootstrap.image) throw new Error(`docker runtime ${name} bootstrap requires image`);
  const chatTemplate = runtimeChatTemplateOverride(runtime);
  const command = (Array.isArray(bootstrap.command) ? bootstrap.command : []).map(String);
  if (chatTemplate && !command.includes('--chat-template')) {
    command.push('--chat-template', chatTemplate.containerPath);
  }
  return [
    'create',
    '--name',
    name,
    ...(Array.isArray(bootstrap.createArgs) ? bootstrap.createArgs : []).map(String),
    ...(chatTemplate
      ? ['--mount', `type=bind,src=${chatTemplate.hostPath},dst=${chatTemplate.containerPath},readonly`]
      : []),
    String(bootstrap.image),
    ...command
  ];
}

function runtimeCacheCapability(runtime) {
  const kind = sessionCacheKind(runtime?.sessionCache, runtime);
  if (kind === 'mtplx-ssd-session' || kind === 'mtplx') {
    return { supported: true, persistence: 'continuous', kind: 'mtplx-ssd-session' };
  }
  if (kind === 'llama-cpp-kv-cache' || kind === 'llama-cpp') {
    return { supported: true, persistence: 'continuous', kind: 'llama-cpp-kv-cache' };
  }
  return {
    supported: false,
    persistence: 'none',
    kind: null,
    reason:
      runtimeAdapter(runtime) === 'docker'
        ? 'docker runtime does not declare a supported session-cache adapter'
        : 'runtime does not declare a supported session-cache adapter'
  };
}

async function dockerContainerState(runtime) {
  const name = dockerContainerName(runtime);
  if (!name) return { exists: false, running: false, status: 'missing' };
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{json .State}}', name], {
      timeout: 5000
    });
    const state = JSON.parse(stdout.trim());
    return {
      exists: true,
      running: state.Running === true,
      status: state.Status ?? (state.Running ? 'running' : 'stopped'),
      pid: state.Pid ?? null,
      startedAt: state.StartedAt ?? null,
      error: state.Error || null
    };
  } catch (error) {
    return { exists: false, running: false, status: 'missing', error: error?.message ?? String(error) };
  }
}

async function dockerLifecycle(action, runtime) {
  const name = dockerContainerName(runtime);
  if (!name) throw new Error('docker runtime requires containerName or container.name');
  const { stdout, stderr } = await execFileAsync('docker', [action, name], { timeout: 120000 });
  return { action, containerName: name, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function bootstrapDockerContainer(runtime) {
  const bootstrap = dockerBootstrap(runtime);
  const args = dockerCreateArgs(runtime);
  if (!bootstrap || !args) return { created: false, reason: 'bootstrap-not-configured' };
  if (bootstrap.pull !== false) {
    await execFileAsync('docker', ['pull', String(bootstrap.image)], {
      timeout: bootstrap.pullTimeoutMs ?? 1800000
    });
  }
  const { stdout, stderr } = await execFileAsync('docker', args, {
    timeout: bootstrap.createTimeoutMs ?? 120000
  });
  return {
    created: true,
    containerName: dockerContainerName(runtime),
    image: bootstrap.image,
    stdout: stdout.trim(),
    stderr: stderr.trim()
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
  if (command === 'docker') return 'docker';
  return null;
}

/**
 * Default env for MTPLX long-context stability on Apple Silicon.
 *
 * Root cause: macOS GPU watchdog (~5s) kills a process when a single Metal
 * command buffer runs steel_attention over ~65k+ keys (MLX #3302 →
 * mlx::core::gpu::check_error SIGABRT). With paged-kv q4, MTPLX could fall
 * through to dense full-KV SDPA. Pair these env defaults with the site-package
 * patch in patches/mtplx-longctx-gpu-watchdog.md.
 *
 * AGX_RELAX_CDM_CTXSTORE_TIMEOUT relaxes residual watchdog kills past ~95k.
 * Runtime-specific env overrides these keys.
 */
const MTPLX_LONG_CONTEXT_ENV_DEFAULTS = {
  MTPLX_VLLM_METAL_PAGED_LARGE_Q_CHUNK_SIZE: '512',
  MTPLX_VLLM_METAL_PAGED_LARGE_Q_KV_CHUNK_SIZE: '512',
  MTPLX_LONG_CTX_CHUNKED_ATTN_THRESHOLD: '4096',
  MTPLX_PREFILL_CHUNK_SIZE: '512',
  MTPLX_PREFILL_CHUNK_SIZE_DENSE: '512',
  MTPLX_PREFILL_CHUNK_SIZE_REPAGE: '512',
  AGX_RELAX_CDM_CTXSTORE_TIMEOUT: '1'
};

function runtimeEnvironment(config, runtime) {
  const shimDir = config?.paths?.shimDir ?? defaultShimDirFor();
  const adapter = runtimeAdapter(runtime);
  const longCtxDefaults =
    adapter === 'mtplx' || commandName(runtime?.command).toLowerCase() === 'mtplx'
      ? MTPLX_LONG_CONTEXT_ENV_DEFAULTS
      : {};
  return {
    ...process.env,
    PATH: `${shimDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`,
    ...longCtxDefaults,
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
  // Recipes may explicitly disable caching for runtimes such as mlx-lm that
  // have no session-cache adapter or command-line flags.
  if (!kind && (cache.enabled === false || cache.mode === 'off')) return [];
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
    this.pausedRuntimes = new Set();
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
    return Object.entries(this.config.runtimes ?? {})
      .filter(([, runtime]) => runtime.keepWarm === true)
      .sort(([, left], [, right]) => {
        const leftPriority = Number(left?.policy?.priority ?? left?.priority ?? 100);
        const rightPriority = Number(right?.policy?.priority ?? right?.priority ?? 100);
        return rightPriority - leftPriority;
      })
      .map(([runtimeId]) => runtimeId);
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
      const container = runtimeAdapter(runtime) === 'docker' ? await dockerContainerState(runtime) : null;
      let status = state.status;
      if (this.processRunning(runtimeId)) {
        status = healthy ? 'running' : 'starting';
      } else if (container?.running && healthy) {
        status = 'running';
      } else if (container?.running) {
        status = 'starting';
      } else if (healthy) {
        status = 'external';
      } else if (container?.exists) {
        status = container.status;
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
        lastError: state.lastError,
        container
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
    if (!this.pausedRuntimes.has(runtimeId) && state.activeRequests < maxConcurrency) {
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
    const next = this.pausedRuntimes.has(runtimeId) ? null : queue.shift();
    state.queuedRequests = queue.length;
    if (!next) return;
    state.activeRequests += 1;
    next(() => this.releaseSlot(runtimeId));
  }

  resumeRuntime(runtimeId) {
    this.pausedRuntimes.delete(runtimeId);
    const state = this.stateFor(runtimeId);
    const queue = this.queueFor(runtimeId);
    const maxConcurrency = runtimeMaxConcurrency(this.getRuntime(runtimeId));
    while (state.activeRequests < maxConcurrency && queue.length > 0) {
      const next = queue.shift();
      state.activeRequests += 1;
      next(() => this.releaseSlot(runtimeId));
    }
    state.queuedRequests = queue.length;
  }

  async drainRuntime(runtimeId, { timeoutMs = 300000 } = {}) {
    this.pausedRuntimes.add(runtimeId);
    const deadline = Date.now() + timeoutMs;
    const state = this.stateFor(runtimeId);
    while (state.activeRequests > 0) {
      if (Date.now() >= deadline) throw new Error(`timed out draining runtime ${runtimeId}`);
      await delay(50);
    }
  }

  async reconfigure(nextConfig, { drainTimeoutMs = 300000 } = {}) {
    const previousConfig = this.config;
    const runtimeIds = new Set([
      ...Object.keys(previousConfig.runtimes ?? {}),
      ...Object.keys(nextConfig.runtimes ?? {})
    ]);
    const changed = [...runtimeIds].filter(
      (runtimeId) =>
        JSON.stringify(previousConfig.runtimes?.[runtimeId] ?? null) !==
        JSON.stringify(nextConfig.runtimes?.[runtimeId] ?? null)
    );
    const wasRunning = new Map();
    for (const runtimeId of changed) {
      const runtime = previousConfig.runtimes?.[runtimeId];
      if (!runtime) {
        wasRunning.set(runtimeId, false);
      } else if (runtimeAdapter(runtime) === 'docker') {
        wasRunning.set(runtimeId, (await dockerContainerState(runtime)).running === true);
      } else {
        wasRunning.set(runtimeId, this.processRunning(runtimeId) || (await healthOk(runtime.healthUrl)));
      }
    }
    for (const runtimeId of changed) await this.drainRuntime(runtimeId, { timeoutMs: drainTimeoutMs });
    const results = [];
    try {
      for (const runtimeId of changed) {
        const previous = previousConfig.runtimes?.[runtimeId];
        if (previous) await this.stop(runtimeId);
        if (previous && runtimeAdapter(previous) === 'docker') {
          const name = dockerContainerName(previous);
          if (name) await execFileAsync('docker', ['rm', name], { timeout: 120000 }).catch(() => {});
        }
      }
      this.config = nextConfig;
      for (const runtimeId of changed) {
        const current = nextConfig.runtimes?.[runtimeId];
        results.push(
          current?.keepWarm === true || wasRunning.get(runtimeId) === true
            ? await this.start(runtimeId, { force: true, warmup: true, reason: 'config-reload' })
            : { runtimeId, started: false, reason: current ? 'disabled' : 'removed' }
        );
      }
      return { changed, results };
    } finally {
      for (const runtimeId of changed) this.resumeRuntime(runtimeId);
    }
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

    if (runtimeAdapter(runtime) === 'docker') {
      if (runtimeManagement(runtime) !== 'managed') {
        return { runtimeId, started: false, healthy: false, reason: 'externally-managed' };
      }
      const container = await dockerContainerState(runtime);
      if (!container.exists) {
        const bootstrapResult = await bootstrapDockerContainer(runtime);
        if (!bootstrapResult.created) {
          throw new Error(
            `docker runtime ${runtimeId} container ${dockerContainerName(runtime)} does not exist and bootstrap is not configured`
          );
        }
        this.record({ runtimeId, event: 'docker-create', bootstrapResult, reason });
      }
      const processResult = await dockerLifecycle('start', runtime);
      state.status = 'starting';
      state.starts += 1;
      state.startedAt = nowIso();
      this.record({ runtimeId, event: 'docker-start', processResult, reason });
      const result = await this.waitForHealth(runtimeId, runtime);
      const warmupResult = result.healthy && warmup && runtime.warmup ? await this.warmup(runtimeId, runtime) : null;
      return {
        ...result,
        started: true,
        containerName: dockerContainerName(runtime),
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
    // Gateway managers capture both streams so backend aborts leave a trail.
    // CLI managers disable capture so their detached runtime does not keep the
    // short-lived command process open through an inherited pipe.
    const child = spawn(runtime.command, args, {
      cwd: runtime.cwd,
      env: runtimeEnvironment(this.config, runtime),
      stdio: ['ignore', this.captureOutput ? 'pipe' : 'ignore', this.captureOutput ? 'pipe' : 'ignore'],
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
      state.lastError = base ? (state.lastStderr ? `${base}; stderr=${state.lastStderr}` : base) : null;
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
    // Keep-warm boot is an ordered admission pass, not request-time eviction.
    // Protect everything already loaded so a later preference cannot churn an
    // earlier admitted runtime out of memory during the same pass.
    const admissionConfig = {
      ...this.config,
      runtimePolicy: {
        ...(this.config.runtimePolicy ?? {}),
        enabled: true,
        protectKeepWarm: true
      },
      runtimes: Object.fromEntries(
        Object.entries(this.config.runtimes ?? {}).map(([runtimeId, runtime]) => [
          runtimeId,
          {
            ...runtime,
            policy: {
              ...(runtime.policy ?? {}),
              evictable: false
            }
          }
        ])
      )
    };
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
      const { applyRuntimePolicyPlan } = await import('./runtime-policy.mjs');
      try {
        const result = await applyRuntimePolicyPlan(admissionConfig, this, {
          requestedRuntimeId: runtimeId,
          dryRun: false,
          yes: true,
          warmup: true,
          force: false,
          reason: 'keep-warm'
        });
        results.push(result);
        for (const warning of result.plan?.warnings ?? []) {
          this.logger.warn?.(`Keep-warm ${runtimeId}: ${warning}`);
        }
      } catch (error) {
        const warning = error?.message ?? String(error);
        const result = {
          runtimeId,
          started: false,
          status: 'skipped',
          reason: warning.startsWith('Runtime admission denied:') ? 'insufficient-memory' : 'start-failed',
          warning
        };
        results.push(result);
        this.record({ ...result, event: 'keep-warm-skipped' });
        this.logger.warn?.(`Keep-warm skipped ${runtimeId}: ${warning}`);
      }
    }
    return results;
  }

  async stop(runtimeId) {
    return this.withRuntimeLifecycleLock(runtimeId, () => this.stopUnlocked(runtimeId));
  }

  async stopAll() {
    const runtimeIds = Object.keys(this.config.runtimes ?? {});
    const results = [];
    for (const runtimeId of runtimeIds) {
      results.push(await this.stop(runtimeId));
    }
    return {
      stopped: results.filter((result) => result.stopped === true).length,
      total: runtimeIds.length,
      results
    };
  }

  async stopUnlocked(runtimeId) {
    const runtime = this.getRuntime(runtimeId);
    const state = this.stateFor(runtimeId);
    if (runtimeManagement(runtime) !== 'managed') {
      return { runtimeId, stopped: false, reason: 'externally-managed' };
    }
    if (runtimeAdapter(runtime) === 'docker') {
      const container = await dockerContainerState(runtime);
      if (!container.exists) return { runtimeId, stopped: false, reason: 'container-missing' };
      if (!container.running) return { runtimeId, stopped: false, reason: 'already-stopped' };
      state.status = 'stopping';
      const processResult = await dockerLifecycle('stop', runtime);
      state.status = 'stopped';
      state.stops += 1;
      state.stoppedAt = nowIso();
      this.record({ runtimeId, event: 'docker-stop', processResult });
      return { runtimeId, stopped: true, processResult };
    }
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
