# q38fn upstream and live-route audit — 2026-09-05

> Historical audit, before the NVIDIA upgrade later on September 5. Present-tense
> statements below describe that earlier snapshot, not the current installation.
> See [the NVIDIA TP2 upgrade and validation](q38fn-nvidia-tp2-2026-09-05.md)
> for the subsequent checkpoint replacement, testing, and recovery.

The installed recipe matches the latest **dual-Spark serving implementation**
from MiaAI, but it does not include newer community correctness fixes. Do not
describe it as fully current or claim a local inference canary from this audit.

**Publisher audit correction:** the initial audit checked whether RadixArk had
updated its existing checkpoint but missed NVIDIA's separate August 31 release,
[`nvidia/Qwen3.8-Flash-Next-NVFP4`](https://huggingface.co/nvidia/Qwen3.8-Flash-Next-NVFP4).
Our installed model is RadixArk's quant, not NVIDIA's release. NVIDIA uses
MSE-calibrated main-expert NVFP4, FP8 MTP routed experts, and FP8 PLE. RadixArk
keeps its MTP tensors BF16. NVIDIA specifies vLLM commit
`d4d703caf908786416585ceb1f369e2e0363358b` or later and reports validation on
B200/B300, not this GB10 pair. Its published multi-domain quality results make
it a priority candidate for the next matched TP2 evaluation, but do not establish
superiority to RadixArk or GLM on our hardware. No NVIDIA weights were installed
and no recipe was switched in this follow-up.

## Verified installed baseline

Both Sparks and this checkout have identical recipe/entrypoint hashes:

- Recipe: `42c8e6e1833e0bb5b554769f44f6f47e4483279640fab6a9ab9a40ff8b7e5831`
- Entrypoint: `37ea19977507ac4d266532eb784e9e28e68107888a6deec3bb14354d45acd9ef`
- Recipe `linux-nvidia-dgx-spark-2x-qwen38-flash-next-vllm`, version 4.
- Two GB10 / SM121 systems, approximately 121.7 GiB each, private RoCE fabric.
- ARM64 image manifest `sha256:3b0e188ffceb3d07e09c3cb5215433a0020eacf02d7f882ed3a8bfd15454477e`;
  stopped container image ID `sha256:d464f3b466fa9c45ddbff8a812e80564503b6879a9fd95c1a47514f3f0df5a4a`;
  logs identify vLLM `0.1.dev20073+g8e685d198`.
- RadixArk checkpoint `7b719225242aacd3dbd3f9407468c2ee9a9d2594` remains the latest
  revision returned by the publisher API on this date.
- TP2 + expert parallel, MTP3, native 262144 context without YaRN, BF16 hybrid KV,
  prefix caching, decode-only graphs, 8192 batched tokens, GPU utilization 0.835.
- LLooM admits seven active requests and eight queued; retain the
  [matched concurrency evidence](../benchmarks/decision/2026-08-31-q38fn-vllm-tp2/README.md).

## Upstream comparison

| Source | Current finding | Decision |
| --- | --- | --- |
| [MiaAI dual Spark](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Dual-DGX-Sparks/compare/169fbad266f2791335a3102f0d3d625e7c295563...a56bbab1e3a249d6b0bb0bcadc409ad61a8afa1a) | One commit after our pin; only GitHub issue/PR templates changed | No serving update to port from this repository |
| [getrefined](https://github.com/getrefined/Qwen3.8-Flash-Next-NVFP4-vLLM-DGX-Spark/tree/f736930b636d2dbb4c7f4746311cbac66d8d2a6e) | HEAD still matches our comparison pin | Retain existing FP8 PLE loader |
| [vLLM support #53896](https://github.com/vllm-project/vllm/pull/53896) | Merged; an upstream merge alone does not validate a new ARM64 image on TP2 | Keep immutable image until workload validation |
| [blazux prefix-cache fix](https://github.com/blazux/qwen3.8-Flash-DGX/blob/b76890d5a033dd00166c792393d39cf908f56034/src/patch_mamba_block_size.py) | Both affected lines exist in our stopped image; logs confirm align cache mode | Exact-source-guarded candidate prepared; GPU validation pending |
| [vLLM deterministic top-k #55122](https://github.com/vllm-project/vllm/pull/55122) | Open; repairs nondeterministic ordering and dropped candidates, tested upstream on GB10 | Strong correctness candidate; compile and validate on this exact TP2 image before promotion |
| [MiaAI single Spark](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark/tree/203834ca88000c8192112e396b80d886b522caa0) | September 5 improvements include mmap PLE prefetch, graph coverage, and TP1-only reduced-vocabulary MTP | No direct transfer of published speedups to resident-PLE TP2; requires a separate experiment |
| [vLLM long-prefill starvation #54919](https://github.com/vllm-project/vllm/issues/54919) | Open report on the same preview engine and two-Spark TP2 | Keep staggered long-prompt and clean-drain gates; short-prompt speed alone is insufficient |

FP8 KV, hybrid side-layer quantization, single-node PLE offload, and extended YaRN
context change the memory/quality/workload comparison. None was promoted here.

## Live routing change

Before: `q38fn` already listed local first, cloud second, but local was suspended
and `qwen38-flash-next-cluster.enabled` was false. Both prevented local recovery.

Applied on the leader:

- Enabled the existing Qwen distributed runtime; kept its `keepWarm: false`.
- Used `lloom route q38fn --resume-member qwen3.8-flash-next --apply --yes`.
- Re-read live routing: members are `qwen3.8-flash-next`, then
  `cloud/openrouter/q38fn`; `suspendedMembers` is empty.
- Preserved all other runtime settings. The prior config is backed up privately
  on the leader as `~/.lloom/config.before-q38fn-enable-20260905.json`.

DS4FV is running on both Sparks with `keepWarm: true` and active requests.
The admission plan protects that pin and those requests; Qwen cannot coexist
within the current memory budget. Local-first therefore means local when it can
be admitted and becomes ready, with cloud serving while unavailable. Removing
DS4FV's pin and coordinating a drain is pending the user's workload choice.

Authenticated gateway canary at `2026-09-05T15:37:27.323Z`: requested `q38fn`,
HTTP 200, exact visible answer `Q38_ROUTE_OK`, 1285 ms duration. Gateway telemetry
recorded `resolvedModel: cloud/openrouter/q38fn`,
`backend: openai-compatible-openrouter-q38fn`,
`upstreamModel: qwen/qwen3.8-flash`, `failoverTargets: 2`, and
`failoverReason: preferred-member-unavailable`. This verifies cloud fallback
with local eligible but unavailable; it does not prove a running local lane.

## Prepared fix and verification

The [candidate directory](../backends/qwen38-vllm/candidates/NOTICE.md) is not
connected to recipe v4 and has not been deployed. Both inputs were extracted
from the stopped production Qwen container, hashed, and tested on the Mac.

The CPU regression executes the actual worker and scheduler methods with small
substitutes for GPU state: a 16000-token resumed position previously selected
slot 999 instead of 9 when generic blocks were 16 tokens and Mamba blocks 1600;
an 8192-token prefill chunk ended off the Mamba grid instead of at 8000. Both
cases pass with the candidate. Equal-layout behavior, idempotence, and rejection
of unknown source also pass. This proves the source-level repair, not end-to-end
cache correctness or speed on the GPUs.

Commands passed:

```sh
python3 backends/qwen38-vllm/candidates/test-prefix-cache-fix.py /tmp/q38fn-audit-source
node test/qwen38-vllm-recipe.test.mjs
node test/route-control.test.mjs
git diff --check
```

Remaining promotion work: free the pair through normal admission after active
work drains; integrate the candidate into a new immutable recipe version; verify
cold/repeated 16K and 32K continuations, buffered and streaming structured tools,
staggered concurrency, backend drain, and explicit local route attribution.
Evaluate deterministic top-k on the same artifact before calling the lane fully
updated. No commits, package release, model replacement, or GPU restart occurred.
