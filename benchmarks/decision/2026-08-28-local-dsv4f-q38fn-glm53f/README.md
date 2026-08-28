# Local DSv4F vs Qwen3.8 Flash Next vs GLM-5.3 Flash

Date: 2026-08-28

## Decision

Keep local DSv4F as the default production lane. Qwen3.8 Flash Next is now a
credible candidate lane, but it is not yet a safe drop-in replacement. GLM-5.3
Flash produced strong, stable answers and is useful as a deliberate specialist
lane, but its cold residency cost and occasional very long reasoning make it a
poor default for interactive work.

## Method

- All requests went through the authenticated LLooM gateway on `ennspark01`.
- Routes were strictly local: `dsv4f-local`, `q38fn`, and `glm53f`.
- The frozen suite is `examples/qualitative-benchmark-enntity.v1.json`.
- TTFB is request start to the first SSE response-body byte. Tok/s is provider
  `completion_tokens` divided by first-semantic-delta-to-completion wall time.
- Qualitative requests omitted `max_tokens`; answers were allowed to stop
  naturally.
- DSv4F and GLM used `temperature=0`, seed 73. Qwen used the checkpoint's
  `generation_config` and native `reasoning_effort=low`, because that is the
  model's documented serving profile. This is a production-profile comparison,
  not identical sampling.
- Scores below are a manual, literal reading of the frozen rubrics.

## Measured results

| Model / case | TTFB | Total | Completion tokens | Tok/s | Finish | Qualitative result |
|---|---:|---:|---:|---:|---|---|
| DSv4F incident | 0.549s | 17.114s | 838 | 50.59 | stop | Pass |
| DSv4F continuity | 0.420s | 15.087s | 774 | 52.77 | stop | Pass |
| DSv4F tool | 0.944s | 3.725s | 187 | 67.24 | tool_calls | Exact |
| DSv4F code review | 0.342s | 23.848s | 1,240 | 52.75 | stop | Pass |
| Qwen incident | 2.001s | 20.996s | 775 | 40.80 | stop | Pass |
| Qwen continuity | 1.378s | 14.374s | 465 | 35.78 | stop | Pass; promise duplicated across durable and working sections |
| Qwen tool | 2.409s | 11.865s | 265 | 28.03 | tool_calls | Exact |
| Qwen code review | 1.474s admission | interrupted after about 90s | more than 1,700 observed | about 13-18 live | incomplete | Sustained MTP accept length 1.00; not scored |
| GLM incident | 2.010s | 58.894s | 1,688 | 29.67 | stop | Pass |
| GLM continuity | 1.057s | 31.350s | 879 | 29.02 | stop | Pass |
| GLM tool | 1.800s | 6.290s | 225 | 50.12 | tool_calls | Exact |
| GLM code review | 0.823s | 236.852s | 5,400 | 22.88 | stop | Strong answer; misses one literal rubric by preserving buffered watchdog coverage too |

Completed-case medians:

| Model | Median TTFB | Median total | Median tok/s | Literal rubric |
|---|---:|---:|---:|---:|
| DSv4F | 0.485s | 16.101s | 52.76 | 16/16 |
| Qwen | 2.001s | 14.374s | 35.78 | 12/12 on 3 completed cases; fourth incomplete |
| GLM | 1.429s | 45.122s | 29.35 | 15/16 |

Cold transition to LLooM healthy:

- DSv4F: approximately 4m50s in the Phase 1 observation.
- Qwen: 9m56s (`18:54:55.233` starting to `19:04:51.392` healthy).
- GLM: 8m48s (`19:08:49.923` starting to `19:17:37.569` healthy).

## Qualitative read

### DSv4F

The most concise and predictable model in this workload. It followed the
requested framing, selected the exact tool, stopped naturally in every case,
and had the best latency and decode rate. Its code-review patch follows the
literal requested rubric by arming the byte-progress watchdog only for streams.
That is compliant and minimal, though less defensive than GLM's alternative.

### Qwen3.8 Flash Next

With the corrected profile, Qwen's completed answers are good. The incident
assessment was careful, the tool call was exact, and continuity handling was
semantically sound. There is no demonstrated qualitative superiority over
DSv4F yet, and supported-profile performance was slower than DSv4F.

The code-review case is inconclusive rather than a proven token-0 output loop:
the runner did not expose partial text. The server did show sustained
`accept len=1.00`, `accept rate=0.00`, continued decode for more than 1,700
tokens, and no natural stop before interruption. That is sufficient to reject
drop-in promotion, but not sufficient to claim the partial text was literal
`!` corruption. The runtime was stopped after interruption to clear possible
zombie scheduler state.

### GLM-5.3 Flash

The most stable deliberate reasoner in this small sample. It completed every
case, selected the exact tool, and its final code-review answer proposed a
stronger invariant than the rubric: report real per-chunk progress for buffered
responses instead of removing their stall protection. That is arguably the
best engineering answer, but it took 236.9 seconds and 5,400 completion tokens
to reach it. GLM is attractive for high-value review, not routine interactive
traffic.

## Qwen tuning and upstream findings

The viable Qwen profile is:

- keep MTP/NEXTN `3/1/4` enabled;
- set native chat-template `reasoning_effort=low`;
- do not force `enable_thinking=false` (the model is always-reasoning);
- leave `temperature` and `top_p` unset so SGLang uses checkpoint defaults;
- use the exact SM121 packed-varlen kernel from MiaAI-Lab commit
  `6acd77306bb2407af2fd2f010af22813453dd6f5`;
- force SM121 away from FlashInfer TRT-LLM sparse decode;
- treat NVFP4-KV 262K correctness and concurrency as soak requirements.

LLooM recipe v11 implements that profile. Commit
`2d36a1f78912417f92dba4bc435b4e9c3b4b94ea` was deployed byte-identically to
both nodes; package SHA-256 is
`5a2f3b06292cdc6e464e66a57d4c63d3727dedb303db9f7a696a4f03042662bc`.

Upstream evidence explains the earlier failures:

- SGLang issue #36537 tracks token-ID-0 repetition on this checkpoint and
  serving stack.
- SGLang #36806 (merged) keeps the unsafe sparse-decode route off SM121.
- SGLang #36845 (open) adds the SM121 Triton packed-varlen fallback ported by
  Mia and LLooM.
- SGLang #35936 and issue #36876 remain open for cancelled-client zombie
  requests. The pinned day-0 image predates them. A disconnected runaway can
  therefore keep decoding and contaminate later measurements until restart.

Promotion gates for Qwen should be: a completed code-review case, a mixed
thinking/tool concurrency soak, long-context semantic retrieval with NVFP4 KV,
and a pinned zombie-request fix or an LLooM circuit breaker that detects
sustained decode with `spec_accept_length <= 1.05` and safely recycles the
runtime.

## Raw evidence

- `phase1-dsv4f-local.json`
- `q38fn-incident.json`
- `q38fn-continuity.json`
- `q38fn-tool.json`
- `phase3-glm53f-local.json`

The Qwen code-review case has no JSON result because the request did not finish;
the diagnosis is based on LLooM/SGLang runtime logs and the recorded stop
events. Jinx remained offline throughout.
