# DS4FV upstream integration: 7440c53

Recipe v6 integrates [MiaAI upstream 7440c53](https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark/commit/7440c53c1f0352886e47b1909051784879fa0a24)
in immutable pack `miaai-ds4fv-7440c53`. Initially integrated without deployment;
the user subsequently authorized the paired-Spark release recorded below.
The previous v4 recipe and patch pack remain available for rollback;
v5 remains the separate, unmeasured two-prefill candidate.

## New features

| Control | Integrated behavior | Recipe v6 default |
| --- | --- | --- |
| `DSPARK_ENABLE_DSML_RECOVERY` | Recovers complete malformed-wrapper tool invocations only for declared request tools; preserves rejected/truncated text and honors `tool_choice=none` | `0` |
| `DSPARK_ENABLE_MXFP4_INDEXER_CACHE` | Enables the GB10 indexer gate plus `--attention-config {"use_fp4_indexer_cache":true}`; requires SM121 header aliases | `0` |
| `DSPARK_ENABLE_ISSUE144_EFFORT_ALIGN` | Moves high/max effort directives after the leading system region to share cached prefixes between effort levels | `0` |
| `NCCL_GIN_ENABLE` | Optional NCCL networking-init control; empty is normalized to absent, explicit `0` passes through | unset |

The three new patch files and their fixtures/tests are copied byte-for-byte from
upstream. Manifest SHA256 checks cover executable assets. New controls are
validated; an old pack cannot silently accept an unsupported enabled feature.
Patches preflight and verify their target files, retaining upstream rollback and
source-drift checks. Effort alignment checks the **served, pinned encoder copy**,
not an arbitrary cached model revision. Existing required-tool guards remain on.

The MXFP4 change halves the indexer's key-read representation, not its physical
allocation in this image; do not claim extra KV capacity from it. Effort alignment
changes high/max prompt placement, and DSML recovery is based on an open vLLM PR.
Upstream still defaults all three off pending live quality/performance gates.
Integration therefore makes them usable without silently promoting them.

## Preserved profile and validation boundary

Vision checkpoint `86f746b36186f0e567729a5c06a8c918caba82a9`, digest-pinned Anemll
0.1.1 image, 262K context, 16K batch, K=5 probabilistic drafting, one inflight prefill,
two active/eight queued, and the previously integrated RoPE/draft-prefix/SP fixes
are unchanged. No return to 1M context or unmeasured higher concurrency.

Local gates include upstream fixture/transform/parser/rendering/rollback tests,
launcher defaults and dependency checks, recipe/index validation, full LLooM tests,
and package installation smoke. Upstream Compose-specific wiring tests are replaced
by LLooM launcher/recipe tests. The optional real-BPE issue144 check requires a
tokenizer file and is not counted as live validation.

Before enabling on the Sparks: test streaming and buffered tools (including
malformed/foreign wrappers), cross-effort cache hits and high/max quality, and
MXFP4 32K/128K retrieval plus latency/garble checks. The existing 128K exact-code
limitation remains unresolved; these source integrations do not establish a fix.

## Paired-Spark deployment receipt — 2026-09-05

- Both installed release manifests: commit `08c63ca5c6c65283abd6a5d56032da22ea639eaa`;
  artifact SHA256 `7042fee00775655c19d861487d2ad886797fcf42c5d0ab03e02255a7bb4059d7`.
- Both installed recipes are v6. Both recreated managed containers mount
  `miaai-ds4fv-7440c53`; in-container manifest SHA256 matches the repository:
  `fce6bc06730c1c0b96eecd05e30c4361067c0e16723bc2c253f0cac326406ee5`.
- Upstream HEAD was rechecked as `7440c53` immediately before deployment.
- Temporarily suspended the local alias member, drained the existing request,
  deployed worker then leader using `--preserve-routes`, and restored the member
  only after local canaries. Preserved local-first ordering followed by cloud
  Qwen and cloud DS4FV; no entity policy edits. Cluster keep-warm remains true,
  with two active/eight queued and one inflight prefill.
- Authenticated gateway canaries passed: exact `DS4FV_LOCAL_OK`; streaming
  reasoning/tool call `record_code({"code":"391"})`; native image response
  `LLOOM // LIVE TOPOLOGY` (293 image tokens). Tool test: 726 ms TTFT, 2.019 s
  total; image test: 2.184 s TTFT, 2.336 s total. These small smoke checks are
  not a new throughput benchmark or validation of disabled experimental flags.
- Post-resume alias canary at `2026-09-05T15:12:25.167Z`: requested `ds4fv`,
  resolved/backend `deepseek-v4-flash-vision-exp`, HTTP 200, `failedOver=false`.
  Managed cluster reported running/healthy; all three new opt-ins remain off.
