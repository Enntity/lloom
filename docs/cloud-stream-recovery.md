# Cloud stream failures and recovery

LLooM supplies a model attempt. Runtime retains the chat/tool checkpoint and owns retrying that attempt; a gateway failure must not masquerade as a successful empty completion.

For OpenRouter streaming requests, LLooM now applies a 60-second **model inactivity** deadline, starting before response headers. Text, reasoning, and tool-call deltas renew it. SSE processing comments and empty role deltas do not. Productive generations can run longer than this interval, subject to the existing backend total deadline. Configure `backends.<id>.streamIdleTimeoutMs` to override the interval; zero disables it. Other backends keep their existing behavior unless this setting is explicitly supplied. This guard does not restart a managed model or change residency.

An inactive attempt ends with status 504 and `upstream_no_progress`. If SSE headers have already been sent, the error event carries a numeric `error.status` in addition to the symbolic `error.code`. Runtime must consider the numeric status independently when deciding whether to recover.

HTTP error diagnostics are limited to 16 KiB and one second. Complete JSON diagnostics are consumed immediately, without waiting for the provider to close the body. The HTTP status and Retry-After survive a truncated or broken diagnostic body. Chat streaming errors terminate the upstream reader immediately and are recorded as failures; `[DONE]` terminates without waiting for EOF. OpenAI-to-Anthropic and Responses bridges also reject provider error events.

Failed-request metrics retain forwarded bytes and, when available on the failure path, the OpenRouter generation ID and whether response headers arrived. The gateway forwards `X-Generation-Id` and `Retry-After` response headers. First content still means model output, not a processing keepalive.

## September 7 investigation

The reported upstream dashboard showed 429s after several seconds while Runtime's attempts ended at its 300-second deadline. The installed LLooM error reader waited for EOF, and failed-request metrics reset byte counts to zero. These defects made error propagation fragile and the original evidence ambiguous.

Four bounded replays of the previously failing tool-round request directly to its existing OpenRouter provider succeeded, with no tool execution. Thus the historical incident's exact wire sequence has **not** been reproduced: the evidence does not establish whether OpenRouter withheld the error or LLooM waited on its body. No claim is made that a synthetic open-body failure proves the historical provider behavior. The guards cover both known errors on open connections and streams with no meaningful progress.

Regression coverage includes streaming and buffered 429s with unclosed bodies, in-stream errors, terminal DONE without EOF, missing headers, processing-only streams, productive reasoning streams longer than the inactivity interval, bounded/broken diagnostics, bridge error propagation, and numeric status parsing in Runtime.

Validation: the unmodified gateway failed the open-body regression with a client timeout. The patched full LLooM suite passes; Runtime passes all 1,458 tests and its syntax checks. A local canary using the actual Runtime client through the actual LLooM server classified an open-body HTTP 429 in 28 ms, an SSE 429 in 11 ms, and a keepalive-only stall in 106 ms with a 100 ms test deadline. The HTTP Retry-After value survived the complete path.

LLooM syntax and lint checks pass, and changed files pass formatting checks. Unrelated existing formatting issues remain elsewhere. Interchange and installed-package smoke checks pass in an isolated copy of HEAD plus this patch. These are local validations, not a live gateway deployment.

## Follow-up reproduction attempt

At 00:09–00:12 UTC September 8 (September 7 local time), an isolated gateway on the serving host loaded the installed, unpatched LLooM source. Raw OpenRouter headers, SSE framing, terminal events, and gateway metrics were captured without storing prompts or model output. The original failed prompt had since aged out of the 32-entry trace buffer and was absent from available recent snapshots. This test therefore used a retained later three-round Luna conversation, routed to the original cloud model with the original 4096-token output limit. Returned tools were never executed.

Six calls used that retained sequence; six used the same sequence with a changed diagnostic prefix to vary the cache input. Cache misses were not independently verified. All 12 completed with HTTP 200 and normal upstream DONE/EOF, in 3.109–19.378 seconds, with first model content in 0.923–2.727 seconds. Input sizes were approximately 18,700–22,900 tokens. Each attempt retained the original 300-second client deadline. No 429 or stall was reproduced, so the original causal attribution remains unresolved. Compact transport receipts are in [cloud-stream-repro-20260907.json](cloud-stream-repro-20260907.json).
