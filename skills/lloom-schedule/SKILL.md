---
name: lloom-schedule
description: >-
  Reserve shared GPU hardware and report long-running jobs through the LLooM
  head (`lloom reserve`, `lloom release`, `lloom job`, `lloom schedule`). Use
  before running anything on shared machines (the Spark pair, build boxes,
  benchmark hosts), when the task says "take/hold/lock the pair", "is the pair
  free", "who has the GPUs", "release the pair", "wait for the pair", or when
  starting a build, benchmark, training or eval run that takes more than a few
  minutes and others should be able to follow. Replaces sideband locks such as
  pair.sh / pair-mac.sh.
---

# LLooM reservations and jobs

The LLooM head keeps one schedule. **Reservations** are expiring leases on named
resources. Taking one moves traffic away and suspends that resource's models, and
releasing it restores them once they pass a health check. **Jobs** are status
records you keep current. People and Tessera read both, so nobody has to ask you
how it's going.

## Setup

```sh
export LLOOM_HEAD_URL=http://<head>:8100   # the schedule-owning gateway
export LLOOM_HEAD_API_KEY=...              # its admin key (never pass keys on the command line)
export LLOOM_OWNER=<short-name>            # who you are on the board, e.g. buildopt
export LLOOM_SESSION=claude:<session-id>   # optional: lets Tessera open your conversation
```

On the head itself, `LLOOM_HEAD_URL` isn't needed.

## Look before you touch hardware

```sh
lloom schedule          # resources, holders, time left, who waits, running jobs
```

If a resource shows a holder or a standing reservation (for example the drafter
boxes), do not run GPU work there. Builds and containers you start yourself
aren't stopped by LLooM; honouring the schedule is on you.

## Take, keep, give back

```sh
lloom reserve pair --purpose "decode A/B: indexer v2"                      # preview the actions
lloom reserve pair --purpose "decode A/B: indexer v2" --wait --apply --yes # take it, queueing if busy
lloom renew pair                  # extend (job reports also extend it)
lloom release pair --apply --yes  # restore and free
```

- `reserve` without `--wait` fails straight away if the resource is busy, and
  names the holder. With `--wait` it queues and returns once the lease is active
  (exit 0). Ctrl-C gives your place back.
- Leases default to 30 minutes and warn 5 minutes before expiry. At expiry LLooM
  restores the resource, even in the middle of your run. Renew, or keep a job
  reporting.
- Take the lease only for the time you are using the hardware. Release as soon as
  you're done, before writing up results.
- `release` exits non-zero if the restore failed. The resource stays held (`stuck`)
  and traffic stays away from the unhealthy model. Fix the cause, release again,
  and tell the developer.

## Report a job

```sh
job=$(lloom job start "decode A/B: indexer v2" --on pair --note "building image")
lloom job progress $job 3/8 --unit arms "arm 3: 58 tok/s"
lloom job metric $job tok_s=58.2 ttft_ms=412
lloom job note $job "arm 4 OOM at 512K, retrying at 256K"
lloom job done $job "flat vs baseline at 4K, +4% at 64K" --receipt receipts/ab-1017.json
lloom job fail $job "image build broke: missing CUTLASS header"
```

- Every update is a heartbeat. After 15 minutes of silence (`--stale` sets
  another limit) the job shows as stalled on the board and in Tessera.
- A job started `--on <resource>` keeps your lease alive while it reports.
- Notes should say what a person needs to know, not log lines. Put numbers in
  metrics and file paths in `--receipt`.
- Finished, failed and stalled jobs show in Tessera's Needs-you lane. That
  replaces "how's it going?".

`--json` on any command gives the full record. `lloom help` lists everything, and
`docs/reservations.md` in the LLooM repo covers the HTTP API and resource configuration.
