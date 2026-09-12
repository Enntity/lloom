# Spark GPU takeover runbook

Use this procedure when an operator authorizes temporarily freeing the Spark
pair for an experiment. Run maintenance commands on the owner gateway; a
federation front end cannot unload a delegated remote runtime.

## Inspect and preview

Identify the exact model or distributed runtime from installed config and live
state. The IDs below illustrate a Qwen3.8 Flash deployment; verify them on the
current hosts before use.

```sh
lloom help
lloom models
lloom runtimes qwen38-flash-next-cluster
lloom route enntity-presence
lloom suspend qwen3.8-flash-next
```

The last command is a read-only preview. Review its affected models, aliases,
and distributed members. Coordinate the live entity workload before applying
maintenance. Verify that the stable client aliases have an available fallback
and that it can serve a gateway request. An alias with no remaining candidate
will be unavailable while the model is suspended.

If an explicit route-profile switch is needed, record the current profile and
preview the intended change with `lloom route` before applying it. Suspension
does not require profile changes when the alias already includes a fallback.

## Suspend and verify

```sh
lloom suspend qwen3.8-flash-next --drain-timeout-ms 1800000 --apply --yes
```

Suspend persists a maintenance gate, removes the runtime from routing across
all aliases and direct model calls, drains active requests, stops the distributed
group, and verifies unloading. It also blocks keep-warm, background recovery,
and forced starts across gateway restarts. Existing enabled bits, route profiles,
member order, and residency settings are preserved.

A drain timeout leaves routing suspended and the busy model running. A failed
stop also retains the gate. Do not start an experiment until the receipt reports
success and both hosts show the expected memory and process state. Retry suspend
after work finishes, or resume to restore service.

```sh
lloom runtimes qwen38-flash-next-cluster
lloom models
lloom route enntity-presence
```

On **each** Spark, inspect the containers or processes belonging to the affected
group and available host memory. Verify a real request through the fallback
alias and its recorded backend attribution. Use the CLI's managed credentials;
never print keys. Model-list absence alone does not establish that memory was
released.

## Restore

Finish the experiment and stop its processes before restoring the model. LLooM
does not terminate unrelated experimental processes to make room.

```sh
lloom resume qwen3.8-flash-next
lloom resume qwen3.8-flash-next --apply --yes
```

Resume keeps routing gated while admission loads and warms the model, then
restores eligibility only after health verification. Failed loads remain
suspended. Allow for cold-load time; do not assume the model is ready merely
because a process started. If a route profile was changed explicitly, restore
the recorded profile after successful resume. Verify the normal client alias
with a gateway request and confirm the intended runtime and backend attribution.

## Alias suspension is a different operation

`lloom route <alias> --suspend-member <model>` only filters one alias. It neither
unloads the model nor blocks other aliases, direct calls, or keep-warm. For
hardware takeover use `lloom suspend` and `lloom resume` as above.

If an older installed gateway lacks those commands, stop here and arrange a
reviewed upgrade or a separately reviewed legacy procedure. Do not substitute
an unguarded config edit and runtime stop while requests may still be active.

See [model maintenance](model-maintenance.md) for failure recovery, admin access,
concurrent writes, and distributed ownership; [DGX Spark](dgx-spark.md) for the
host operating model.
