# Qwen3.8 SGLang SM121 patch provenance

`sm121_varlen.py` and `qsa_nvfp4_kv.py` are vendored without functional
modification from MiaAI-Lab/Qwen3.8-Flash-Next-Dual-DGX-Sparks commit
`0f950012c8d8323acac9a08846a32ef7953f5f62`.
`apply_nvfp4_patches.py` preserves LLooM's existing anchor-checked NVFP4
patcher and ports that commit's token-id-0 abort, poisoned-prefix exclusion,
and cache-reset guard. All are used under that repository's MIT license.
Their source SHA-256 values are:

- `sm121_varlen.py`: `562610cf63f90ae666106c9f364812978ef039ac02ec9e7efc31e52a9de78e2b`
- `qsa_nvfp4_kv.py`: `3aa1139774f2de8a345d59da0ac85e5e8cd47896fc618c7db298939506686580`
- `apply_nvfp4_patches.py`: `14f8aa89871bd212032d0e03ae9d68738b73ae1822ac762225eedc9e1c8d2bfd`

LLooM's `apply-sm121-patches.py` installs those sources into the immutable,
digest-pinned SGLang base image at managed-container creation time. It refuses
to continue when an upstream source anchor does not match.
