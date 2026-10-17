# Request scheduling

LLooM gives foreground requests the next available capacity and slows lower
priority work while they run. Accepted requests stay on their existing HTTP
connection. Active streams finish normally. After interactive work is idle,
background work resumes gradually without a backlog burst.

No client changes are needed for recognized Codex, Claude, OpenCode, Oh My Pi,
and Hermes caller families. To give an otherwise unrecognized chat client
priority, assign its API key once:

```json
{
  "server": {
    "foregroundIdleMs": 60000,
    "requestScheduling": {
      "apiKeyEnv": { "CHAT_API_KEY": "foreground" }
    }
  }
}
```

The key must also be authorized by the existing inference security policy.
Priority never grants authentication or administrative access. Values are
`foreground`, `interactive`, or `standard`, in descending priority. FIFO order
applies within a class. Sustained higher-priority demand can keep lower work
waiting; that is the configured priority policy.

Classification uses this precedence:

1. A configured API-key identity in `apiKeyEnv`, matched against the environment.
2. An explicit `x-lloom-request-class` header. Unknown values become standard.
3. A caller-family entry in `clients`, identified by `x-lloom-client`,
   `x-client-name`, or recognized user agent.
4. Recognized coding families default to foreground; others default to standard.

Caller-family metadata is supplied by the authenticated caller and can be
spoofed. Use credential policies when callers must not choose their priority.
Explicit standard headers keep Runtime background cognition standard even
when its caller family has a different default. LLooM never inspects prompts
to decide priority. Effective classes cross authenticated federation hops;
raw model providers receive no LLooM priority headers.

## Configuration

These are the default settings; usually only the identity policy needs editing:

```json
{
  "server": {
    "foregroundIdleMs": 60000,
    "requestScheduling": {
      "mode": "adaptive",
      "maxQueuedRequests": 1024,
      "queueTimeoutMs": 0,
      "backgroundMaxConcurrency": 4,
      "rampIntervalMs": 1000,
      "clients": {},
      "apiKeyEnv": {},
      "modelGroups": {}
    }
  }
}
```

`foregroundIdleMs` is the quiet interval after the last higher-priority request
finishes or disconnects. Each foreground request renews it. Interactive work
also holds standard work. After that interval, background concurrency starts
at one and grows toward `backgroundMaxConcurrency` by one every
`rampIntervalMs`; starts are paced during recovery. A zero ramp interval
restores the full background cap immediately. This cap operates across the
compute group, within each runtime's and limiter's stricter total capacity.
Already-running work can exceed a newly lowered background cap and drains
normally. A queue timeout of zero imposes no LLooM scheduling deadline.

Managed local runtimes share the `local` group. Federated serving nodes have
separate node groups. Unmanaged endpoints are grouped by backend. For multiple
backend definitions that share hardware, or independent local devices, use
`modelGroups` to assign the same or different group names to their model IDs
or aliases. Resolution checks the requested ID, resolved ID, then concrete
model ID. For example:

```json
{
  "server": {
    "requestScheduling": {
      "clients": { "my-chat-app": "foreground", "batch-worker": "standard" },
      "modelGroups": { "chat": "spark", "cognition": "spark", "cloud": "cloud" }
    }
  }
}
```

The waiting room is bounded by `maxQueuedRequests` per class per group, so a full
background queue cannot block foreground admission. Runtime queues
use that same bound and timeout in adaptive mode. Full queues return retryable
429 `REQUEST_QUEUE_FULL` or `RUNTIME_QUEUE_FULL`; configured wait deadlines
return `REQUEST_SCHEDULING_TIMEOUT` or `RUNTIME_QUEUE_TIMEOUT`. Caller aborts
remove queued work before dispatch. Shutdown rejects pending admissions.

Model and alias rate limits compose atomically with runtime admission: waiting
requests consume neither concurrency slots nor rate tokens. Adaptive mode
waits for hard rate budgets by default, giving eligible higher-priority work
the next token. Completed requests still consume their budget. Set an individual
`rateLimit.queue: false` to retain deliberate fast rejection when that budget
is exhausted. Limits and scheduling settings can be hot-reloaded without
canceling active requests.

An optional `rateLimit.requestClasses` array scopes a model or alias limit to
specific existing priorities. For example, `requestClasses: ["standard"]` with
`rate: "4.5/m"`, `burst: 0`, and `queue: true` spaces background calls without
making foreground or interactive callers wait for that budget. The selected
classes share the limiter; omitted means all three classes. Exempt requests
neither reserve its concurrency slots nor spend its rate tokens. Every other
applicable limit and runtime-capacity rule still applies, and priority within
each compute group is unchanged. Config reloads preserve the spent bucket while
updating which classes use it, including already waiting requests.

Adaptive requests also wait through a needed cold start instead of receiving
the earlier startup retry response. Model-loading admission checks priority
before changing residency and yields before its next mutation when higher
demand arrives. An already-running load finishes safely. Permanent startup or
memory-capacity failures remain visible; a healthy alias alternative can still
serve the request while a speculative startup proceeds.

Held lower-priority runtime waiters return to the scheduling queue so they do
not pin model residency. They check health again before resuming. Adaptive
capacity waits let eligible work drain and preserve pauses owned by maintenance
or watchdog recovery. A configured `queueTimeoutMs` bounds the complete wait
through scheduling, cold startup, rate budget, and runtime capacity; it stops
once upstream inference is admitted.

`GET /gateway/status` reports `requestScheduling`: mode, running and waiting
counts per class and group, background capacity, cooldown deadline, and recovery
state. Request metrics retain the effective `requestClass`.

## Compatibility and operational limits

`mode: "interrupt"` retains the earlier gateway-wide foreground cancellation
window, including retryable 409 `INTERACTIVE_PRIORITY` holds. `mode: "off"`
keeps the earlier runtime queue and rate-limit behavior. Adaptive is the default.
Both compatibility modes use the earlier explicit request-class header;
automatic caller and credential classification applies in adaptive mode.

Priority controls admission, not GPU preemption. On a single-slot backend,
foreground waits for the current request to finish. Configure safe runtime
concurrency and optional interactive reservations when faster overlap is
supported. LLooM never restarts an emitted stream to simulate preemption.

The queue is in process and stores no durable prompts. A caller must keep its
connection open; its own timeout, a gateway restart, upstream failures, and
explicit queue bounds can still end the request. Durable delivery across those
boundaries requires a client-owned job/checkpoint protocol. Runtime adds
checkpoints and deferred cognition on top of LLooM admission.
