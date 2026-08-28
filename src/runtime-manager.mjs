import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultShimDirFor } from './backend-catalog.mjs';
import { currentNodeId, runtimePlacement, runtimeResourcesByNode } from './cluster.mjs';
import { cleanupPortListener, terminateProcessTree } from './process-control.mjs';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHAT_TEMPLATE_OVERRIDES = new Map([
  ['qwen3-xml-tool-reminder', path.join(packageRoot, 'assets', 'chat-templates', 'qwen3-xml-tool-reminder.jinja')],
  ['qwen-fixed-v21.3', path.join(packageRoot, 'assets', 'chat-templates', 'qwen-fixed-v21.3.jinja')]
]);
const VLLM_CHAT_TEMPLATE_PATH = '/etc/lloom/chat-template.jinja';
const DOCKER_RUNTIME_SPEC_LABEL = 'io.lloom.runtime-spec-sha256';

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
    watchdog: runtimeWatchdogConfig(runtime),
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
    cachePersistence: runtimeCacheCapability(runtime),
    node: runtime.node ?? runtime.placement?.node ?? null,
    placement: runtime.placement ?? null
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

function distributedMembers(runtime) {
  return runtime?.placement?.mode === 'distributed'
    ? (runtime.placement.members ?? []).map((member) => member.runtime).filter(Boolean)
    : [];
}

export function reconfigureRuntimeIds(previousConfig, nextConfig, { nodeId, leaderNode } = {}) {
  const selectedNodeId = nodeId ?? currentNodeId(nextConfig);
  const selectedLeaderNode =
    leaderNode ?? nextConfig.cluster?.leaderNode ?? previousConfig.cluster?.leaderNode ?? selectedNodeId;
  const runtimeIds = new Set([
    ...Object.keys(previousConfig.runtimes ?? {}),
    ...Object.keys(nextConfig.runtimes ?? {})
  ]);
  const changed = new Set(
    [...runtimeIds].filter(
      (runtimeId) =>
        JSON.stringify(previousConfig.runtimes?.[runtimeId] ?? null) !==
        JSON.stringify(nextConfig.runtimes?.[runtimeId] ?? null)
    )
  );

  // A member change is a distributed-runtime change even when the placement
  // object itself stayed the same. Only the leader owns that logical restart;
  // each node separately reconciles the physical member assigned to it.
  for (const runtimeId of runtimeIds) {
    const previous = previousConfig.runtimes?.[runtimeId];
    const current = nextConfig.runtimes?.[runtimeId];
    const members = new Set([...distributedMembers(previous), ...distributedMembers(current)]);
    if (members.size > 0 && [...members].some((memberId) => changed.has(memberId))) changed.add(runtimeId);
  }

  return [...changed].filter((runtimeId) => {
    const runtime = nextConfig.runtimes?.[runtimeId] ?? previousConfig.runtimes?.[runtimeId];
    const placement = runtimePlacement(runtime, nextConfig);
    if (placement.mode === 'distributed') return selectedNodeId === selectedLeaderNode;
    return !placement.node || placement.node === selectedNodeId;
  });
}

export function ownsDistributedRuntime(config, runtime, { nodeId, leaderNode } = {}) {
  if (runtimePlacement(runtime, config).mode !== 'distributed') return true;
  const selectedNodeId = nodeId ?? currentNodeId(config);
  const selectedLeaderNode = leaderNode ?? config.cluster?.leaderNode ?? selectedNodeId;
  return selectedNodeId === selectedLeaderNode;
}

export function keepWarmOwnership(config, runtimeId, { nodeId, leaderNode } = {}) {
  const runtime = config.runtimes?.[runtimeId];
  if (!runtime) return { owned: false, reason: 'unknown-runtime' };
  const selectedNodeId = nodeId ?? currentNodeId(config);
  const selectedLeaderNode = leaderNode ?? config.cluster?.leaderNode ?? selectedNodeId;
  const distributedMemberIds = new Set(
    Object.values(config.runtimes ?? {}).flatMap((candidate) =>
      candidate?.enabled === true && candidate?.keepWarm === true ? distributedMembers(candidate) : []
    )
  );
  if (distributedMemberIds.has(runtimeId)) {
    return { owned: false, reason: 'distributed-runtime-owned' };
  }
  const placement = runtimePlacement(runtime, config);
  if (placement.mode === 'distributed' && selectedNodeId !== selectedLeaderNode) {
    return { owned: false, reason: 'leader-owned' };
  }
  if (placement.mode !== 'distributed' && placement.node && placement.node !== selectedNodeId) {
    return { owned: false, reason: 'node-owned' };
  }
  return { owned: true, reason: null };
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
    '--label',
    `${DOCKER_RUNTIME_SPEC_LABEL}=${dockerRuntimeSpecHash(runtime)}`,
    ...(Array.isArray(bootstrap.createArgs) ? bootstrap.createArgs : []).map(String),
    ...(chatTemplate
      ? ['--mount', `type=bind,src=${chatTemplate.hostPath},dst=${chatTemplate.containerPath},readonly`]
      : []),
    String(bootstrap.image),
    ...command
  ];
}

export function dockerRuntimeSpecHash(runtime) {
  const bootstrap = dockerBootstrap(runtime);
  if (!bootstrap) return null;
  const chatTemplate = runtimeChatTemplateOverride(runtime);
  return createHash('sha256')
    .update(
      JSON.stringify({
        image: String(bootstrap.image ?? ''),
        createArgs: (Array.isArray(bootstrap.createArgs) ? bootstrap.createArgs : []).map(String),
        command: (Array.isArray(bootstrap.command) ? bootstrap.command : []).map(String),
        chatTemplate: chatTemplate
          ? { id: chatTemplate.id, hostPath: chatTemplate.hostPath, containerPath: chatTemplate.containerPath }
          : null
      })
    )
    .digest('hex');
}

export function shouldRecreateDockerContainer(runtime, container) {
  const expectedSpecHash = dockerRuntimeSpecHash(runtime);
  return Boolean(container?.exists && expectedSpecHash && container.specHash !== expectedSpecHash);
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
    const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{json .}}', name], {
      timeout: 5000
    });
    const inspected = JSON.parse(stdout.trim());
    const state = inspected.State ?? {};
    return {
      exists: true,
      running: state.Running === true,
      status: state.Status ?? (state.Running ? 'running' : 'stopped'),
      pid: state.Pid ?? null,
      startedAt: state.StartedAt ?? null,
      error: state.Error || null,
      specHash: inspected.Config?.Labels?.[DOCKER_RUNTIME_SPEC_LABEL] ?? null
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

async function runtimeHealthOk(runtime, timeoutMs = 1500) {
  if (runtime?.healthStrategy === 'container' && runtimeAdapter(runtime) === 'docker') {
    return (await dockerContainerState(runtime)).running === true;
  }
  return healthOk(runtime?.healthUrl, timeoutMs);
}

function runtimeMaxConcurrency(runtime) {
  const value = Number(runtime?.maxConcurrency ?? 1);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function integerAtLeast(value, fallback, minimum) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum ? Math.floor(number) : fallback;
}

export function runtimeWatchdogConfig(runtime) {
  const configured = runtime?.watchdog;
  const failureStatuses = Array.isArray(configured?.failureStatuses)
    ? configured.failureStatuses
        .map(Number)
        .filter((status) => Number.isInteger(status) && status >= 400 && status <= 599)
    : [499, 502, 504];
  return {
    enabled: configured?.enabled === true && runtimeManagement(runtime) === 'managed',
    failureThreshold: integerAtLeast(configured?.failureThreshold, 2, 1),
    failureWindowMs: integerAtLeast(configured?.failureWindowMs, 600000, 1),
    minNoProgressMs: integerAtLeast(configured?.minNoProgressMs, 120000, 0),
    cooldownMs: integerAtLeast(configured?.cooldownMs, 600000, 0),
    drainTimeoutMs: integerAtLeast(configured?.drainTimeoutMs, 30000, 0),
    failureStatuses: failureStatuses.length > 0 ? failureStatuses : [499, 502, 504]
  };
}

export function classifyRuntimeWatchdogOutcome(runtime, outcome = {}) {
  const watchdog = runtimeWatchdogConfig(runtime);
  if (!watchdog.enabled) return { kind: 'disabled', watchdog };
  const firstContentMs = outcome.firstContentMs == null ? null : Number(outcome.firstContentMs);
  const lastContentMs = outcome.lastContentMs == null ? null : Number(outcome.lastContentMs);
  const responseBytes = Number(outcome.responseBytes ?? 0);
  const madeProgress =
    outcome.stalled !== true &&
    ((firstContentMs != null && Number.isFinite(firstContentMs) && firstContentMs >= 0) ||
      (lastContentMs != null && Number.isFinite(lastContentMs) && lastContentMs >= 0) ||
      (Number.isFinite(responseBytes) && responseBytes > 0));
  if (outcome.ok === true || madeProgress) {
    return { kind: 'progress', watchdog };
  }
  const status = Number(outcome.status);
  // Admission, model loading, and capacity waits are not runtime execution.
  // Prefer the time spent after admission when the caller can provide it so a
  // client that gives up during a long cold start cannot condemn the newly
  // healthy runtime as stalled.
  const durationMs = Number(outcome.runtimeDurationMs ?? outcome.durationMs ?? 0);
  if (!watchdog.failureStatuses.includes(status) || !Number.isFinite(durationMs)) {
    return { kind: 'ignored', watchdog };
  }
  if (durationMs < watchdog.minNoProgressMs) {
    return { kind: 'ignored', watchdog };
  }
  return {
    kind: 'no-progress-failure',
    watchdog,
    status,
    durationMs
  };
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
  constructor(config, { logger = console, captureOutput = true, clusterCoordinator = null } = {}) {
    this.config = config;
    this.logger = logger;
    this.captureOutput = captureOutput;
    this.processes = new Map();
    this.state = new Map();
    this.queues = new Map();
    this.pausedRuntimes = new Set();
    this.reconfiguringRuntimes = new Set();
    this.lifecycleQueues = new Map();
    this.lifecycleControllers = new Map();
    this.watchdogOperations = new Map();
    this.admissionQueue = Promise.resolve();
    this.activeAdmission = null;
    this.events = [];
    this.clusterCoordinator = clusterCoordinator;
    this.clusterCoordinator?.attachRuntimeManager(this);
  }

  stateFor(runtimeId) {
    if (!this.state.has(runtimeId)) {
      this.state.set(runtimeId, {
        status: 'idle',
        starts: 0,
        stops: 0,
        activeRequests: 0,
        queuedRequests: 0,
        admissionQueuedRequests: 0,
        lastRequestedAt: null,
        lastIdleAt: null,
        statusSince: nowIso(),
        transitionReason: null,
        startedAt: null,
        stoppedAt: null,
        lastWarmup: null,
        lastError: null,
        lastStderr: null,
        watchdog: {
          consecutiveFailures: 0,
          lastFailureAt: null,
          restartPending: false,
          restartRequestedAt: null,
          lastRestartAt: null,
          restarts: 0,
          restartFailures: 0,
          lastError: null
        }
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

  setStatus(runtimeId, status, reason = null) {
    const state = this.stateFor(runtimeId);
    if (state.status !== status || state.transitionReason !== reason) {
      state.status = status;
      state.statusSince = nowIso();
      state.transitionReason = reason;
      this.record({ runtimeId, event: 'state', status, reason });
    }
    return state;
  }

  markAdmissionQueued(runtimeId, queued, reason = 'capacity') {
    const state = this.stateFor(runtimeId);
    state.admissionQueuedRequests = Math.max(0, state.admissionQueuedRequests + (queued ? 1 : -1));
    if (queued && !['running', 'starting', 'warming'].includes(state.status))
      this.setStatus(runtimeId, 'queued', reason);
    if (!queued && state.admissionQueuedRequests === 0 && state.status === 'queued') this.setStatus(runtimeId, 'idle');
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

  async runtimeAppearsLoaded(runtimeId) {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) return false;
    const placement = runtimePlacement(runtime, this.config);
    if (this.clusterCoordinator && !this.clusterCoordinator.isLocalNode(placement.node)) {
      if (typeof this.clusterCoordinator.nodeStatus === 'function') {
        try {
          const node = await this.clusterCoordinator.nodeStatus(placement.node);
          const remote = node?.runtimeManager?.runtimes?.[runtimeId];
          if (remote?.healthy === true || ['running', 'external', 'starting', 'warming'].includes(remote?.status)) {
            return true;
          }
        } catch {
          // Fall through to gateway-observed state when the node is unreachable.
        }
      }
      return ['running', 'external', 'starting', 'warming'].includes(this.stateFor(runtimeId).status);
    }
    if (await runtimeHealthOk(runtime)) return true;
    if (this.processRunning(runtimeId)) return true;
    if (runtimeAdapter(runtime) === 'docker') return (await dockerContainerState(runtime)).running === true;
    return ['running', 'external', 'starting', 'warming'].includes(this.stateFor(runtimeId).status);
  }

  async isHealthy(runtimeId) {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) return false;
    if (await runtimeHealthOk(runtime)) return true;
    if (runtimePlacement(runtime, this.config).mode !== 'distributed') return false;
    const status = await this.status();
    return status.runtimes?.[runtimeId]?.healthy === true;
  }

  queueFor(runtimeId) {
    if (!this.queues.has(runtimeId)) this.queues.set(runtimeId, []);
    return this.queues.get(runtimeId);
  }

  withAdmissionLock(fn, { runtimeId = null, reason = 'runtime-admission', preemptible = false } = {}) {
    const active = this.activeAdmission;
    if (active?.runtimeId && active.runtimeId !== runtimeId) {
      if (active.preemptible && !active.preemptionRequested) {
        active.preemptionRequested = true;
        const error = new Error(
          `runtime ${active.runtimeId} cold start was superseded by ${runtimeId}; retry through its configured external fallback`
        );
        error.code = 'RUNTIME_ADMISSION_PREEMPTED';
        error.statusCode = 503;
        active.controller.abort(error);
        this.abortRuntimeTree(active.runtimeId, error);
        this.record({
          runtimeId: active.runtimeId,
          event: 'admission-preempt',
          reason: `superseded-by:${runtimeId}`,
          requestedRuntimeId: runtimeId
        });
      } else if (reason === 'model-request') {
        const error = new Error(
          `runtime ${runtimeId} cannot wait behind active admission for ${active.runtimeId}; retry through its configured fallback`
        );
        error.code = 'RUNTIME_ADMISSION_BUSY';
        error.statusCode = 503;
        return Promise.reject(error);
      }
    }
    const run = this.admissionQueue
      .catch(() => {})
      .then(async () => {
        const admission = {
          runtimeId,
          reason,
          preemptible,
          preemptionRequested: false,
          controller: new AbortController()
        };
        this.activeAdmission = admission;
        try {
          return await fn(admission.controller.signal);
        } finally {
          if (this.activeAdmission === admission) this.activeAdmission = null;
        }
      });
    this.admissionQueue = run.catch(() => {});
    return run;
  }

  withRuntimeLifecycleLock(runtimeId, fn) {
    if (!runtimeId) return fn();
    const previous = this.lifecycleQueues.get(runtimeId) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        const controller = new AbortController();
        this.lifecycleControllers.set(runtimeId, controller);
        try {
          return await fn(controller.signal);
        } finally {
          if (this.lifecycleControllers.get(runtimeId) === controller) {
            this.lifecycleControllers.delete(runtimeId);
          }
        }
      });
    this.lifecycleQueues.set(
      runtimeId,
      run.catch(() => {})
    );
    return run;
  }

  abortRuntimeLifecycle(runtimeId, reason = 'lifecycle superseded') {
    const controller = this.lifecycleControllers.get(runtimeId);
    if (!controller || controller.signal.aborted) return false;
    const error = reason instanceof Error ? reason : new Error(reason);
    controller.abort(error);
    this.record({ runtimeId, event: 'lifecycle-abort', reason: error.message });
    return true;
  }

  abortRuntimeTree(runtimeId, reason = 'lifecycle superseded') {
    const runtime = this.getRuntime(runtimeId);
    let aborted = this.abortRuntimeLifecycle(runtimeId, reason);
    if (runtimePlacement(runtime, this.config).mode === 'distributed') {
      for (const member of runtime.placement.members ?? []) {
        aborted = this.abortRuntimeLifecycle(member.runtime, reason) || aborted;
      }
    }
    return aborted;
  }

  async status({ localOnly = false } = {}) {
    const runtimes = {};
    const keepWarm = new Set(this.keepWarmRuntimeIds());
    const remoteNodes = new Map();
    for (const [runtimeId, runtime] of Object.entries(this.config.runtimes ?? {})) {
      const placement = runtimePlacement(runtime, this.config);
      if (placement.mode === 'distributed') continue;
      const nodeId = placement.node;
      const isLocal = !this.clusterCoordinator
        ? !runtime.node || nodeId === currentNodeId(this.config)
        : this.clusterCoordinator.isLocalNode(nodeId);
      if (localOnly && !isLocal) continue;
      if (!isLocal && this.clusterCoordinator) {
        if (!remoteNodes.has(nodeId)) remoteNodes.set(nodeId, this.clusterCoordinator.nodeStatus(nodeId));
        const node = await remoteNodes.get(nodeId);
        const remote = node.runtimeManager?.runtimes?.[runtimeId];
        const gatewayState = this.stateFor(runtimeId);
        runtimes[runtimeId] = remote
          ? {
              ...remote,
              node: nodeId,
              remote: true,
              activeRequests: gatewayState.activeRequests,
              queuedRequests: gatewayState.queuedRequests,
              admissionQueuedRequests: gatewayState.admissionQueuedRequests,
              lastRequestedAt: gatewayState.lastRequestedAt ?? remote.lastRequestedAt,
              lastIdleAt: gatewayState.lastIdleAt ?? remote.lastIdleAt
            }
          : {
              ...compactRuntime(runtimeId, runtime),
              node: nodeId,
              remote: true,
              healthy: false,
              status: node.reachable ? 'unknown' : 'unreachable',
              error: node.error ?? null,
              activeRequests: gatewayState.activeRequests,
              queuedRequests: gatewayState.queuedRequests,
              admissionQueuedRequests: gatewayState.admissionQueuedRequests,
              lastRequestedAt: gatewayState.lastRequestedAt,
              lastIdleAt: gatewayState.lastIdleAt
            };
        continue;
      }
      const state = this.stateFor(runtimeId);
      const process = this.processes.get(runtimeId);
      const healthy = await runtimeHealthOk(runtime);
      const container = runtimeAdapter(runtime) === 'docker' ? await dockerContainerState(runtime) : null;
      let status = state.status;
      if (state.status === 'queued') {
        status = 'queued';
      } else if (state.status === 'stopping' || state.status === 'draining') {
        if (!this.processRunning(runtimeId) && !container?.running && !healthy) status = 'stopped';
      } else if (state.status === 'starting' || state.status === 'warming') {
        if (healthy && state.status !== 'warming') status = 'running';
      } else if (this.processRunning(runtimeId)) {
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
        admissionQueuedRequests: state.admissionQueuedRequests,
        lastRequestedAt: state.lastRequestedAt,
        lastIdleAt: state.lastIdleAt,
        statusSince: state.statusSince,
        transitionReason: state.transitionReason,
        startedAt: state.startedAt,
        stoppedAt: state.stoppedAt,
        lastWarmup: state.lastWarmup,
        lastError: state.lastError,
        watchdog: {
          ...runtimeWatchdogConfig(runtime),
          ...state.watchdog
        },
        container
      };
    }
    if (!localOnly) {
      for (const [runtimeId, runtime] of Object.entries(this.config.runtimes ?? {})) {
        const placement = runtimePlacement(runtime, this.config);
        if (placement.mode !== 'distributed') continue;
        const state = this.stateFor(runtimeId);
        const members = placement.members.map((member) => ({
          ...member,
          status: runtimes[member.runtime]?.status ?? 'unknown',
          healthy: runtimes[member.runtime]?.healthy === true
        }));
        const healthy = members.length > 0 && members.every((member) => member.healthy);
        const anyLoaded = members.some((member) => ['running', 'external', 'starting'].includes(member.status));
        const transitionalStatus = ['queued', 'draining', 'stopping'].includes(state.status) ? state.status : null;
        runtimes[runtimeId] = {
          ...compactRuntime(runtimeId, runtime),
          node: null,
          remote: false,
          distributed: true,
          members,
          resourcesByNode: runtimeResourcesByNode(runtime, this.config),
          healthy,
          status: transitionalStatus ?? (healthy ? 'running' : anyLoaded ? 'starting' : 'stopped'),
          keepWarm: keepWarm.has(runtimeId),
          starts: state.starts,
          stops: state.stops,
          activeRequests: state.activeRequests,
          queuedRequests: state.queuedRequests,
          admissionQueuedRequests: state.admissionQueuedRequests,
          lastRequestedAt: state.lastRequestedAt,
          lastIdleAt: state.lastIdleAt,
          statusSince: state.statusSince,
          transitionReason: state.transitionReason,
          startedAt: state.startedAt,
          stoppedAt: state.stoppedAt,
          lastWarmup: state.lastWarmup,
          lastError: state.lastError,
          watchdog: {
            ...runtimeWatchdogConfig(runtime),
            ...state.watchdog
          }
        };
      }
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

  noteRequestOutcome(runtimeId, outcome = {}) {
    if (!runtimeId) return { runtimeId, action: 'ignored', reason: 'no-runtime' };
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) return { runtimeId, action: 'ignored', reason: 'unknown-runtime' };
    const classification = classifyRuntimeWatchdogOutcome(runtime, outcome);
    if (classification.kind === 'disabled') {
      return { runtimeId, action: 'ignored', reason: 'watchdog-disabled' };
    }
    const state = this.stateFor(runtimeId);
    const watchdogState = state.watchdog;
    if (classification.kind === 'progress') {
      if (watchdogState.consecutiveFailures > 0) {
        this.record({
          runtimeId,
          event: 'watchdog-recovered',
          clearedFailures: watchdogState.consecutiveFailures
        });
      }
      watchdogState.consecutiveFailures = 0;
      watchdogState.lastFailureAt = null;
      return { runtimeId, action: 'reset', reason: 'request-progress' };
    }
    if (classification.kind !== 'no-progress-failure') {
      return { runtimeId, action: 'ignored', reason: 'not-a-no-progress-failure' };
    }

    const now = Date.now();
    const previousFailureAt = Date.parse(watchdogState.lastFailureAt ?? '');
    if (!Number.isFinite(previousFailureAt) || now - previousFailureAt > classification.watchdog.failureWindowMs) {
      watchdogState.consecutiveFailures = 0;
    }
    watchdogState.consecutiveFailures += 1;
    watchdogState.lastFailureAt = new Date(now).toISOString();
    this.record({
      runtimeId,
      event: 'watchdog-no-progress',
      status: classification.status,
      durationMs: classification.durationMs,
      consecutiveFailures: watchdogState.consecutiveFailures,
      failureThreshold: classification.watchdog.failureThreshold
    });

    if (watchdogState.consecutiveFailures < classification.watchdog.failureThreshold) {
      return { runtimeId, action: 'observed', reason: 'below-threshold' };
    }
    if (watchdogState.restartPending || this.watchdogOperations.has(runtimeId)) {
      return { runtimeId, action: 'observed', reason: 'restart-pending' };
    }
    const lastRestartAt = Date.parse(watchdogState.restartRequestedAt ?? watchdogState.lastRestartAt ?? '');
    if (Number.isFinite(lastRestartAt) && now - lastRestartAt < classification.watchdog.cooldownMs) {
      this.record({
        runtimeId,
        event: 'watchdog-restart-suppressed',
        reason: 'cooldown',
        cooldownRemainingMs: classification.watchdog.cooldownMs - (now - lastRestartAt)
      });
      return { runtimeId, action: 'observed', reason: 'cooldown' };
    }

    watchdogState.consecutiveFailures = 0;
    watchdogState.restartPending = true;
    watchdogState.restartRequestedAt = new Date(now).toISOString();
    watchdogState.lastError = null;
    this.pausedRuntimes.add(runtimeId);
    this.setStatus(runtimeId, 'draining', 'watchdog');
    this.record({
      runtimeId,
      event: 'watchdog-restart-requested',
      status: classification.status,
      durationMs: classification.durationMs
    });
    const operation = this.withRuntimeLifecycleLock(runtimeId, (signal) =>
      this.restartForWatchdogUnlocked(runtimeId, classification.watchdog, { signal })
    )
      .then((result) => {
        watchdogState.restarts += 1;
        watchdogState.lastRestartAt = nowIso();
        watchdogState.lastError = null;
        this.record({ runtimeId, event: 'watchdog-restart-completed', result });
        return result;
      })
      .catch((error) => {
        watchdogState.restartFailures += 1;
        watchdogState.lastError = error?.message ?? String(error);
        this.record({
          runtimeId,
          event: 'watchdog-restart-failed',
          message: watchdogState.lastError
        });
        this.logger.error?.(`Runtime watchdog restart failed for ${runtimeId}: ${watchdogState.lastError}`);
        return { runtimeId, restarted: false, error: watchdogState.lastError };
      })
      .finally(() => {
        watchdogState.restartPending = false;
        this.watchdogOperations.delete(runtimeId);
        this.resumeRuntime(runtimeId);
      });
    this.watchdogOperations.set(runtimeId, operation);
    return { runtimeId, action: 'restart-requested', reason: 'failure-threshold' };
  }

  async restartForWatchdogUnlocked(runtimeId, watchdog, { signal } = {}) {
    const state = this.stateFor(runtimeId);
    const deadline = Date.now() + watchdog.drainTimeoutMs;
    while (state.activeRequests > 0 && Date.now() < deadline) {
      signal?.throwIfAborted?.();
      await delay(50);
    }
    signal?.throwIfAborted?.();
    const forced = state.activeRequests > 0;
    if (forced) {
      this.record({
        runtimeId,
        event: 'watchdog-drain-timeout',
        activeRequests: state.activeRequests,
        drainTimeoutMs: watchdog.drainTimeoutMs
      });
    }
    const stop = await this.stopUnlocked(runtimeId);
    signal?.throwIfAborted?.();
    const start = await this.startUnlocked(runtimeId, {
      force: true,
      warmup: true,
      reason: 'watchdog-restart',
      signal
    });
    return { runtimeId, restarted: true, forced, stop, start };
  }

  acquireSlot(runtimeId) {
    if (!runtimeId) return () => {};
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) return () => {};
    const state = this.stateFor(runtimeId);
    state.lastRequestedAt = nowIso();
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
    if (state.activeRequests === 0) state.lastIdleAt = nowIso();
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
    if (state.status === 'draining') this.setStatus(runtimeId, 'idle', 'resumed');
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
    this.pauseRuntime(runtimeId, 'eviction');
    const deadline = Date.now() + timeoutMs;
    const state = this.stateFor(runtimeId);
    while (state.activeRequests > 0) {
      if (Date.now() >= deadline) throw new Error(`timed out draining runtime ${runtimeId}`);
      await delay(50);
    }
  }

  pauseRuntime(runtimeId, reason = 'capacity-reallocation') {
    this.pausedRuntimes.add(runtimeId);
    this.setStatus(runtimeId, 'draining', reason);
  }

  async reconfigure(nextConfig, { drainTimeoutMs = 300000 } = {}) {
    const previousConfig = this.config;
    const nodeId = this.clusterCoordinator?.nodeId ?? currentNodeId(nextConfig);
    const leaderNode = nextConfig.cluster?.leaderNode ?? previousConfig.cluster?.leaderNode ?? nodeId;
    const changed = reconfigureRuntimeIds(previousConfig, nextConfig, { nodeId, leaderNode });
    const distributed = new Set(
      changed.filter((runtimeId) => {
        const runtime = nextConfig.runtimes?.[runtimeId] ?? previousConfig.runtimes?.[runtimeId];
        return runtimePlacement(runtime, nextConfig).mode === 'distributed';
      })
    );
    const distributedRuntimeIds = new Set(
      [...new Set([...Object.keys(previousConfig.runtimes ?? {}), ...Object.keys(nextConfig.runtimes ?? {})])].filter(
        (runtimeId) => {
          const runtime = nextConfig.runtimes?.[runtimeId] ?? previousConfig.runtimes?.[runtimeId];
          return runtimePlacement(runtime, nextConfig).mode === 'distributed';
        }
      )
    );
    const distributedMemberIds = new Set(
      [...distributedRuntimeIds].flatMap((runtimeId) => [
        ...distributedMembers(previousConfig.runtimes?.[runtimeId]),
        ...distributedMembers(nextConfig.runtimes?.[runtimeId])
      ])
    );
    const ownedChanges = changed.filter((runtimeId) => !distributedMemberIds.has(runtimeId));
    const stopOrder = [...changed].sort(
      (left, right) => Number(distributed.has(right)) - Number(distributed.has(left))
    );
    for (const runtimeId of ownedChanges) this.reconfiguringRuntimes.add(runtimeId);
    for (const runtimeId of ownedChanges) this.abortRuntimeLifecycle(runtimeId, 'superseded by config reload');
    const wasRunning = new Map();
    for (const runtimeId of ownedChanges) {
      const runtime = previousConfig.runtimes?.[runtimeId];
      if (!runtime) {
        wasRunning.set(runtimeId, false);
      } else if (runtimeAdapter(runtime) === 'docker') {
        wasRunning.set(runtimeId, (await dockerContainerState(runtime)).running === true);
      } else {
        wasRunning.set(runtimeId, this.processRunning(runtimeId) || (await runtimeHealthOk(runtime)));
      }
    }
    for (const runtimeId of ownedChanges) await this.drainRuntime(runtimeId, { timeoutMs: drainTimeoutMs });
    const results = [];
    try {
      for (const runtimeId of stopOrder) {
        if (distributedMemberIds.has(runtimeId)) continue;
        const previous = previousConfig.runtimes?.[runtimeId];
        if (previous) await this.stop(runtimeId);
        if (previous && runtimeAdapter(previous) === 'docker') {
          const name = dockerContainerName(previous);
          if (name) await execFileAsync('docker', ['rm', name], { timeout: 120000 }).catch(() => {});
        }
      }
      this.config = nextConfig;
      const startOrder = [...changed].sort(
        (left, right) => Number(distributed.has(right)) - Number(distributed.has(left))
      );
      for (const runtimeId of startOrder) {
        const current = nextConfig.runtimes?.[runtimeId];
        if (distributedMemberIds.has(runtimeId)) {
          results.push({ runtimeId, started: false, reason: 'distributed-runtime-owned' });
          continue;
        }
        if (!current) {
          results.push({ runtimeId, started: false, reason: 'removed' });
          continue;
        }
        if (current.enabled !== true) {
          results.push({ runtimeId, started: false, reason: 'runtime-disabled' });
          continue;
        }
        const ownership = keepWarmOwnership(nextConfig, runtimeId, { nodeId, leaderNode });
        if (current.keepWarm === true && !ownership.owned) {
          results.push({ runtimeId, started: false, reason: ownership.reason });
          continue;
        }
        const previous = previousConfig.runtimes?.[runtimeId];
        const preserveOnDemandRuntime = wasRunning.get(runtimeId) === true && previous?.keepWarm !== true;
        if (current.keepWarm !== true && !preserveOnDemandRuntime) {
          results.push({ runtimeId, started: false, reason: 'not-keep-warm' });
          continue;
        }
        results.push(
          await this.admit(runtimeId, {
            config: nextConfig,
            force: true,
            warmup: true,
            reason: 'config-reload'
          })
        );
      }
      return { changed, results };
    } finally {
      for (const runtimeId of ownedChanges) {
        this.reconfiguringRuntimes.delete(runtimeId);
        this.resumeRuntime(runtimeId);
      }
    }
  }

  async ensure(runtimeId) {
    return this.start(runtimeId, {
      force: false,
      warmup: true,
      reason: 'model-request'
    });
  }

  async admit(runtimeId, { config = this.config, force = false, warmup = true, reason = 'runtime-admission' } = {}) {
    const { applyRuntimePolicyPlan } = await import('./runtime-policy.mjs');
    return applyRuntimePolicyPlan(config, this, {
      requestedRuntimeId: runtimeId,
      dryRun: false,
      yes: true,
      warmup,
      force,
      reason
    });
  }

  async start(runtimeId, { force = false, warmup = true, reason = 'manual-start' } = {}) {
    return this.withRuntimeLifecycleLock(runtimeId, (signal) =>
      this.startUnlocked(runtimeId, {
        force,
        warmup,
        reason,
        signal
      })
    );
  }

  async startUnlocked(runtimeId, { force = false, warmup = true, reason = 'manual-start', signal } = {}) {
    if (!runtimeId) return { runtimeId, started: false, reason: 'no-runtime' };
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) return { runtimeId, started: false, reason: 'unknown-runtime' };
    if (reason === 'model-request' && this.reconfiguringRuntimes.has(runtimeId)) {
      const error = new Error(`runtime ${runtimeId} is reconfiguring; retry through its configured fallback`);
      error.code = 'RUNTIME_RECONFIGURING';
      error.statusCode = 503;
      throw error;
    }
    const state = this.stateFor(runtimeId);
    const placement = runtimePlacement(runtime, this.config);

    if (placement.mode === 'distributed') {
      if (!force && (await runtimeHealthOk(runtime))) {
        state.lastError = null;
        this.setStatus(runtimeId, 'running');
        return {
          runtimeId,
          started: false,
          healthy: true,
          distributed: true,
          reason: 'already-healthy'
        };
      }

      const started = [];
      this.setStatus(runtimeId, 'starting', reason);
      try {
        signal?.throwIfAborted?.();
        const memberIds = placement.members.map((member) => member.runtime).filter(Boolean);
        const hasLoadedMember = (
          await Promise.all(memberIds.map((memberId) => this.runtimeAppearsLoaded(memberId)))
        ).some(Boolean);
        if (force || hasLoadedMember) {
          this.record({
            runtimeId,
            event: 'distributed-recovery',
            reason: force ? 'forced-start' : 'partial-or-unhealthy-cluster',
            members: memberIds
          });
          for (const member of [...placement.members].sort((left, right) => right.order - left.order)) {
            await this.stop(member.runtime).catch(() => {});
          }
        }
        signal?.throwIfAborted?.();
        for (const member of [...placement.members].sort((left, right) => left.order - right.order)) {
          signal?.throwIfAborted?.();
          const result = await this.start(member.runtime, { force, warmup: false, reason: `${reason}:${runtimeId}` });
          if (result?.healthy === false || (result?.started === false && result?.reason !== 'already-healthy')) {
            throw new Error(
              `distributed runtime ${runtimeId} member ${member.runtime} on ${member.node} did not become healthy (${result?.reason ?? 'unknown'})`
            );
          }
          started.push({ ...member, result });
        }
        if (runtime.healthUrl) await this.waitForHealth(runtimeId, runtime, null, { signal });
        state.starts += 1;
        state.startedAt = nowIso();
        state.lastError = null;
        this.setStatus(runtimeId, 'running', reason);
        const warmupResult = warmup && runtime.warmup ? await this.warmup(runtimeId, runtime, { signal }) : null;
        return {
          runtimeId,
          started: true,
          healthy: true,
          distributed: true,
          members: started,
          ...(warmupResult ? { warmup: warmupResult } : {})
        };
      } catch (error) {
        for (const member of [...placement.members].sort((left, right) => right.order - left.order)) {
          this.abortRuntimeLifecycle(member.runtime, `distributed runtime ${runtimeId} startup failed`);
          await this.stop(member.runtime).catch(() => {});
        }
        state.lastError = error?.message ?? String(error);
        this.setStatus(runtimeId, 'failed', reason);
        throw error;
      }
    }

    if (this.clusterCoordinator && !this.clusterCoordinator.isLocalNode(placement.node)) {
      this.setStatus(runtimeId, 'starting', reason);
      const result = await this.clusterCoordinator.runtimeAction(
        placement.node,
        runtimeId,
        'start',
        { force, warmup, reason },
        { signal }
      );
      state.starts += result?.started === false ? 0 : 1;
      state.startedAt = nowIso();
      this.setStatus(runtimeId, result?.healthy === false ? 'failed' : 'running', reason);
      return { ...result, runtimeId, node: placement.node, remote: true };
    }

    if (await runtimeHealthOk(runtime)) {
      this.setStatus(runtimeId, 'running');
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
      let container = await dockerContainerState(runtime);
      if (shouldRecreateDockerContainer(runtime, container)) {
        const name = dockerContainerName(runtime);
        await execFileAsync('docker', ['rm', '-f', name], { timeout: 120000 });
        this.record({
          runtimeId,
          event: 'docker-recreate',
          containerName: name,
          reason: container.specHash ? 'runtime-spec-changed' : 'runtime-spec-untracked'
        });
        container = { exists: false, running: false, status: 'missing' };
      }
      if (!container.exists) {
        const bootstrapResult = await bootstrapDockerContainer(runtime);
        if (!bootstrapResult.created) {
          throw new Error(
            `docker runtime ${runtimeId} container ${dockerContainerName(runtime)} does not exist and bootstrap is not configured`
          );
        }
        this.record({ runtimeId, event: 'docker-create', bootstrapResult, reason });
      }
      this.setStatus(runtimeId, 'starting', reason);
      const processResult = await dockerLifecycle('start', runtime);
      state.starts += 1;
      state.startedAt = nowIso();
      this.record({ runtimeId, event: 'docker-start', processResult, reason });
      const result = await this.waitForHealth(runtimeId, runtime, null, { signal });
      const warmupResult =
        result.healthy && warmup && runtime.warmup ? await this.warmup(runtimeId, runtime, { signal }) : null;
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
      return this.waitForHealth(runtimeId, runtime, existing, { signal });
    }

    this.setStatus(runtimeId, 'starting', reason);
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

    const result = await this.waitForHealth(runtimeId, runtime, child, { signal });
    let warmupResult = null;
    if (result.healthy && warmup && runtime.warmup) {
      warmupResult = await this.warmup(runtimeId, runtime, { signal });
    }
    return {
      ...result,
      started: true,
      pid: child.pid,
      ...(warmupResult ? { warmup: warmupResult } : {})
    };
  }

  async waitForHealth(runtimeId, runtime, child = null, { signal } = {}) {
    const state = this.stateFor(runtimeId);
    const deadline = Date.now() + (runtime.startupTimeoutMs ?? 300000);
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason ?? new Error(`runtime ${runtimeId} start aborted`);
      if (await runtimeHealthOk(runtime)) {
        this.setStatus(runtimeId, 'running');
        this.record({ runtimeId, event: 'healthy' });
        return { runtimeId, healthy: true };
      }
      if (child && child.exitCode != null) {
        const message = `runtime ${runtimeId} exited before becoming healthy`;
        state.status = 'failed';
        state.lastError = message;
        throw new Error(message);
      }
      try {
        await delay(500, undefined, { signal });
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw error;
      }
    }
    state.status = 'failed';
    state.lastError = `runtime ${runtimeId} did not become healthy before timeout`;
    throw new Error(`runtime ${runtimeId} did not become healthy before timeout`);
  }

  async warmupById(runtimeId) {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) return { runtimeId, warmed: false, reason: 'unknown-runtime' };
    const placement = runtimePlacement(runtime, this.config);
    if (
      this.clusterCoordinator &&
      placement.mode !== 'distributed' &&
      !this.clusterCoordinator.isLocalNode(placement.node)
    ) {
      return this.clusterCoordinator.runtimeAction(placement.node, runtimeId, 'warmup');
    }
    if (!(await runtimeHealthOk(runtime))) {
      const result = { runtimeId, warmed: false, reason: 'not-healthy' };
      this.stateFor(runtimeId).lastWarmup = result;
      return result;
    }
    return this.warmup(runtimeId, runtime);
  }

  async warmup(runtimeId, runtime, { signal } = {}) {
    const state = this.stateFor(runtimeId);
    const warmup = runtime.warmup;
    if (!warmup?.url) return { runtimeId, warmed: false, reason: 'no-warmup' };
    this.setStatus(runtimeId, 'warming', 'warmup');
    const startedAt = Date.now();
    try {
      const response = await fetch(warmup.url, {
        method: warmup.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          ...(warmup.headers ?? {})
        },
        body: warmup.body ? JSON.stringify(warmup.body) : undefined,
        signal
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
      this.setStatus(runtimeId, 'running', response.ok ? null : 'warmup-failed');
      return result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const result = {
        runtimeId,
        warmed: false,
        latencyMs: Date.now() - startedAt,
        error: error?.message ?? String(error)
      };
      state.lastWarmup = result;
      this.record({ ...result, event: 'warmup' });
      this.setStatus(runtimeId, 'running', 'warmup-failed');
      return result;
    }
  }

  async startKeepWarm() {
    const results = [];
    // Keep-warm is the runtime residency pin. The normal admission policy
    // protects every pinned runtime, including those started earlier in this
    // ordered boot pass.
    const admissionConfig = {
      ...this.config,
      runtimePolicy: {
        ...(this.config.runtimePolicy ?? {}),
        enabled: true
      }
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
      const ownership = keepWarmOwnership(this.config, runtimeId, {
        nodeId: this.clusterCoordinator?.nodeId ?? currentNodeId(this.config),
        leaderNode: this.config.cluster?.leaderNode
      });
      if (!ownership.owned) {
        results.push({ runtimeId, started: false, reason: ownership.reason });
        continue;
      }
      try {
        const result = await this.admit(runtimeId, {
          config: admissionConfig,
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
          reason: String(error?.code || '').startsWith('runtime_capacity_') ? 'insufficient-memory' : 'start-failed',
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
    this.abortRuntimeTree(runtimeId, `runtime ${runtimeId} stop requested`);
    return this.withRuntimeLifecycleLock(runtimeId, () => this.stopUnlocked(runtimeId));
  }

  async stopAll() {
    const distributedMembers = new Set(
      Object.values(this.config.runtimes ?? {}).flatMap((runtime) =>
        runtime?.placement?.mode === 'distributed'
          ? (runtime.placement.members ?? []).map((member) => member.runtime).filter(Boolean)
          : []
      )
    );
    const runtimeIds = Object.keys(this.config.runtimes ?? {}).filter(
      (runtimeId) => !distributedMembers.has(runtimeId)
    );
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
    const placement = runtimePlacement(runtime, this.config);
    if (placement.mode === 'distributed') {
      this.setStatus(runtimeId, 'stopping', 'stop');
      const members = [];
      for (const member of [...placement.members].sort((left, right) => right.order - left.order)) {
        members.push({ ...member, result: await this.stop(member.runtime) });
      }
      this.setStatus(runtimeId, 'stopped');
      state.stops += 1;
      state.stoppedAt = nowIso();
      return { runtimeId, stopped: true, distributed: true, members };
    }
    if (this.clusterCoordinator && !this.clusterCoordinator.isLocalNode(placement.node)) {
      this.setStatus(runtimeId, 'stopping', 'stop');
      const result = await this.clusterCoordinator.runtimeAction(placement.node, runtimeId, 'stop');
      this.setStatus(runtimeId, 'stopped');
      state.stops += result?.stopped === false ? 0 : 1;
      state.stoppedAt = nowIso();
      return { ...result, runtimeId, node: placement.node, remote: true };
    }
    if (runtimeManagement(runtime) !== 'managed') {
      return { runtimeId, stopped: false, reason: 'externally-managed' };
    }
    if (runtimeAdapter(runtime) === 'docker') {
      const container = await dockerContainerState(runtime);
      if (!container.exists) return { runtimeId, stopped: false, reason: 'container-missing' };
      if (!container.running) return { runtimeId, stopped: false, reason: 'already-stopped' };
      this.setStatus(runtimeId, 'stopping', 'stop');
      const processResult = await dockerLifecycle('stop', runtime);
      this.setStatus(runtimeId, 'stopped');
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
