# Suspend and restore a model

Use the running owner gateway to temporarily free a model's hardware:

```sh
lloom suspend local-chat --apply --yes
# Use the freed hardware for other work.
lloom resume local-chat --apply --yes
```

`local-chat` can be a gateway model ID, an alias with exactly one managed model,
or a runtime ID. Both commands print a JSON receipt. Omit `--apply --yes` to
preview the affected runtimes, models, and aliases without changing anything.
The gateway must be running with a writable, file-backed config. The CLI uses
its existing admin credentials; inference-only credentials cannot perform these
operations. Cold model loading can take minutes; resume waits for completion.

## Configure fallback once

Install and enable the managed model and put the preferred local model before
an available fallback in an ordered alias:

```json
{
  "aliases": {
    "local-chat": {
      "members": ["local-model", "cloud-model"],
      "strategy": "ordered"
    }
  }
}
```

Use that stable alias in clients. Suspension applies to the underlying runtime
across all aliases, nested aliases, and direct model requests. Aliases use their
remaining candidates; an alias with no remaining candidate becomes unavailable.
Direct calls to the suspended model become unavailable rather than silently
changing models. Resuming restores eligibility; each alias retains its existing
selection strategy. Manual alias-member suspensions remain in effect.

No route-profile edits, enabled-bit changes, recipe reinstalls, client changes,
or gateway restarts are needed for each switch. Existing `enabled`, `keepWarm`,
profiles, member order, and defaults remain unchanged. Independently disabled or
externally managed runtimes must be configured appropriately before using these
commands. An alias containing several managed models is ambiguous: specify the
exact model or runtime instead.

## Operation and recovery

Suspend atomically persists a runtime maintenance record, hot-reloads routing,
drains active requests, stops the managed runtime, and verifies that it and its
distributed members are no longer loaded. The record survives gateway restarts
and blocks request-triggered starts, keep-warm, recovery, and forced starts.
Weights and configuration remain available for restoration.

The default drain deadline is five minutes. To allow longer active requests:

```sh
lloom suspend local-chat --drain-timeout-ms 1800000 --apply --yes
```

A drain timeout leaves routing suspended but does **not** stop the busy model.
The command fails, so hardware is not reported as free. Retry suspend once work
has finished, or resume to restore service. Partial stop failures also retain
suspension; the receipt must report success before treating the hardware as free.

Resume keeps routing gated while normal guarded admission loads and warms the
model. It removes its maintenance record only after health verification. Failed
loads retain suspension so fallback stays available; retry the same command.
Admission retains memory, ownership, active-work, and resident-model protections.
It does not force incompatible workloads to coexist or terminate arbitrary
processes launched outside LLooM.

Distributed member IDs resolve to their containing group. The dry run reports
other model IDs and aliases sharing that group. Run commands on the owner
gateway. Models represented only by delegated `remoteRuntime` targets must be
operated through their owner gateway rather than a federation front end.

## Implementation and validation

The internal `runtimes.<id>.maintenance` record has `state` (`suspended` or
`resuming`), `requestedModel`, `since`, and `operationId`. Maintenance-only edits
do not trigger lifecycle reconfiguration or process restarts. Concurrent
maintenance commands serialize in the gateway; route edits and maintenance
writes share a per-file mutation queue. Config writes preserve literal environment
references and file permissions and reject detected external changes. This queue
is not a cross-process file lock: avoid simultaneous manual config writers.

Synthetic HTTP tests cover buffered and streaming fallback, active-request drain,
restart persistence, failed drain/load recovery, health-gated return, admin auth,
and forced-start exclusion. These tests do not establish cold-load performance
or hardware compatibility for a new model recipe.
