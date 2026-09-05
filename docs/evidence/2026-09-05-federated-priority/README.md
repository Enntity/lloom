# Federated interactive priority

Local candidate, September 5, 2026. No deployment, live configuration change,
runtime start/stop, entity conversation, or memory mutation.

## Transport behavior

The gateway forwards the normalized interactive request class to backends
identified by enabled `cluster.nodes.<node>.proxy` inference routes. It checks
the selected backend on every attempt, including failover. A node's presence in
cluster configuration or a model's metadata alone is insufficient. The serving
gateway applies its own queue policy and does not send the label to raw model
backends. Per-hop authentication and existing cancellation remain intact.

Forwarding covers chat, embeddings, Responses/Anthropic conversions, speech,
transcription and the shared JSON/multipart media paths. It changes neither
model inputs nor provider credentials, identity, continuity or Eidos policy.

## Controlled evidence

- `baseline.tap`: the interactive embedding request remains queued at the
  serving gateway when using the previous transport. The fixture times out
  waiting for provider dispatch while a background slot remains occupied.
  The isolated baseline includes the earlier priority scheduler and the new
  unused proxy-recognition helper, but replaces `server.mjs` with the exact
  pre-forwarding source. It is not pristine repository HEAD.
- `candidate.tap`: twelve tests pass. Two authenticated loopback gateways and
  a synthetic provider demonstrate reserved serving capacity for embeddings,
  buffered/streamed chat, Responses, Anthropic, speech and multipart
  transcription. Other fixtures cover queued cancellation, active-stream
  cancellation plus upstream closure, raw-provider failover, authentication,
  unknown labels and explicit proxy recognition. Runtime lifecycle health is
  stubbed; these are scheduling/transport tests, not GPU performance results.
- `full.log`: LLooM's complete suite passes, including all 24 queue/federation
  tests and the existing protocol, runtime, recipe, smoke and community checks.
- `check.log`, `lint.log`, `interchange.log`, `package.log`: checks pass.
  `format-changed.log` passes. Repository-wide `format.log` still reports only
  the unchanged `test/ds4fv-recipe.test.mjs`; its HEAD equivalence and existing
  formatting failure are documented in the preceding interactive-admission
  evidence directory.
- `sources.json` records the transport baseline and candidate hashes.

## Installed Mac embedding observation

`probe-mac-embedding.mjs` and `mac-embedding-baseline.json` record five sequential,
short synthetic recall queries sent through the normal installed Mac gateway
to `qwen3-embedding:4b`, backed by local Ollama. This is the installed baseline;
the candidate scheduler/forwarding changes are not deployed.

Before invoking inference, the probe checks Ollama's read-only residency list
and the gateway runtime counters. The model was already loaded (9,982,758,092
reported bytes), healthy, with zero active/queued requests. The same state
remained after the probe. The probe issued no lifecycle commands.

Measured total HTTP response times were **151.0–206.4 ms**, with a **152.9 ms
median** across five samples. Every response contained a finite 2,560-dimensional
vector. The artifact separates response-header time from full-body completion
and retains exact synthetic queries and provider-reported usage.

A separate read-only identity observation after the timing probe reports Ollama
0.32.6 and the loaded GGUF Qwen3 4.0B Q4_K_M model digest in the JSON artifact.
That observation has its own timestamp; identity metadata was not captured
atomically with each timing sample.

These are idle, warm, short-query measurements, not latency percentiles or a
live entity's complete recall/orientation time. They do not prove embedding
space equivalence with cloud Qwen, provider priority, CPU/GPU isolation, or
behavior while sleep/Presence saturates resources. Five samples cannot support
p95/p99 claims. Full-corpus retrieval, contention, native clients, writer
quality, and voice/avatar acceptance remain required for the overall goal.
