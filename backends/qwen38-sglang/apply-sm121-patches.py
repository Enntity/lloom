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
FALLBACK_MARKER = "qsa.sm121_varlen"
TRTLLM_EXCLUSION_MARKER = "lloom: SM121 must not use TRT-LLM sparse decode"


def install_modules() -> None:
    qsa = ATTENTION / "qsa"
    qsa.mkdir(exist_ok=True)
    shutil.copy2(SOURCE / "sm121_varlen.py", qsa / "sm121_varlen.py")
    shutil.copy2(SOURCE / "qsa_nvfp4_kv.py", ATTENTION / "qsa_nvfp4_kv.py")


def patch_sm121_fallback() -> None:
    source = BACKEND.read_text()
    patched = source

    if FALLBACK_MARKER not in patched:
        anchor = "    try:\n        from flash_attn import flash_attn_varlen_func"
        replacement = (
            "    from sglang.srt.utils import is_sm121\n"
            "\n"
            "    if is_sm121():\n"
            "        from sglang.srt.layers.attention.qsa.sm121_varlen import (\n"
            "            qsa_sm121_varlen_attention,\n"
            "        )\n"
            "\n"
            "        return qsa_sm121_varlen_attention\n"
            + anchor
        )
        if patched.count(anchor) != 1:
            raise RuntimeError("SGLang SM121 varlen anchor changed; refusing an unsafe patch")
        patched = patched.replace(anchor, replacement, 1)

    if TRTLLM_EXCLUSION_MARKER not in patched:
        function = "def _resolve_trtllm_sparse_decode():"
        start = patched.find(function)
        if start < 0:
            raise RuntimeError("SGLang TRT-LLM resolver changed; refusing an unsafe patch")
        docstring_start = patched.find('\"\"\"', start)
        docstring_end = patched.find('\"\"\"', docstring_start + 3)
        if docstring_start < 0 or docstring_end < 0:
            raise RuntimeError("SGLang TRT-LLM resolver docstring changed; refusing an unsafe patch")
        docstring_end += 3
        exclusion = (
            "\n    from sglang.srt.utils import is_sm121\n"
            "\n"
            f"    # {TRTLLM_EXCLUSION_MARKER}\n"
            "    # sglang#36806/#36845: this path silently emits token id 0\n"
            "    # at long context on GB10.\n"
            "    if is_sm121():\n"
            "        return None\n"
        )
        patched = patched[:docstring_end] + exclusion + patched[docstring_end:]

    if patched == source:
        print("qwen_sparse_attn_backend.py: SM121 decode paths already patched")
        return
    BACKEND.write_text(patched)
    print("qwen_sparse_attn_backend.py: patched for SM121 (sglang#36806 + #36845)")


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
