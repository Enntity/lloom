# Qwen3.8 SGLang SM121 patch provenance

`qsa_fa_fallback.py`, `qsa_nvfp4_kv.py`, and
`apply_nvfp4_patches.py` are vendored without functional modification from
MiaAI-Lab/Qwen3.8-Flash-Next-Dual-DGX-Sparks commit
`f87d586e269df171089a879ee33a5356c0570e70` under that repository's MIT
license. Their source SHA-256 values are:

- `qsa_fa_fallback.py`: `4546423216fbf51f1763753c0865c0fb9eff670db566e83987268918a86b993a`
- `qsa_nvfp4_kv.py`: `3aa1139774f2de8a345d59da0ac85e5e8cd47896fc618c7db298939506686580`
- `apply_nvfp4_patches.py`: `128ff089a4e10452a0d9d77b086060e58853e877849d2c2a2d61808506c47548`

LLooM's `apply-sm121-patches.py` installs those sources into the immutable,
digest-pinned SGLang base image at managed-container creation time. It refuses
to continue when an upstream source anchor does not match.
