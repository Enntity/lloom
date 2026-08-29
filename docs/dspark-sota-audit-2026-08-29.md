# DeepSeek V4 Flash two-Spark audit — 2026-08-29

## Scope

This audit compares LLooM's production `deepseek-ai/DeepSeek-V4-Flash-0731`
lane with current public two-DGX-Spark recipes and upstream vLLM fixes. It keeps
model quality, context capacity, concurrency, speed, and recovery as separate
dimensions. Public single-stream numbers are not treated as production results
unless their context and concurrency match LLooM's profile.

## Hardware and pinned model contract

- Two GB10 / SM121 DGX Sparks, TP=2 and PP=1.
- Both direct-connect interfaces are up: `enp1s0f0np0` and
  `enP2p1s0f0np0`; each maps to one active 200 Gb/s RoCE HCA.
- Official DeepSeek checkpoint revision
  `9e165c30e2704aec5d9d593cce3eebd58bbef1cb`.
- Production envelope: 262,144-token context, six request slots, 8,192-token
  batch budget, prefix caching, async scheduling, and chunked prefill.
- Weight and kernel stack: official checkpoint, Anemll 0.1.1 overlay,
  FlashInfer B12X MoE, and DeepSeek sparse MLA.

The 262K/C6 envelope is deliberate. One-million-token public profiles prove
capacity, while 40K/C1 profiles isolate peak decode. Neither is an
apples-to-apples replacement for the production lane.

## Measured pre-change baseline

Jinx and Luna presence were disabled, the backend was otherwise idle, and the
same harness was used for every repetition.

| Prompt / concurrency | Target-only result |
| --- | ---: |
| 256 tokens, C1 | 27.2 response tok/s median; about 262–266 ms TTFT |
| 256 tokens, C6 | 13.2 tok/s median per stream; 69.6–72.3 aggregate tok/s |
| 8,192 tokens, C1 | 25.2 response tok/s median; 4.33–4.39 s TTFT |
| 8,192 tokens, C6 | 7.2 tok/s median per stream; 22.1–22.7 aggregate tok/s; 16.0–16.3 s TTFT |

Target-only removed the observed MTP hang shape but also removed the model's
main decode accelerator. It was a safety state, not a state-of-the-art recipe.

## Upstream comparison

- vLLM PR 51538 identifies the observed drain-shaped failure exactly: padded
  MTP rows can produce negative lengths, the persistent top-k kernel reads them
  as a huge unsigned value, and one CTA waits forever for peers that exited.
  The complete fix requires both the Python clamp and the compiled kernel
  guard. The PR reports the unfixed reproducer hanging in 30–180 seconds and
  distribution-preserving DSpark evaluation within noise of target-only.
- The Weschera recipe measured 83.8077 tok/s at K7 versus 27.1030 target-only
  with the same output hash, but on its explicit 40K/C1 speed profile. Its
  production default remains K5/C6.
- DeepSeek's 0731 model card pairs K7 with greedy draft sampling. MiaAI now
  exposes the sampler as a validated setting, so the live comparison covers
  the stable K5/probabilistic profile and the official K7/greedy pairing rather
  than changing draft depth while silently retaining the old sampler.
- twinspark measured about 74.8 tok/s at K7 for single-stream traffic and found
  shallower speculation better for some multi-agent/concurrent traffic. This
  is why LLooM benchmarks both C1 and C6 instead of copying K7 blindly.
- MiaAI's current head restores `DSPARK_MAX_INFLIGHT_PREFILLS=1`: its measured
  C4 8K fairness spread was 3.72x–5.14x at two in-flight prefills versus
  1.68x–2.04x at one. This is an admission/fairness correction, not a decode
  throttle.
- MiaAI Issue 141's fixed-64 workaround is not enabled. Its risky boundary is
  verify batches above 64 rows; LLooM's K5/C6 shape is 36 rows and K7/C6 is 48.
  Upstream also labels the workaround default-off pending broader validation.
- LMCache, Responses-history compatibility, and the Issue 141 workaround stay
  off because upstream ships them opt-in and they do not improve this measured
  decode path without changing another contract.

## Recipe v18 changes

- Build an exact local runtime from Anemll `47503f8e...` and vLLM
  `752a3a504...`, adding vLLM commits `318d623b...` and `f633bd67...` before
  wheel compilation. No public image is pushed.
- Restore DSpark speculative decode only on that compiled-hardened image.
- Use both RoCE HCAs with an exact NCCL selector and `NCCL_IB_MERGE_NICS=1`.
- Default to one in-flight partial prefill.
- Validate and expose `DRAFT_SAMPLE_METHOD`; select K5/greedy from the live
  K5/probabilistic, K5/greedy, and K7/greedy production A/B.
- Round the expanded speculative CUDA-graph ceiling up to vLLM's supported
  eight-row grid: 40 rows for K5/C6 and 48 for K7/C6. The old exact 36-row
  request was silently truncated to 32 and left the full K5/C6 shape uncaptured.
- Add MiaAI's current stable-default Issue 133 Triton specialization fix.
- Persist B12X CuTeDSL, Triton, and TileLang caches.
- Enable persistent NCCL flight-recorder dumps and the on-demand dump pipe.
- Validate arithmetic-bearing numeric environment values before launch.
- Preserve LLooM's atomic two-rank recovery and three-minute no-progress
  watchdog.

## Live two-Spark result and selected profile

Every cell used the same OpenAI-compatible chat request, thinking disabled,
128 forced output tokens, and unique prompt nonces. Decode results are the
median of repeated trials; C6 is the median per stream. The profile comparison
is a performance/admission test, not a deterministic-output equivalence test;
the cited Weschera result supplies that separate same-hash evidence for the
hardened speculative path. A corrected post-deployment canary against the
advertised served-model name returned HTTP 200 with non-empty model output.

| Prompt / concurrency | K5 probabilistic | K5 greedy | K7 greedy |
| --- | ---: | ---: | ---: |
| 256 tokens, C1 | 62.0 tok/s | **78.6 tok/s** | 62.0 tok/s |
| 256 tokens, C6 | 36.0 tok/s | **45.2 tok/s** | 37.8 tok/s |
| 8,192 tokens, C1 | 75.4 tok/s | **85.2 tok/s** | 77.9 tok/s |
| 8,192 tokens, C6 | 10.3 tok/s | 11.0 tok/s | **11.2 tok/s** |

K5/greedy wins three of four production cells, including both interactive
cells and short-prompt concurrency. K7's 0.2 tok/s long-C6 edge is within run
variation and does not offset its 9–21% regressions elsewhere. The committed
v18 default is therefore K5/greedy, not the public 40K/C1 K7 profile.

Relative to the target-only safety state, K5/greedy raises median decode by
2.89x at 256/C1, 3.42x per stream at 256/C6, 3.38x at 8K/C1, and 1.53x per
stream at 8K/C6. Its measured draft acceptance was about 79%, and the hardened
padding guards preserve exact sampling semantics rather than accepting invalid
draft tokens.

## Deliberately unchanged

- Official model weights and revision.
- 262K context, C6 request capacity, 8K batch budget, and 0.73 memory
  utilization, which preserve coexistence headroom.
- Host MTU remains 1500. Public MTU 9000 results are interesting, but changing
  host networking is outside a portable recipe and decode is not fabric-
  bandwidth-bound.
- No move to generic vLLM 0.28: upstream has the fix, but it is not a drop-in
  replacement for the Anemll/B12X/DeepSeek sparse-MLA appliance contract.
