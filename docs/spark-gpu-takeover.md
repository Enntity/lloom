# Spark GPU takeover runbook

Temporarily reclaim the DGX Spark pair from a resident local model so an
experiment can own the hardware, while entity presence keeps serving from an
external provider. The operation is reversible, but it moves live cognition off
local silicon, so run the steps in order and verify each one.

**Trigger.** The operator says _"take over the sparks for experiments"_ (or asks
to unload a resident model / free the Sparks / reclaim the GPUs). `spark-01` is
the cluster head and owns the client-visible catalog; run everything there unless
a step says otherwise.

## Three independent axes

Conflating these is the usual mistake. They are configured and enforced
separately.

| Axis         | Mechanism                                                | Controls                                   |
| ------------ | -------------------------------------------------------- | ------------------------------------------ |
| Routing      | `aliases[].members`, `routeProfiles`, `suspendedMembers` | which member serves a given client ID      |
| Availability | `runtimes[].enabled`                                     | whether a model is callable at all         |
| Residency    | `keepWarm`, `policy.priority`, `runtimePolicy.autoEvict` | whether a process starts or may be evicted |

Route suspension moves only the first axis. It does not stop a running process,
and it cannot block a request that names the bare model ID — see
[Why suspend alone is not enough](#why-suspend-alone-is-not-enough).

## Pre-flight

```bash
ssh spark-01
curl -sS http://127.0.0.1:8100/health
lloom models                              # client-visible catalog
jq '.aliases["enntity-presence"]' ~/.lloom/config.json
```

Establish the runtime group and its footprint before touching anything. For the
Qwen3.8 Flash lane:

| Fact          | Value                                                                                 |
| ------------- | ------------------------------------------------------------------------------------- |
| Gateway model | `qwen3.8-flash-next` (`advertise: true`)                                              |
| Runtime group | `qwen38-flash-next-cluster` (distributed TP=2)                                        |
| Placement     | `qwen38-flash-next-head` on `spark-01` + `qwen38-flash-next-worker` on `spark-02` |
| Memory        | ~108 GB per node                                                                      |
| `keepWarm`    | `false` on the cluster and both members                                               |

Per `AGENTS.md`, coordinate the live workload first: gracefully drain the resident entity's
Runtime presence or otherwise agree the window before unloading. Do not unload
mid-request.

## Procedure

### 1. Shunt presence traffic to cloud

Record the active profile first so it can be restored, then switch:

```bash
lloom route enntity-presence                          # shows activeRoute
lloom route enntity-presence qwen-openrouter --apply --yes
```

This is an atomic config write plus hot-reload, so entity cognition never sees a
gap. Disabling the runtime in step 2 would also make `enntity-presence` fall
through to its cloud member, but the explicit switch keeps presence off a failing
local member and records operator intent.

### 2. Close the availability gate

There is no CLI for this. Edit installed config and let the gateway hot-reload —
`src/server.mjs` watches the config with
`watchFile(configPath, { interval: 500 }, reloadConfig)`.

```bash
CONFIG=~/.lloom/config.json
CONFIG_MODE=$(stat -c '%a' "$CONFIG")
cp "$CONFIG" "$CONFIG.pre-takeover-$(date -u +%Y%m%dT%H%M%SZ)"
jq '.runtimes["qwen38-flash-next-cluster"].enabled = false' "$CONFIG" > "$CONFIG.tmp"
chmod "$CONFIG_MODE" "$CONFIG.tmp"   # keep 0600 — the config holds provider keys
mv "$CONFIG.tmp" "$CONFIG"
```

With `enabled: false`:

- targets whose runtime is disabled are filtered out of the catalog
  (`src/registry.mjs`), so the model leaves `/v1/models` and a direct request
  resolves to no candidate;
- on-demand start returns `{ started: false, reason: 'runtime-disabled' }`
  (`src/runtime-manager.mjs`).

Disable the runtime the **model** references, plus every target if the model is
replicated. A config reload does not stop an already-running process — that is
step 3.

### 3. Unload

```bash
lloom runtime-stop qwen38-flash-next-cluster
```

For a distributed group this tears down head **and** worker, releasing memory on
both Sparks. Confirm the container/process is actually gone in step 5 rather than
trusting the command's return value.

### 4. Suspend the alias members

```bash
lloom route q38fn --suspend-member qwen3.8-flash-next --apply --yes
lloom route q38fn-local --suspend-member qwen3.8-flash-next --apply --yes
```

Suspension additionally drops the member from preferred-member background
recovery. With step 2 already in place this is belt-and-braces, but it records the
maintenance state in the alias config where the next operator will look for it.

### 5. Verify

```bash
# model must be gone from the client-visible catalog
curl -sS http://127.0.0.1:8100/v1/models | jq -r '.data[].id' | grep -i 'qwen3.8' || echo 'not advertised'

# no process or container left behind
docker ps --format '{{.Names}}' | grep -i qwen38 || echo 'no container'
ps -eo args | grep '[v]llm serve' || echo 'no vllm process'

# presence is on the external member
lloom route enntity-presence

# host headroom (both nodes for a distributed group)
free -g | head -2
```

Admin endpoints such as `/gateway/routing` reject the inference key; use the
gateway's admin credential synced from the running service environment (see
`AGENTS.md`), and never print it.

## Why suspend alone is not enough

Suspension lives on the **alias** (`aliases[].suspendedMembers`) and only filters
alias expansion (`src/alias-resolution.mjs`, consumed by `src/registry.mjs`).
There is no model-level suspension. The local model is reachable through several
paths:

| Path                           | Covered by suspending `q38fn`?                                    |
| ------------------------------ | ----------------------------------------------------------------- |
| `q38fn` (stable alias)         | Yes                                                               |
| `q38fn-local` (canary alias)   | No — separate alias, needs its own suspension                     |
| `qwen3.8-flash-next` (bare ID) | No — advertised and directly callable; suspension cannot reach it |

For a non-alias request the registry resolves `[requestedId]` verbatim, so a
request to the bare ID re-admits and reloads the model even while every alias
member is suspended. `runtimes[].enabled = false` is the only mechanism that
satisfies "stays unloaded even if requested".

## Gotchas

- **Keep-warm outranks suspension across a restart.** Route suspension and
  residency pins are independent. If the resident runtime is `keepWarm: true`,
  startup admission can reload it on a gateway restart even while its alias member
  is suspended. Clear `keepWarm` as part of the takeover, then restore it.
  (`lloom keep-warm` only starts and lists keep-warm runtimes; it does not clear
  the pin.) `q38fn` is already `keepWarm: false`, so nothing auto-starts it.
- **`autoEvict` is not an unloader.** It only evicts when another runtime is
  admitted and memory is tight; nothing reaps an idle runtime, and there is no
  idle auto-stop. A takeover that relies on "it will get evicted" leaves the
  model resident.
- **Stop the group, not a member.** Stopping only `-head` or `-worker` leaves the
  other half of the tensor-parallel group resident and holding memory.
- **Cold start is expensive.** Restore is on-demand and reloads from cached
  weights, but budget load time (this runtime's `startupTimeoutMs` is 2 h) rather
  than assuming an instant return.
- **Config edits are validated.** `loadConfig` rejects an invalid candidate and
  keeps the running config, but back up first and preserve the mode: the file
  holds provider credentials.

## Restore

Re-open the gate, resume the members, then put presence back on the recorded
profile:

```bash
CONFIG=~/.lloom/config.json
CONFIG_MODE=$(stat -c '%a' "$CONFIG")
jq '.runtimes["qwen38-flash-next-cluster"].enabled = true' "$CONFIG" > "$CONFIG.tmp"
chmod "$CONFIG_MODE" "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"

lloom route q38fn --resume-member qwen3.8-flash-next --apply --yes
lloom route q38fn-local --resume-member qwen3.8-flash-next --apply --yes
lloom route enntity-presence before-context-test --apply --yes   # profile recorded in step 1
```

The runtime starts on demand on the next request, or explicitly with
`lloom runtime-start qwen38-flash-next-cluster`. Verify with `lloom models`,
`lloom route enntity-presence`, and a real gateway request before declaring the
handback complete.

## Worked example — Spark pair, Qwen3.8 Flash

Observed on 2026-09-11 with `spark-01` as `leaderNode`
(`nodeId: spark-01`, cluster members `spark-01`, `spark-02`,
`workstation-local`):

```bash
lloom route enntity-presence qwen-openrouter --apply --yes
# → changed: true, activeRoute: qwen-openrouter,
#   members: ["cloud/openrouter/q38fn"]
```

The gateway hot-reloaded with `NRestarts=0`, the persisted config matched the
live `/gateway/routing` state, and a minimal `enntity-presence` completion was
served by the external provider. The local member was still running at that
point — the profile switch alone does not unload it, which is the reason steps 2
and 3 exist.

## See also

- `docs/dgx-spark.md` — Spark operating model and dual-Spark layout
- `docs/architecture.md` — alias members, route profiles, suspension, residency
- `docs/long-prefill-transport.md` — suspension vs keep-warm independence
- `AGENTS.md` — Spark and Enntity operations, credential and coordination rules
