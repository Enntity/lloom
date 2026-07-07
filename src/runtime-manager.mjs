import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { cleanupPortListener, terminateProcessTree } from "./process-control.mjs";

function nowIso() {
  return new Date().toISOString();
}

function compactRuntime(runtime) {
  if (!runtime) return null;
  return {
    enabled: runtime.enabled === true,
    keepWarm: runtime.keepWarm === true,
    command: runtime.command,
    args: runtime.args,
    cwd: runtime.cwd,
    port: runtime.port,
    healthUrl: runtime.healthUrl,
    startupTimeoutMs: runtime.startupTimeoutMs,
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

export class RuntimeManager {
  constructor(config, { logger = console } = {}) {
    this.config = config;
    this.logger = logger;
    this.processes = new Map();
    this.state = new Map();
    this.events = [];
  }

  stateFor(runtimeId) {
    if (!this.state.has(runtimeId)) {
      this.state.set(runtimeId, {
        status: "idle",
        starts: 0,
        stops: 0,
        startedAt: null,
        stoppedAt: null,
        lastWarmup: null,
        lastError: null,
      });
    }
    return this.state.get(runtimeId);
  }

  record(event) {
    this.events.unshift({
      at: nowIso(),
      ...event,
    });
    this.events = this.events.slice(0, 100);
  }

  getRuntime(runtimeId) {
    return this.config.runtimes?.[runtimeId] ?? null;
  }

  keepWarmRuntimeIds() {
    return [...new Set([
      ...(this.config.keepWarm ?? []),
      ...Object.entries(this.config.runtimes ?? {})
        .filter(([, runtime]) => runtime.keepWarm === true)
        .map(([runtimeId]) => runtimeId),
    ])];
  }

  processRunning(runtimeId) {
    const child = this.processes.get(runtimeId);
    return Boolean(child?.pid && child.exitCode == null && child.signalCode == null);
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
        status = healthy ? "running" : "starting";
      } else if (healthy) {
        status = "external";
      }
      runtimes[runtimeId] = {
        ...compactRuntime(runtime),
        pid: process?.pid ?? null,
        healthy,
        status,
        keepWarm: keepWarm.has(runtimeId),
        starts: state.starts,
        stops: state.stops,
        startedAt: state.startedAt,
        stoppedAt: state.stoppedAt,
        lastWarmup: state.lastWarmup,
        lastError: state.lastError,
      };
    }
    return {
      runtimes,
      events: this.events,
    };
  }

  async ensure(runtimeId) {
    return this.start(runtimeId, {
      force: false,
      warmup: true,
      reason: "model-request",
    });
  }

  async start(runtimeId, {
    force = false,
    warmup = true,
    reason = "manual-start",
  } = {}) {
    if (!runtimeId) return { runtimeId, started: false, reason: "no-runtime" };
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) return { runtimeId, started: false, reason: "unknown-runtime" };
    const state = this.stateFor(runtimeId);

    if (await healthOk(runtime.healthUrl)) {
      state.status = "running";
      const warmupResult = warmup ? await this.warmup(runtimeId, runtime) : null;
      return {
        runtimeId,
        started: false,
        healthy: true,
        reason: "already-healthy",
        ...(warmupResult ? { warmup: warmupResult } : {}),
      };
    }

    if (runtime.enabled !== true && !force) {
      return { runtimeId, started: false, healthy: false, reason: "runtime-disabled" };
    }

    if (!runtime.command) {
      throw new Error(`runtime ${runtimeId} is enabled but has no command`);
    }

    const existing = this.processes.get(runtimeId);
    if (existing && existing.exitCode == null) {
      return this.waitForHealth(runtimeId, runtime, existing);
    }

    state.status = "starting";
    state.lastError = null;
    const child = spawn(runtime.command, runtime.args ?? [], {
      cwd: runtime.cwd,
      env: {
        ...process.env,
        ...(runtime.env ?? {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.unref();
    this.processes.set(runtimeId, child);
    state.starts += 1;
    state.startedAt = nowIso();
    this.record({ runtimeId, event: "start", pid: child.pid, reason, force });

    child.stdout?.on("data", chunk => {
      const line = String(chunk).trim();
      if (line) this.record({ runtimeId, event: "stdout", message: line.slice(0, 500) });
    });
    child.stderr?.on("data", chunk => {
      const line = String(chunk).trim();
      if (line) this.record({ runtimeId, event: "stderr", message: line.slice(0, 500) });
    });
    child.on("error", error => {
      state.status = "failed";
      state.lastError = error?.message ?? String(error);
      this.record({ runtimeId, event: "error", message: state.lastError });
    });
    child.on("exit", (code, signal) => {
      const expectedStop = state.status === "stopping" || ["SIGTERM", "SIGKILL"].includes(signal);
      state.status = code === 0 || expectedStop ? "stopped" : "failed";
      state.stoppedAt = nowIso();
      state.lastError = state.status === "stopped" ? null : `process exited code=${code} signal=${signal ?? ""}`.trim();
      this.record({ runtimeId, event: "exit", code, signal });
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
      ...(warmupResult ? { warmup: warmupResult } : {}),
    };
  }

  async waitForHealth(runtimeId, runtime, child = null) {
    const state = this.stateFor(runtimeId);
    const deadline = Date.now() + (runtime.startupTimeoutMs ?? 300000);
    while (Date.now() < deadline) {
      if (await healthOk(runtime.healthUrl)) {
        state.status = "running";
        this.record({ runtimeId, event: "healthy" });
        return { runtimeId, healthy: true };
      }
      if (child && child.exitCode != null) {
        const message = `runtime ${runtimeId} exited before becoming healthy`;
        state.status = "failed";
        state.lastError = message;
        throw new Error(message);
      }
      await delay(500);
    }
    state.status = "failed";
    state.lastError = `runtime ${runtimeId} did not become healthy before timeout`;
    throw new Error(`runtime ${runtimeId} did not become healthy before timeout`);
  }

  async warmupById(runtimeId) {
    const runtime = this.getRuntime(runtimeId);
    if (!runtime) return { runtimeId, warmed: false, reason: "unknown-runtime" };
    if (!(await healthOk(runtime.healthUrl))) {
      const result = { runtimeId, warmed: false, reason: "not-healthy" };
      this.stateFor(runtimeId).lastWarmup = result;
      return result;
    }
    return this.warmup(runtimeId, runtime);
  }

  async warmup(runtimeId, runtime) {
    const state = this.stateFor(runtimeId);
    const warmup = runtime.warmup;
    if (!warmup?.url) return { runtimeId, warmed: false, reason: "no-warmup" };
    const startedAt = Date.now();
    try {
      const response = await fetch(warmup.url, {
        method: warmup.method ?? "POST",
        headers: {
          "content-type": "application/json",
          ...(warmup.headers ?? {}),
        },
        body: warmup.body ? JSON.stringify(warmup.body) : undefined,
      });
      const text = await response.text().catch(() => "");
      const result = {
        runtimeId,
        warmed: response.ok,
        status: response.status,
        latencyMs: Date.now() - startedAt,
      };
      state.lastWarmup = result;
      this.record({
        ...result,
        event: "warmup",
        bodyPreview: text.slice(0, 300),
      });
      return result;
    } catch (error) {
      const result = {
        runtimeId,
        warmed: false,
        latencyMs: Date.now() - startedAt,
        error: error?.message ?? String(error),
      };
      state.lastWarmup = result;
      this.record({ ...result, event: "warmup" });
      return result;
    }
  }

  async startKeepWarm() {
    const results = [];
    for (const runtimeId of this.keepWarmRuntimeIds()) {
      const runtime = this.getRuntime(runtimeId);
      if (!runtime) {
        results.push({ runtimeId, started: false, reason: "unknown-runtime" });
        continue;
      }
      if (runtime.enabled !== true) {
        results.push({ runtimeId, started: false, reason: "runtime-disabled" });
        continue;
      }
      results.push(await this.start(runtimeId, {
        force: false,
        warmup: true,
        reason: "keep-warm",
      }));
    }
    return results;
  }

  async stop(runtimeId) {
    const runtime = this.getRuntime(runtimeId);
    const state = this.stateFor(runtimeId);
    const child = this.processes.get(runtimeId);
    let processResult = null;
    if (child?.pid) {
      state.status = "stopping";
      processResult = await terminateProcessTree([child.pid]);
      this.processes.delete(runtimeId);
    }
    let portResult = null;
    if (runtime?.port) {
      portResult = await cleanupPortListener(runtime.port);
    }
    state.status = "stopped";
    state.stops += 1;
    state.stoppedAt = nowIso();
    this.record({ runtimeId, event: "stop", processResult, portResult });
    return {
      runtimeId,
      stopped: true,
      processResult,
      portResult,
    };
  }
}
