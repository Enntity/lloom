# DS4FV two-Spark tuning audit — 2026-09-05 UTC

## Measured profile and validation status

Recipe v4 is the last measured profile in this audit. Recipe v5 adds two inflight
prefills and `NCCL_GIN_ENABLE=0`; it passed local package/tests but was never deployed
or measured. It remains archived as an explicitly unmeasured candidate; the bundled
current recipe uses v4.

This is an improved, benchmarked profile, **not proof of a global optimum**.
The main measured benefit is the 128K cold-prefill probe (~123 s to ~99 s). The
16K/64K workload was broadly unchanged. Three/four admitted requests trade slower
early completion for modest batch throughput gains and lack full-context capacity;
retain two active/eight queued, one inflight prefill, 262K context, 16K batch, K=5.

**Open validation:** the strict 128K exact-code test fails identically on v2/v3/v4;
native image, thinking-enabled tool, and longer sampled cache-repeat checks were
prepared but not run on v4 before the audit ended. Do not describe this update as having
passed those new live canaries. Runtime-side prompt-cache work remains separate.

## Scope and attribution

This audit measures the explicit gateway model `deepseek-v4-flash-vision-exp`.
It does not establish the behavior of any consumer's alias or routing policy.

Hardware: two DGX Spark GB10 hosts, TP=2 over the existing dual-rail RoCE fabric.
Model: `deepseek-ai/DeepSeek-V4-Flash-Vision-Exp`, revision
`86f746b36186f0e567729a5c06a8c918caba82a9`. The newer model-repository revision
checked during the audit changed documentation/evaluation metadata, not model bytes.
Image: `ghcr.io/anemll/dspark-vllm-gx10:0.1.1` pinned to
`sha256:a83948492cf13df455170fb42885f5ef4db54fefe0feff0f841ecbff464ac9d8`.
vLLM: `0.25.2.dev0+g752a3a504.d20260714`. The checkpoint's quantization is unchanged.

## Upstream review

Reviewed [MiaAI's exact 9414dd58 tree](https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark/tree/9414dd58b0b34548032dfd30f5aa13c37f6b93b8),
eleven commits beyond the previously integrated f5665e8 tree. The new pack preserves
the existing vision, grammar/tool, scheduler-fairness and cache-correctness chain.
It adds the source-pinned sparse-SWA RoPE and DSpark draft-prefix fixes from
[PR222](https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark/pull/222) and
[PR223](https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark/pull/223).
These are opt-in upstream; local live checks, not a merge alone, determine acceptance.

A subsequent live recheck found upstream had advanced to
[`5cb77ab4`](https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark/commit/5cb77ab4befe62d8a9a09ecbc3849fffc29a9721)
during this run. Its only additional functional change is `NCCL_GIN_ENABLE`
passthrough. The next candidate includes `NCCL_GIN_ENABLE=0`, selecting CPU-driven
communication initialization; this is a bootstrap option, not a different model or
decode kernel. Patch files are unchanged and retain their original 9414dd58 pins.
The latest published Anemll release at that recheck remained v0.1.1.

The sequence-parallel prefill candidate splits long-prompt Lightning-indexer key
scoring across TP ranks and merges their top-k candidates. Decode and short prompts
remain on the stock path. Its companion SM121 header repair makes cold DeepGEMM JIT
compilation independent of previously populated caches.

The older text-only DS4F recipe used greedy drafting, an 8K batch and 0.73 memory
utilization. Vision v2 used probabilistic drafting, a 16K batch and 0.835 utilization.
Both use K=5 and a 1024-token long-prefill chunk. K=5 matches this DSpark checkpoint's
trained block size; older README K=6/divisibility guidance is superseded by the
block-k unlock. Upstream's greedy-draft comparison was a tie, so it is not assumed
to be a portable speed win. Larger prefill chunks and higher memory utilization
are not promoted without memory headroom.

## Method

Harness: [ds4fv-tuning-benchmark.mjs](../scripts/ds4fv-tuning-benchmark.mjs).
Synthetic garden-observation records only; no entity prompt content. Streaming
OpenAI chat through the authenticated gateway, temperature 0, thinking disabled,
512-token output ceiling. A separate reasoning/tool canary tests thinking-enabled
behavior. Four independently prefixed requests arrive one second apart, each with
16K or 64K input tokens and a requested 250-word summary. Two trials per case.
Unique early system prefixes prevent cross-request prefix-cache reuse in load tests.

End-to-end output throughput includes prompt processing and LLooM queue time;
it must not be described as steady decode speed. TTFT includes admission waiting.
Very short completions are excluded from decode-rate estimates because speculative
token bursts make their rates misleading. Baseline raw quality receipts predate
that reporting correction; their short-output `decodeTps` values must be ignored.

## Initial control

Recipe v2: 262144 context, 16384 batch, engine max sequences 4, K=5, probabilistic
drafting, one inflight prefill, LLooM two active/eight queued, queue timeout disabled,
five-second Retry-After on a full queue. GPU-memory utilization 0.835.

| Four-request workload | Trial | Wall time | Aggregate output tok/s | Worst TTFT |
| --- | --- | --- | --- | --- |
| v2, 16K | 1 | 66.7 s | 18.56 | 52.5 s |
| v2, 16K | 2 | 64.9 s | 18.19 | 50.2 s |
| v2, 64K | 1 | 190.3 s | 6.47 | 175.8 s |
| v2, 64K | 2 | 189.2 s | 6.50 | 173.0 s |

All baseline load-test retrieval answers were correct. No engine preemptions were
observed. Available host memory during load was approximately 5.8–6.7 GiB per host;
the existing swap allocation was not treated as proof of active swapping.

## Quality limitation found, not hidden

The exact-code 16K retrieval prompt passes cold and twice cached. The same prompt
at 131273 input tokens returns `cobalt-739` instead of `cobalt-7391`, with a normal
stop and only five output tokens. This occurs cold and cached on **both v2 and v3**.
The new RoPE/prefix fixes do not cure this particular failure.

On v3, raw-backend buffered, gateway buffered and raw-backend streaming calls all
return the same incomplete string. Appending an explicit instruction to include
all four digits retrieves `cobalt-7391` from the cached prompt. This rules out
LLooM streaming truncation for this probe; it does not establish whether the model,
quantization or speculative runtime is responsible. It is not evidence of a general
128K quality pass. Streaming required-tool JSON passes on both versions.

## Deployment discipline

Build commit IDs below identify local measurement builds predating the sanitized
public commit. Artifact SHA256 values preserve the exact measured package identity.

Recipe v3 deployed from LLooM `f213bf419eb9dd7826edae034d2ff5d859141143`, artifact
SHA256 `74ae6f0cebbeaff370414b7f2d6084bf702533eaa378e69b97f134fb3d6bf88a`.
Both ranks applied and verified both new correctness patches. Deployment now supports
`--preserve-routes`: recipe setup occurs in a staged config, existing route policy is
restored before atomic replacement, and normal route reconciliation is skipped.
Tests cover preserving alias order/suspension while retaining runtime updates.

Completed candidate results are below. An unmeasured candidate is not a recommendation.

## Correctness-only v3 control

| Four-request workload | Trial | Wall time | Aggregate output tok/s | Worst TTFT |
| --- | --- | --- | --- | --- |
| v3, 16K | 1 | 67.3 s | 19.01 | 51.7 s |
| v3, 16K | 2 | 66.4 s | 18.59 | 50.6 s |
| v3, 64K | 1 | 183.6 s | 5.96 | 170.7 s |
| v3, 64K | 2 | 180.3 s | 6.41 | 166.1 s |

All load-test retrievals passed, no preemptions observed. Output lengths vary, so
the modest wall-time difference from v2 is not evidence of a large throughput win.
Hardware samples during load: both GPUs approximately 96% utilization, 80–81 C,
2.4 GHz graphics clock; `vmstat` interval samples showed zero swap-in/out and
memory pressure averages near zero. Stored swap usage alone was not the bottleneck.

## Sequence-parallel v4 deployment

Both ranks installed `6b38cb7e9bb0e6734a67d064c55b606b97ab3370`, artifact SHA256
`809d44036b72d9d475467751446902ae0be964d919f5971fdc3745e0b56b3a3f`.
Both manifests match; the SP patch reports applied. Engine capacity: 557978 KV
tokens, exceeding 2 × 262144. Higher admission experiments are restricted to
synthetic 16K/64K requests and automatically restore the two-active limit.

Validation before deployment: clean `npm run check`, full `npm test`, interchange,
package installation smoke; new hermetic SP transform/idempotence/drift and cold-JIT
header tests; upstream partition/bounds math tests run with CPU PyTorch inside the
pinned image. The upstream host-side Docker test skipped because its mutable image
tag was absent; the added hermetic transform test uses source extracted from our
actual digest-pinned image instead. No skipped test is counted as a pass.

The first v4 128K cold probe reached its first token in 99.4 seconds, versus
123.5 seconds on v3, despite a logged first-use
`StableTopKFromGatheredCandidatesKernel` compilation. That log also confirms the
new SP path actually executed. The exact-code quality failure remains unchanged.
This is a single long-context timing, not a statistical throughput claim.

Admission screening (one trial per size/cap; same synthetic four-request harness):

| Cap | Input per request | Batch wall time | Aggregate output tok/s | First request completion | Worst TTFT |
| --- | --- | --- | --- | --- | --- |
| 2 | 16K | 65.8 s | 18.84 | 32.3 s | 50.1 s |
| 2 | 64K | 187.2 s | 6.23 | 92.3 s | 173.0 s |
| 3 | 16K | 63.0 s | 19.21 | 42.5 s | 50.3 s |
| 3 | 64K | 179.4 s | 6.74 | 126.4 s | 166.7 s |
| 4 | 16K | 54.9 s | 20.40 | 50.5 s | 38.3 s |
| 4 | 64K | 181.5 s | 6.31 | 132.3 s | 166.5 s |

All recorded answers above are correct. Higher caps improve batch throughput at
the expense of the first request's completion time. Four full 262K contexts would
exceed measured KV capacity; small-prompt success cannot justify that production
limit. The supported context contract remains unchanged.

Both selected RDMA rails showed increasing transmit counters during serving;
unused rails remained at zero. No vLLM preemptions were observed. Higher-cap
monitoring saw small page-in activity and brief head page-out activity, with
near-zero memory-pressure averages; this is not a claim of zero paging throughout.

Raw synthetic receipts are in [benchmark-data/ds4fv-2026-09-05](benchmark-data/ds4fv-2026-09-05/).
The latest harness also includes `vision`, `reasoning`, `cache`, and `diagnostic`
modes and optional `TUNING_TEMPERATURE` / `TUNING_TRIALS` controls. Prepared modes
are not evidence of execution. All image bytes stay outside the repository.
