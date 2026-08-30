# Qwen3.8 SGLang SM121 patch provenance

`sm121_varlen.py` and `qsa_nvfp4_kv.py` are vendored without functional
modification from MiaAI-Lab/Qwen3.8-Flash-Next-Dual-DGX-Sparks commit
`0f950012c8d8323acac9a08846a32ef7953f5f62`.
`apply_nvfp4_patches.py` preserves LLooM's existing anchor-checked NVFP4
patcher and ports that commit's token-id-0 abort, poisoned-prefix exclusion,
and cache-reset guard. LLooM additionally makes the reset atomic across the
radix tree, request pool, token allocator, and draft cache;
resetting the radix tree alone can orphan one full-token page and one Mamba
page after an aborted speculative request. All are used under that
repository's MIT license.
Their source SHA-256 values are:

- `sm121_varlen.py`: `562610cf63f90ae666106c9f364812978ef039ac02ec9e7efc31e52a9de78e2b`
- `qsa_nvfp4_kv.py`: `3aa1139774f2de8a345d59da0ac85e5e8cd47896fc618c7db298939506686580`
- `apply_nvfp4_patches.py`: `d4e04ca0a6eb9c87899f30be9ed361e63155664182ff2e77aed7ad6ea20d2a3e`

`apply_disconnect_lifecycle_fix.py` is an exact-source-guarded backport of
SGLang PR #36418 for the digest-pinned image's `TokenizerManager`. It retains
scheduler-owned request IDs through HTTP stream cancellation so SGLang's
existing delayed abort reaches the scheduler instead of burning compute until
`max_tokens`. The port was taken from the MIT-licensed
`hellojiaru/qwen38-flash-next-dual-gb10` v0.1.2-canary release and refuses to
modify a source revision whose anchors do not match.

LLooM's `apply-sm121-patches.py` installs those sources into the immutable,
digest-pinned SGLang base image at managed-container creation time. It refuses
to continue when an upstream source anchor does not match.
