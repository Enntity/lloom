# Supervised research workers

Use this client to run bounded DeepSeek and GLM assignments through an existing
LLooM Responses gateway. It launches supervised Codex CLI subprocesses; these
external DS/GLM runs do not create native Codex subagents or add an executive to
the gateway. The separately authorized native exception is named a Codex review
worker; it does not change the DS/GLM roles or their configured model IDs here.

## Roles

| Role | Gateway model | Sandbox |
| --- | --- | --- |
| `implementer` | `deepseek-flash` | workspace-write |
| `glm-implementer` | `cloud/openrouter/glm53f` | workspace-write |
| `investigator` | `cloud/openrouter/glm53f` | read-only |
| `reviewer` | `cloud/openrouter/glm53f` | read-only |
| `ds-reviewer` | `deepseek-flash` | read-only |

The primary agent chooses experiments, defines checks, reviews critical code and
accepts changes. Workers perform bounded implementation, exploration and review.
They may repair failures within the assigned attempt budget. They may not delegate,
change providers, commit, deploy, or change model residency. Roles are reusable
instructions, not trained specialists or persistent personal memory.

The launcher explicitly selects the LLooM provider and one of the two model IDs.
It disables native subagents, memories, plugins and app tools in the child. It
retains the Codex sandbox and uses `approval_policy="never"`: commands requiring
additional permission fail instead of receiving blanket approval. These worker
settings do not change the parent's model or global Codex configuration.

## Run an assignment

Use Codex CLI with the Responses/custom-tool support described in
[codex-deepseek-workers.md](codex-deepseek-workers.md). Qualification on September
12, 2026 used CLI `0.154.0-alpha.6.2`.

Provide `LLOOM_BASE_URL` ending in `/v1` and `LLOOM_API_KEY` through a trusted
launcher or environment. Never put credentials in the manifest, prompt, command
arguments, or logs. Set `LLOOM_WORKER_STATE_DIR` to one shared private directory
for all workers that use the same hardware; its default is `.lloom-workers` under
the launching process's working directory. State must be outside the task's
checkout so that the worker cannot edit its own control records through its
workspace-write sandbox.

```sh
node clients/examples/research-workers/runner.mjs run /absolute/path/task.json
node clients/examples/research-workers/runner.mjs list
node clients/examples/research-workers/runner.mjs status task-id
node clients/examples/research-workers/runner.mjs report task-id
node clients/examples/research-workers/runner.mjs stop task-id
node clients/examples/research-workers/runner.mjs resume /absolute/path/task.json
```

`run` remains attached until completion. A supervising tool can retain the process
session and wait on it. The runner is not a scheduler or background service.
`stop` writes a cancellation request; the owning runner cancels its child. `resume`
starts a fresh worker with the stored failure evidence, the same protected hashes,
and the remaining original attempt allowance. It does not restore an invisible
model conversation. A completed successful task requires a new ID for new work.

Example manifest; replace the paths and commands with a reviewed assignment:

```json
{
  "id": "prefill-candidate-01",
  "role": "implementer",
  "cwd": "/absolute/path/to/experiment",
  "prompt": "Implement the attached bounded hypothesis. Preserve the reference path. Report exact changes and measurements.",
  "attempts": 2,
  "timeoutSeconds": 600,
  "maxToolCalls": 30,
  "resources": ["sparks"],
  "protectedFiles": ["tests/reference-correctness.py"],
  "checks": [
    {"name": "correctness", "argv": ["python3", "tests/reference-correctness.py"], "timeoutSeconds": 120},
    {"name": "canary", "argv": ["python3", "benchmarks/canary.py"], "timeoutSeconds": 120}
  ]
}
```

Checks are parent-owned executable argument arrays, run without a shell. The
parent must review them before launch; they are not sandboxed by this client.
Credentials are removed from their environment. Put authoritative test fixtures
in `protectedFiles`, or use a separate parent-controlled checkout. A worker's
claim of success cannot override a failed check. No checks means `needs_review`,
never `passed`. A passing status means the specified commands exited successfully;
it does not establish numerical quality or performance parity beyond those checks.

Checks run in order and stop at the first failure. Put inexpensive correctness and
microbenchmark gates before expensive serving tests. Failed check output returns
to the worker for a bounded repair attempt. Define performance thresholds in the
parent-owned check scripts, including the exact reference, workload, noise
allowance and numerical tolerances. Keep C4 total wall time, TTFT, prefill and
decode results separate. Worker agreement is not a substitute for measurements.

## Limits and recovery

- Two worker slots across processes using the same state directory.
- One writer per canonical checkout path (including parent check commands); explicit named resource locks serialize
  hardware work. Every Spark experiment must use the shared `sparks` resource.
- At most three attempts. Default two. An attempt is charged when its worker
  starts, including a cancelled attempt. A resume cannot reset that allowance;
  an exhausted task needs a new reviewed assignment and ID.
- Per-invocation deadline includes queue, worker and checks; default 600 seconds,
  maximum 3600. Resuming starts a new wall-clock window with remaining attempts.
- Per-attempt tool limit, default 30, maximum 100. The supervisor counts observed
  Codex tool events and cancels on overflow; it cannot retract a tool already
  dispatched. Nested provider/model calls are not allowed worker operations.
- Four MB combined stdout/stderr per subprocess; six KB final worker report.
- POSIX process supervision (macOS/Linux): timeout and cancellation terminate
  the process group, escalating to SIGKILL. A separate lifeline guardian also
  kills the worker group if its supervisor crashes or receives SIGKILL. This
  contains ordinary descendants of the supervised worker or parent check, but
  it cannot contain a service or child that deliberately detaches into a new
  process group. A detached session may survive and must be found and cleaned
  up by the parent. Workers must not start background services or detached
  sessions.
- Protected-file changes stop the job for parent review; they are never restored
  automatically over a worker's changes.

### Hardware resource quarantine and recovery

An explicit manifest resource such as `sparks` is represented by a retained
`resource-*.lock`. After supervised worker or parent-check work has started, a
signal, deadline/timeout, cancellation, supervisor output limit, or tool-call
limit makes cleanup unverifiable. The runner quarantines every explicit resource
held by that task, retains its resource lock, and does not start another attempt
on that hardware. There is no automatic retry or resume until the parent has
verified cleanup. Cancellation before any resource is acquired leaves no hardware lock to
quarantine. Cancellation after acquisition conservatively retains explicit locks.

An ordinary successful exit or ordinary nonzero exit is not a quarantine signal:
the task may complete or retry within its attempt budget, and its owned locks
release normally. A parent check that exits nonzero is likewise an ordinary
failure unless the check was signalled or stopped for a parent-side reason such
as timeout or cancellation.

Dead explicit-resource holders are never stale-reaped or otherwise auto-reaped.
A dead PID, a client exit, or a stale owner record is not evidence that GPU,
model, service, or detached-session work is clean. The parent must independently
inspect and verify cleanup, including any processes or services outside the
supervised process group, before releasing the quarantine. Once cleanup is
verified, run:

```sh
node clients/examples/research-workers/runner.mjs release TASK_ID --verified-cleanup
```

The exact `--verified-cleanup` flag is required. This CLI operation checks the
persisted task and lock ownership and releases only that task's matching locks;
it does not inspect hardware, signal PIDs, stop services, or perform cleanup.
After release, resume explicitly if the task still has attempts remaining.

State includes the manifest, status, attempt logs, final reports, check results,
protected-file hashes, Git HEAD and dirty-file summaries. Directories are created
with mode 0700 and records with mode 0600. Store them outside public source and
exclude them from version control. Logs can contain source and tool output;
retain raw logs privately and promote only deliberately reviewed artifacts.

A stale owner lock is not proof of a safe workspace. Check status and local
processes before recovering an unexpectedly crashed runner. Do not infer that a
remote GPU command stopped merely because the client exited. Ordinary completion releases owned locks; abnormal termination retains explicit
resources as described above. Locks coordinate this client only; they
do not prevent another terminal or external service from using the hardware.

Private source sharing remains subject to the user's provider authorization and
approval policy. A synthetic tool canary does not authorize private source export.
If a handoff is rejected, stop that handoff and use local review or authorized
public/synthetic material. Do not evade the rejection through a different runner.

## Qualification and remaining boundaries

Both DeepSeek and GLM reproduced a synthetic failing test, patched only the
implementation, and passed the unchanged protected test through this runner.
One run per model took 11.3 seconds for DeepSeek and 13.1 seconds for GLM; these
are connectivity/tool-use canaries, not a model-quality ranking or CUDA result.
The runner then independently executed the parent-owned verification command.

All 32 process and supervisor tests pass. They cover supervisor death, missing
Codex completion, shared deadlines, cancellation, descendants, output limits,
failed-check repairs, protected-test tampering, attempt budgets, and shared
resource serialization. A private-source review initially required explicit provider-sharing permission.
After that permission was granted, a GLM source review was stopped at its
180-second bound without a final report. A narrower DeepSeek process review
returned in 6.4 seconds and identified a missing default timeout, which was fixed
and regression-tested; its other alleged defects were rejected on review.
Synthetic tool qualification and source-review quality remain separate evidence.

This client is a foundation for experiment batches. It does not autonomously
choose research directions, schedule future runs, manipulate residency, integrate
patches, or claim results while the parent is absent. Reuse build caches and
resident experiment environments through explicit parent-managed procedures.

## Desktop visibility

Native Codex review workers appear in the desktop Subagents panel. These DS/GLM
runs are separate supervised CLI processes and do not register in that native
panel. Use the runner status/report commands for their activity and evidence.
Adding a role name does not make an external process a native Codex review
worker.
