# Two-Spark q38fn optimization, 9 September 2026

Status: **recipe v7 is live on both Sparks; canonical local q38fn and Presence
routing are restored and verified.** Results below are synthetic gateway measurements, not entity workloads.

## Controls

- Two DGX Sparks, private RoCE, tensor parallelism 2.
- NVIDIA Qwen3.8-Flash-Next-NVFP4, revision
  `fab0aecb760cec45227f6656abcaafa11abca87a`.
- vLLM `e962733e08d10f7ca65dac4df99e116460b8b174`, image
  `vllm/vllm-openai@sha256:df871f170ee7070fbdce162bde08fb616e311570c948a620be0d4b33fe02f87b`.
- Recipe v6 baseline: GPU-resident FP8 PLE, BF16 KV, explicit 20 GiB KV per
  rank, full-vocabulary MTP3, FULL_DECODE_ONLY graphs, compilation disabled,
  262144 context, engine sequences 8, gateway active limit 4 / queue 8,
  batch tokens 8192, low reasoning default.
- Baseline strict alias `q38fn-local`; isolated candidate `q38fn-prefix-test`.
  Every suite asserts actual gateway model attribution and HTTP status.

Presence was configured with direct ordered members local Qwen then cloud
`deepseek/deepseek-v4-flash-0731`. The local member was suspended during tests;
a synthetic Presence request proved the cloud backend and exact upstream model.
The ordinary `q38fn` local member was also suspended to prevent test interference.
Managed admission and graceful stops preserve checkpoint files. The archived
v6 recipe, pre-v7 runtime config snapshots and original resident launcher remain
available for rollback. No entity prompts or continuity data are benchmark input.

## Initial measurements

| Configuration                           | Short prose median decode | 30.8K prompt TTFT, three repeats |
| --------------------------------------- | ------------------------: | -------------------------------- |
| v6, cache disabled                      |            40.96 tokens/s | 9.71 / 9.68 / 9.88 s             |
| align cache, two block-size corrections |            38.75 tokens/s | 11.14 / 9.76 / 0.78 s            |

The first candidate completed all 14 stream probes, opaque Unicode copying,
tail-value extraction, structured tool arguments and four concurrent requests.
The code probe deliberately reaches its output cap and **does not establish
complete or executable code correctness**. These are small samples; output
lengths differ and the decode numbers do not establish a universal speed ranking.

The stronger early/middle-fact cache gate stopped on a missing first-repeat
cache hit. Its returned facts were correct, but reuse was not dependable.
This candidate is not qualified by the one fast hit.

The retention variant passed all 13 stronger cache checks, five smoke checks
(including vision and tool continuation), and twelve mixed-context tool calls
with six clients. Admission peaked at four active plus two queued and drained
to zero. Repeated long tool input improved from 10.01 to 1.01 seconds TTFT.

The first retention gate run stopped on an overly strict finish-reason
expectation: the pinned backend returns `stop` for named forced tools on the
baseline too. The corrected gate requires exactly one correctly named tool
with exact arguments, accepts baseline `stop` or `tool_calls`, and rejects
truncation. It reran with unique fresh prefixes; this is a test correction,
not a backend protocol change. `retention-cache-first-pass.jsonl` preserves
the earlier successful retrieval rows and the diagnostic is recorded here.

At batch 8192, the two staggered 65.8K-prefill probes produced 21.25 / 21.25 s
TTFT and 2.58 / 2.59 s maximum gaps in the existing decode.

## Batch-size decision

Retain **8192** for faster cold prefill. With retention held at 1600, 4096-token
batches increased the 30.8K cold TTFT from 9.76 to 10.39 seconds and cold-tool
TTFT from 10.01 to 11.23 seconds. At 65.8K overlapping prefill, TTFT increased
from 21.25 / 21.25 to 22.60 / 22.34 seconds. Existing-stream maximum gaps fell
from 2.58 / 2.59 to 1.25 / 1.10 seconds, but decode rates stayed approximately
20 tokens/s. This is a useful responsiveness tradeoff, not a throughput win.
The selected configuration prioritizes cold-prefill speed while caching handles
repeated context.

The 4096 suite completed all 14 probes and both overlap pairs. Its short-prose
median was 34.59 tokens/s, but exact generated text differed across boots, so
that number alone does not establish a causal batch-size regression.

The retained-cache 8192 variant also passed seven checks at 239,656 input
tokens: 80.17 s cold, 1.70 s warm, four identical concurrent reads in 4.87–5.08 s,
and exact structured-tool retrieval. Native configuration remains 262144; this
is a 239K qualification, not an exhaustive native-limit workload sweep.

## Retention investigation

The exact image warns that Qwen MTP has no annotated draft KV group, so its
fallback applies EAGLE block-drop lookup semantics to all groups. Removing that
drop is not a safe optimization: it protects speculative KV correctness.

The observed miss/miss/hit pattern matches the upstream report
[vLLM #53504](https://github.com/vllm-project/vllm/issues/53504). The next
isolated variant uses the supported `--prefix-cache-retention-interval 1600`
workaround, preserving the speculative block drop. The broader boundary fix
[vLLM #54713](https://github.com/vllm-project/vllm/pull/54713) is still open at
audit time and was not transplanted into the production image.

The two guarded experimental block-size changes derive from
[blazux's pinned patch](https://github.com/blazux/qwen3.8-Flash-DGX/blob/bd60fcb1b492ca920f74df7462f05da7b6d98f73/src/patch_mamba_block_size.py).
See the experimental backend's NOTICE and installer safety tests. Actual cache
semantics must pass TP2 inference gates; source similarity is insufficient.

## Reproduction and evidence

- `benchmark.mjs`, `baseline.jsonl`, `prefix-8192.jsonl`: matched probes and
  metrics deltas, including speculative acceptance and prefix-hit counters.
- `cache-correctness.mjs`, `prefix-cache-correctness.jsonl`: three independent
  ledgers, early and middle opaque keys, exact greedy cold/warm equivalence,
  alternating requests, concurrency, tools and demonstrated hit requirement.
- `stagger.mjs`: two pairs of overlapping decode and approximately 60K-token
  prefill, reporting maximum visible stream gap and TTFT; deliberately capped
  speed probes, not answer-quality claims.
- `canary.mjs`: the repository synthetic canary adapted for explicit candidate
  runtime/model attribution; reasoning, streaming tools, continuation, vision,
  mixed-context queue admission and drain checks.
- `install-candidate.mjs`, `set-candidate.mjs`: additive isolated runtime setup
  and scoped retention/batch changes, config validation and timestamped backups.
- `audit-state.mjs`: redacted effective routes, runtime counters and Presence
  backend/status counts. Loads the supported managed service environment;
  credentials are never included in evidence.

Scripts run on the Spark leader through its normal authenticated gateway.
`TEST_MODEL`, `EXPECTED_MODEL`, `METRICS_URL` select a benchmark lane;
`QWEN_MODEL_ALIAS`, `QWEN_RUNTIME`, `EXPECTED_MODEL`, `QWEN_CONCURRENCY`,
`QWEN_QUEUE_CHECK`, `QWEN_VISION_IMAGE` select canary controls.
Run suites serially so counter deltas remain interpretable.

## Final rollout verification

At 14:35–14:36 UTC, the canonical v7 service passed 30 final checks: five smoke,
thirteen cache-correctness and twelve mixed-context/admission calls. Admission
peaked at four active and two queued, then drained. Both ranks were healthy.

Ordinary `q38fn` and `enntity-presence` returned HTTP 200 through the leader and
resolved to `qwen3.8-flash-next` on backend `qwen38-flash-next`. Presence retains
cloud `deepseek/deepseek-v4-flash-0731` as its second ordered member. Subsequent
telemetry already showed five successful local Presence requests and three
active normal local requests; the post-validation activity is expected restored
traffic, not leftover benchmarks. The chat default is `qwen3.8-flash-next`.

The worker's local q38fn suspension was also removed. Its API intentionally
rejects direct inference with `worker_control_plane_only`; the leader remains
the serving endpoint. This expected restriction is recorded separately from
worker-to-leader connectivity verification.

Temporary test containers and their runtime/model/backend/alias definitions
were removed. Mounted weights, original v6 launcher, archived recipe and config
backups remain. No general gateway or Runtime deployment was performed. Recipe
and evidence changes are in the local checkout; they have not been pushed.

See `final-validation.jsonl`, `leader-route-verification.jsonl`,
`leader-route-restoration.jsonl`, `worker-route-restoration.jsonl`,
`worker-via-leader-verification.jsonl`, and `final-state.json`. Installation
hashes and repository checks are in `installation-verification.json`. The
inference hardware sample reported no active power or thermal throttling on
either Spark; historical throttle counters were unchanged from startup.
