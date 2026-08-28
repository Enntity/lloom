# Qwen3.8 SGLang SM121 patch provenance

`sm121_varlen.py` is vendored without functional modification from
MiaAI-Lab/Qwen3.8-Flash-Next-Dual-DGX-Sparks commit
`6acd77306bb2407af2fd2f010af22813453dd6f5`. `qsa_nvfp4_kv.py` and
`apply_nvfp4_patches.py` remain byte-identical to that repository's earlier
commit `f87d586e269df171089a879ee33a5356c0570e70`. All are used under that
repository's MIT license. Their source SHA-256 values are:

- `sm121_varlen.py`: `cccb29e4e831c3ccb89da67814bd2f1f40984590f486a672b9c335bcd5c96a2a`
- `qsa_nvfp4_kv.py`: `3aa1139774f2de8a345d59da0ac85e5e8cd47896fc618c7db298939506686580`
- `apply_nvfp4_patches.py`: `128ff089a4e10452a0d9d77b086060e58853e877849d2c2a2d61808506c47548`

LLooM's `apply-sm121-patches.py` installs those sources into the immutable,
digest-pinned SGLang base image at managed-container creation time. It refuses
to continue when an upstream source anchor does not match.
