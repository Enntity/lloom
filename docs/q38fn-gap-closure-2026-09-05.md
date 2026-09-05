# Qwen3.8 Flash Next TP2 recipe v6

September 5, 2026. This deployment follows Sufyan's coherent execution mode,
retains Tony's reviewed loader and state-stride corrections, and preserves the
official NVIDIA checkpoint. Final synthetic measurements are in
[the decision evidence](../benchmarks/decision/2026-09-05-q38fn-gap-closure/README.md).

## Exact configuration

- Two DGX Spark GB10 nodes, SM121, TP2 across private direct RoCE; automatic IPv4
  RoCE-v2 GID selection, no expert parallelism.
- `nvidia/Qwen3.8-Flash-Next-NVFP4` at
  `fab0aecb760cec45227f6656abcaafa11abca87a`. Original main-expert NVFP4,
  block-FP8 MTP, per-tensor-FP8 PLE and full draft vocabulary; no re-quantization.
- vLLM `e962733e08d10f7ca65dac4df99e116460b8b174`, ARM64 image
  `vllm/vllm-openai@sha256:df871f170ee7070fbdce162bde08fb616e311570c948a620be0d4b33fe02f87b`.
- Guarded five-file e962 PLE/MTP overlay bundle. Retains newer upstream QSA packed
  indices and compact workspace; incompatible older QSA files are not overlaid.
- GPU-resident PLE, compilation mode 0, `FULL_DECODE_ONLY`, MTP3, BF16 KV.
- Explicit 20 GiB KV per rank (21474836480 bytes); the byte limit takes precedence
  over utilization 0.75. Native 262144 context, max sequences 8, batch tokens 8192.
- Prefix caching off; qwen3 reasoning and qwen3_xml structured tools; default low
  reasoning. LLooM admits four active requests, queues eight, queue timeout 240s.
- Recipe default remains on demand. The installed leader explicitly pins the
  logical Qwen cluster; worker physical rank follows managed cluster lifecycle.
  Docker restart is disabled so LLooM owns admission and restart safety.

The 12 GiB trial had 824088 KV token slots (3.14 full contexts), passed functional
and queue gates, and left about 27 GiB available under the mixed workload. The
final 20 GiB pool provides 1372997 token slots (5.24 full contexts), with
17.92/21.98 GiB minimum available on the leader/worker during final validation. Cache slots are capacity evidence, not a four-full-context quality test.

## Why v6 differs from the failed experiment

The first e962 trial used PIECEWISE and torch.compile and required a user power
cycle. The later v6 configuration follows full decode graphs with compilation
disabled. The earlier failure does not apply to every use of the same image;
previous-boot NVIDIA allocation errors also do not isolate its cause. Both
large Qwen ranks were stopped before each swap. DeepSeek was already stopped
before the first Qwen load; it was not loaded concurrently.

## Reference and comparison boundaries

[Sufyan fe8c291d](https://github.com/sfxnz/Qwen3.8-Flash-Next-NVFP4-vLLM-2x-DGX-Spark/tree/fe8c291de4efba34d5dcedbc8e19ebcf66bc1bc2)
provides the pinned image, launcher and exact short-prose benchmark. His 43.2
single-stream tok/s is the matched target. The initial v6 trial measured 41.874
versus deployed v5's 30.095, a 39.1% increase. The initial trial included the first
cold request, which took longer than later runs. Final results are reported
separately rather than selecting the fastest run.

[Tony ecab8552](https://github.com/tonyd2wild/Qwen3.8-Flash-Next-NVFP4-DGX-Spark/tree/ecab8552325655f765173adf66c9981e28197d61)
provides the reviewed PLE and mixed MTP fixes. His TP2 suite covers 40 varied
prompts; its medians cannot be compared directly to Sufyan's one prose prompt.
MTP4 is not assumed superior to MTP3 on all workloads.

[Mia c2325b22](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Dual-DGX-Sparks/tree/c2325b22602b51a5faf55fc2bebccc34f3f80b9f)
reports 54.4 single-stream prose tok/s with FP8 KV and a nondefault 65536-token
balanced draft vocabulary. Her previous BF16/full-vocabulary capture was 52.1.
The sparkDash benchmark uses a hash-map explanation and forced output length;
its timings end at the last content token. Sufyan uses short sparse-attention
prose, natural stop and stream end. The sparkDash source at
`cc44d3527e7ddd339f513bb205dce4f37072beff` defaults to 400 output tokens; the Mia
capture does not specify that setting. A reproduction with the current default
is therefore a protocol comparison, not proof of an identical historical run.
No Mia AGPL source is included in this serving bundle. Reduced draft vocabulary
is not enabled without separate acceptance and difficult-copy validation.

These are serving-performance tests, not a demonstration of intelligence or
quality parity with GLM. No million-token context claim is made.

## Operations and rollback

`q38fn` must resolve local Qwen first and its existing OpenRouter cloud member
second. Final gates passed and a public local-attributed canary verified the resumed
alias. Other large
local runtimes remain disabled and their route members suspended, per the user's
request. Existing cloud-backed Runtime traffic continues during maintenance.

Version 5, its guarded eight-file backend, immutable image and weights are kept
in the archive and installed packages. Roll back with a managed drain/stop of
both Qwen ranks, apply the archived v5 recipe, then admit through LLooM and run
local canaries before resuming the public alias. Do not start both versions.

## Final result

The final recipe measured 41.969 tok/s on the matched Sufyan test, up 39.46%
from v5 and 2.85% below his published result. The current sparkDash hash-map
protocol measured 52.263 tok/s with the full draft vocabulary. Cold 30044-token
prefill measured 2941 tok/s with exact retrieval. All 23 functional, queue and
complete-answer checks passed locally; public local and cloud route receipts
were verified separately. Backend assets match exactly across source and both
installed hosts. Temporary guards were stopped; other large locals remain
disabled. Version 5 remains available for rollback.
