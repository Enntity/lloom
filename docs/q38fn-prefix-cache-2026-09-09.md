# Qwen3.8 Flash Next hybrid prefix-cache qualification

Recipe v7 adds guarded hybrid-cache corrections and `align` prefix caching with
`--prefix-cache-retention-interval 1600`. The NVIDIA checkpoint, pinned vLLM
image, GPU-resident PLE, BF16 KV budget, full-vocabulary MTP3 and graph mode
remain as in v6. v6 is archived for rollback.

The initial cache-only candidate was rejected: identical long requests sometimes
missed on their first repeat. The retained-cache variant fixed that behavior on
the tested workload while retaining the speculative last-block drop needed for
correctness. This follows the supported workaround in
[vLLM #53504](https://github.com/vllm-project/vllm/issues/53504); it does not
transplant the broader unmerged boundary changes in
[vLLM #54713](https://github.com/vllm-project/vllm/pull/54713).

Two block-size corrections are derived from
[blazux's pinned source](https://github.com/blazux/qwen3.8-Flash-DGX/blob/bd60fcb1b492ca920f74df7462f05da7b6d98f73/src/patch_mamba_block_size.py).
The installer validates exact source hashes and Python syntax for both files
before writing either, and accepts only the known original or known patched
state. The NVIDIA source-guarded loader/PLE pack remains separate and unchanged.

## Measured tradeoff

On two DGX Sparks through LLooM, the retained-cache 8192-batch candidate changed
30.8K-token prompt TTFT from 9.76 seconds cold to 0.79 and 0.77 seconds on two
repeats. A repeated long structured-tool request improved from 10.01 to 1.01
seconds. Cache-disabled v6 repeated the prefill in approximately 9.7–9.9 seconds.

Short-prose median decode was 39.45 tokens/s versus v6's 40.96, approximately
4% lower. This configuration targets reused context and is not a universal
decode-throughput winner. Small synthetic samples are not broad quality or
workload-independent performance evidence.

The 4096-token batch experiment reduced overlapping-stream gaps from about
2.6 seconds to 1.1–1.25 seconds, but slowed the overlapping 65.8K-prefill TTFT
from 21.25 seconds to 22.34–22.60 seconds without improving overall decode
throughput. **8192 remains selected** for cold-prefill speed.

## Qualification evidence

- Thirteen independent-ledger checks: exact early/middle keys, three cold/warm
  greedy response comparisons, demonstrated 28,800-token hits, alternating
  fixtures, four concurrent cached reads and structured tool arguments.
- Five smoke checks: thinking off, reasoning, streaming tools, tool result
  continuation and a synthetic image.
- Twelve mixed-context tool requests from six concurrent clients: four active,
  two queued, all completed locally, and zero active/queued after drain.
- Seven near-limit checks with a 239,656-token ledger: cold read 80.17 seconds,
  warm read 1.70 seconds with 236,800 cached tokens, four concurrent identical
  reads in 4.87–5.08 seconds, and exact structured-tool retrieval.
- All suites assert the actual gateway model and status. Tests use synthetic
  prompts and never read entity continuity or private prompts.

Forced named tools on the pinned backend report `stop` on both baseline and
candidate. The gate checks the actual call, exact name and arguments and rejects
truncation; auto-selected streaming tools correctly reported `tool_calls`.

The native configured limit remains 262144 tokens; near-limit qualification
above is at 239K, not a claim that every possible 262K workload was tested.
There is no quality qualification for reduced draft vocabulary, an alternate
checkpoint/quantization, or speculative-depth changes in this experiment.

The pinned image still reports fallback to a default Triton FP8 draft-MoE
configuration (`E=512,N=320`, GB10, block shape 64x64), and its QSA state backend
does not support fused multi-step draft decode. These are further profiling and
kernel-engineering opportunities, not proven speed gains or safe launch-flag
changes. This experiment does not establish an absolute fastest possible stack.

Raw results and reproducible scripts:
[optimization evidence](../benchmarks/decision/2026-09-09-q38fn-optimization/README.md).

## Operational rollout

During optimization, `enntity-presence` uses cloud
`deepseek/deepseek-v4-flash-0731` by suspending its local member. A synthetic
request verified the exact cloud backend. The verified restored order is local
`qwen3.8-flash-next` first, cloud DS4F0731 second. The ordinary `q38fn` alias
retains its separate local-Qwen then cloud-Qwen fallback.

The isolated test runtime must be stopped before admitting canonical Qwen.
Restore local members only after strict local canaries and paired health pass.
Keep the baseline snapshot, archived v6 recipe and original resident launcher
available for rollback. Recipe changes alone do not establish a live rollout;
the final verification receipt records canonical runtime and route attribution.

Final canonical validation passed 30 checks, followed by successful local
attribution through `q38fn` and `enntity-presence`. Both ranks are healthy,
normal Presence traffic has resumed locally, and the temporary test containers
and definitions are removed. The worker API is intentionally control-plane
only; its inference connectivity was verified through the leader endpoint.
Recipe and evidence changes remain in the local checkout and are not pushed.
