# NVIDIA Qwen3.8 Flash Next TP2 decision — September 5, 2026

> Historical v5 measurements. [Recipe v6](../2026-09-05-q38fn-gap-closure/README.md) supersedes this configuration.

Selected: official NVIDIA NVFP4 revision `fab0aecb760cec45227f6656abcaafa11abca87a`,
vLLM `8a728663c1c3eeace834a95f5654fa653cc1998c`, Tony's source-guarded PLE/MTP/QSA
fixes, disk-backed FP8 PLE, FP8 E4M3 KV, MTP3, piecewise graphs, native 262144
context, GPU utilization 0.75. Two GB10 Sparks over private RoCE; gateway admission
four active plus eight queued. Exact image and source provenance are in
[the upgrade record](../../../docs/q38fn-nvidia-tp2-2026-09-05.md).

## First accepted run

| Gate | Result |
| --- | --- |
| Text, arithmetic, streamed tool arguments, tool continuation, vision | 5/5 passed, all local |
| Mixed/repeated context structured tools | 8/8 passed, all local |
| Largest input in mixed load | 46,910 tokens; 33.676 s first delta, 44.746 s total |
| Single-stream prose, Python, arithmetic | 6/6 completed, inspected answers correct |
| Median generation rate | 36.35 tokens/s, including reasoning tokens |
| Median first delta | 276.9 ms, reasoning or content; not first visible answer |

`qwen-tony-mtp3-{smoke,load,benchmark}.jsonl` contain synthetic prompts' results.
The first benchmark's final attribution check failed because the gateway truncates
caller names at 32 characters. The original harness failure is retained privately. `qwen-tony-mtp3-attribution.json` recovers all six matching local
HTTP 200 records. The harness now emits shorter caller labels.

No matched GLM quality comparison, full 262K prompt, million-token test, MTP2/MTP4
sweep, or prefix-cache benefit is established by these results. Prefix caching
is disabled. These measurements support this selected configuration on this pair;
they do not establish the universally fastest or highest-quality Qwen stack.

## Failed experiment and recovery

The separate newer `e962733e` image with GPU-resident PLE and BF16 KV reached
compilation, then both hosts became unresponsive. Previous-boot kernel records
show NVIDIA `NV_ERR_NO_MEMORY` beginning at 18:47:03/18:47:05 UTC. Both hosts
required a user power cycle. No quality or speed result is assigned to that
candidate. The tested disk-backed configuration was restored; experimental
containers were stopped with Docker restart disabled.

DeepSeek had been drained and stopped on both ranks before any Qwen admission.
Following the user's additional isolation instruction, competing large runtimes
and their alias members are disabled/suspended on both Sparks, with keep-warm off.
Only the selected Qwen large runtime is enabled. Private configuration backups
remain on each host; model weights and the previous RadixArk recipe are retained.

Separate authenticated canaries verified the cloud branch while local was suspended
and the local-first branch after recovery. These host-specific route receipts remain
private. `recovery-smoke.jsonl` contains five passing synthetic checks;
`recovery-queue.jsonl` contains 12 passing requests, maximum four active/two queued,
and clean drain. Raw backend counters also returned to zero.

Recovery qualification: NVIDIA allocation warnings also occurred on the restored
stack while the hosts remained reachable. These logs alone do not isolate the
freeze cause. The newer candidate is rejected because it lost both hosts and
never passed inference gates; the selected configuration passed live requests
and clean drain after recovery.


## Follow-up: matched published prose prompt

At 19:38 UTC, without changing the deployed model/configuration, three idle
single-stream runs reproduced Sufyan's exact `bench_decode.py` prose prompt,
thinking disabled, temperature zero, 200-token cap, and `(completion_tokens - 1)
/ time_after_first_content` decode accounting. All three completed with local
gateway attribution and the queue drained to zero.

Median: **30.095 tokens/s**, TTFT **214.9 ms**. Sufyan's pinned NVIDIA recipe at
`fe8c291de4efba34d5dcedbc8e19ebcf66bc1bc2` publishes **43.2 tokens/s**, TTFT
**170 ms**, for that prompt/settings. Our measured throughput is **30.3% lower**;
matching it requires **43.5% higher throughput**. This controls prompt and request
settings, not host background activity, endpoint overhead, kernels, or PLE placement.
Sufyan's native GPU PLE/BF16-KV stack differs from our disk-PLE/FP8-KV stack.

`published-prose-comparison.mjs` and `published-prose-comparison.jsonl` retain the
reproduction and results. Tony's broader 40-prompt TP2 median of 35.8 tokens/s is
close to our earlier six-run mixed median of 36.35, but these are different
prompt sets with different thinking settings. Mia's 54.4 tokens/s prose headline
uses a nondefault 65,536-token balanced draft vocabulary; it is not a matched
comparison or demonstrated recoverable speedup for this installation.
