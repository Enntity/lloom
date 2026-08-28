#!/usr/bin/env python3
"""Install and apply the pinned MiaAI Qwen3.8 SM121 patch set in-place."""

from __future__ import annotations

import pathlib
import runpy
import shutil


SOURCE = pathlib.Path("/opt/lloom")
ATTENTION = pathlib.Path(
    "/sgl-workspace/sglang/python/sglang/srt/layers/attention"
)
BACKEND = ATTENTION / "qwen_sparse_attn_backend.py"
CUSTOM_LOGIT_PROCESSOR = pathlib.Path(
    "/sgl-workspace/sglang/python/sglang/srt/sampling/custom_logit_processor.py"
)
FALLBACK_MARKER = "qsa_fa_fallback"


def install_modules() -> None:
    for name in ("qsa_fa_fallback.py", "qsa_nvfp4_kv.py"):
        shutil.copy2(SOURCE / name, ATTENTION / name)


def patch_sm121_fallback() -> None:
    source = BACKEND.read_text()
    if FALLBACK_MARKER in source:
        print("qwen_sparse_attn_backend.py: SM121 fallback already patched")
        return
    anchor = "    try:\n        from flash_attn import flash_attn_varlen_func"
    replacement = (
        "    from sglang.srt.utils import is_sm100_supported\n"
        "    if not is_sm100_supported():\n"
        "        from sglang.srt.layers.attention.qsa_fa_fallback import "
        "triton_varlen_attn_func\n"
        "        return triton_varlen_attn_func\n"
        + anchor
    )
    if source.count(anchor) != 1:
        raise RuntimeError("SGLang SM121 fallback anchor changed; refusing an unsafe patch")
    BACKEND.write_text(source.replace(anchor, replacement, 1))
    print("qwen_sparse_attn_backend.py: patched for SM121")


def patch_thinking_budget_tokens() -> None:
    source = CUSTOM_LOGIT_PROCESSOR.read_text()
    patched = source
    for old, new in (
        ("THINKING_START_TOKEN_ID: int = 151667", "THINKING_START_TOKEN_ID: int = 248068"),
        ("THINKING_END_TOKEN_ID: int = 151668", "THINKING_END_TOKEN_ID: int = 248069"),
    ):
        if new in patched:
            continue
        if patched.count(old) != 1:
            raise RuntimeError(
                f"SGLang thinking-budget anchor changed for {old!r}; refusing an unsafe patch"
            )
        patched = patched.replace(old, new, 1)
    if patched == source:
        print("custom_logit_processor.py: Qwen3.8 thinking token IDs already patched")
        return
    CUSTOM_LOGIT_PROCESSOR.write_text(patched)
    print("custom_logit_processor.py: patched Qwen3.8 thinking token IDs")


def main() -> None:
    install_modules()
    patch_sm121_fallback()
    patch_thinking_budget_tokens()
    runpy.run_path(str(SOURCE / "apply_nvfp4_patches.py"), run_name="__main__")


if __name__ == "__main__":
    main()
