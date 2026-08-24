# DSpark patch packs

LLooM separates the two-Spark DeepSeek runtime into three reviewable layers:

1. **Pinned runtime** — an immutable container digest and model revision.
2. **Pinned upstream pack** — MiaAI patch artifacts from one exact commit, plus a checksum manifest.
3. **LLooM policy overlay** — cluster lifecycle, private-fabric binding, offline loading, resource limits, and gateway behavior.

The current pack is `backends/dspark-vllm/packs/miaai-dsv4flash-d1b76251-defaults`. Its manifest records the upstream repository and commit, compatible image and model revision, artifact hashes, deterministic application order, and whether each patch is enabled. Vendoring an artifact does not enable it.

Recipe v9 matches MiaAI's stable default set at `d1b76251`: fail-closed correctness fixes, long-prefix SWA cache safety, bounded decode fairness, the GB10 2 ms spin-wait, and guarded vLLM performance backports. LLooM keeps opt-in thinking budgets, assistant-final continuation, API-key redaction, and experimental Stage-C artifacts disabled. The two-prefill policy remains a separately measured LLooM overlay; cold 32K x C4 still queues at roughly 6-7 aggregate tok/s and 45-47 seconds median TTFB, so the recipe does not claim that the scheduler patches eliminate deep concurrent-prefill serialization.

`backends/dspark-vllm/apply-patch-pack.py` verifies every artifact before applying any enabled patch. It rejects checksum drift, path traversal, unknown runners, duplicate entries, and runtime/model compatibility mismatches. Commands are executed directly with `python3` or `bash`; manifest values are never evaluated by a shell.

## Updating from MiaAI

1. Fetch a specific upstream commit. Never package a moving branch or mutable image tag.
2. Create a new pack directory. Do not edit an existing pinned pack in place.
3. Vendor the complete upstream `patches/` directory and record every checksum.
4. Compare the old and new manifests. Keep new cache, scheduler, performance, and experimental patches disabled unless separately approved.
5. Run offline syntax, checksum, application, idempotence, and compatibility tests.
6. Publish a new LLooM recipe version that mounts the new pack directory and preserves the reviewed policy profile.
7. Coordinate a two-node live canary before changing a deployed Spark runtime.

## Enabling a patch

Changing `enabled` from `false` to `true` is a runtime change, not a documentation update. It requires:

- a stated workload benefit;
- a compatible pinned runtime;
- an offline patch-application test;
- a representative two-node live canary plan; and
- a new pack and recipe version.

Patch packs do not grant deployment authority. Installing the recipe and restarting both tensor-parallel ranks remain separate operations.
