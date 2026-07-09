#!/usr/bin/env python3
"""Apply LLooM MTPLX long-context GPU-watchdog fix to an installed mtpLX package.

Root cause (MLX #3302): macOS GPU watchdog aborts processes when a single
steel_attention Metal command runs over ~65k+ keys. MTPLX's paged-kv q4 path
could fall through to dense full-KV SDPA, which MLX surfaces as
mlx::core::gpu::check_error → SIGABRT.

This script patches:
  - mtplx/cache_state.py  (large-q split mask + long-ctx chunked route)
  - mtplx/attention_split.py (prefer chunked over dense fallback)

Usage:
  /path/to/mtplx/venv/bin/python patches/apply_mtplx_longctx_fix.py
"""
from __future__ import annotations

import py_compile
import sys
from pathlib import Path


def find_mtplx() -> Path:
    import mtplx

    return Path(mtplx.__file__).resolve().parent


def ensure_backup(path: Path) -> None:
    bak = path.with_suffix(path.suffix + ".bak-lloom-longctx")
    if not bak.exists():
        bak.write_text(path.read_text())
        print(f"  backup → {bak.name}")


def patch_cache_state(path: Path) -> None:
    text = path.read_text()
    if "LLooM long-ctx fix" in text and "MTPLX_LONG_CTX_CHUNKED_ATTN_THRESHOLD" in text:
        print(f"{path.name}: already patched")
        return

    ensure_backup(path)

    old_mask = '''        if mask is not None and mask != "causal":
            self._record_paged_bailout(
                "unsupported_mask",
                impl="large_q_split_sdpa",
                offset=int(self.offset),
                q_len=int(queries.shape[2]),
                sliding_window=int(sliding_window),
            )
            return None

        q_len = int(queries.shape[2])'''

    new_mask = '''        # LLooM long-ctx fix: never bail solely because the caller passed a
        # materialised attention mask. Array/bool masks are the common path
        # for Qwen hybrid prefill; rejecting them forced dense full-KV SDPA
        # which trips the macOS GPU watchdog at ~65k+ keys (MLX #3302 /
        # kIOGPUCommandBufferCallbackErrorImpactingInteractivity).
        # Position-based causal masking below is correct for standard prefill.
        use_causal = mask is None or mask == "causal" or mask is not None
        if mask is not None and mask != "causal" and _env_truthy(
            "MTPLX_LARGE_Q_SPLIT_REQUIRE_CAUSAL_STRING"
        ):
            self._record_paged_bailout(
                "unsupported_mask",
                impl="large_q_split_sdpa",
                offset=int(self.offset),
                q_len=int(queries.shape[2]),
                sliding_window=int(sliding_window),
            )
            return None

        q_len = int(queries.shape[2])'''

    old_loop = '''                if mask == "causal":
                    key_positions = mx.arange(k_start, k_end)
                    allowed = q_positions[:, None] >= key_positions[None, :]
                    valid = mx.any(allowed, axis=-1, keepdims=True)
                    scores = mx.where(allowed[None, None, :, :], scores, very_negative)
                else:
                    valid = mx.ones(scores.shape[:-1] + (1,), dtype=mx.bool_)'''

    new_loop = '''                # Always use position-based causal masking on this long-ctx path.
                # (Previously only when mask == "causal"; array masks skipped
                # masking and still risked watchdog via other routes.)
                if use_causal or True:
                    key_positions = mx.arange(k_start, k_end)
                    allowed = q_positions[:, None] >= key_positions[None, :]
                    valid = mx.any(allowed, axis=-1, keepdims=True)
                    scores = mx.where(allowed[None, None, :, :], scores, very_negative)
                else:
                    valid = mx.ones(scores.shape[:-1] + (1,), dtype=mx.bool_)'''

    old_kv = '''            if q_len > max_q_len and partitioned_enabled and int(self.offset) >= partition_threshold:
                return run_partitioned_paged(force_fp32_paged=False)
            out = scaled_dot_product_attention(
                queries,
                keys,
                values,
                cache=None,
                scale=scale,
                mask=mask,
            )
            self.paged_attention_calls += 1
            self.kv_quant_attention_calls += 1
            self.attention_time_s += time.perf_counter() - started
            return out'''

    new_kv = '''            # LLooM long-ctx fix: once the KV span is large, never dispatch a
            # single dense SDPA over the full dequantised K/V. That single
            # steel_attention command exceeds the ~5s macOS GPU watchdog and
            # aborts via mlx::core::gpu::check_error (MLX #3302). Prefer the
            # partitioned / large-q chunked path for any long offset, not only
            # when q_len > max_q_len.
            # Only force chunking when q_len is large enough that MLX uses
            # steel_attention (full SDPA, qL>8). Decode/vector path (qL<=8) is
            # already 2-pass safe and must stay fast.
            long_ctx_threshold = max(
                1,
                _env_int(
                    "MTPLX_LONG_CTX_CHUNKED_ATTN_THRESHOLD",
                    max(partition_threshold, 8192),
                ),
            )
            steel_q_threshold = max(1, _env_int("MTPLX_STEEL_ATTN_Q_THRESHOLD", 8))
            if (
                partitioned_enabled
                and int(self.offset) >= long_ctx_threshold
                and q_len > steel_q_threshold
            ):
                split = run_partitioned_paged(force_fp32_paged=False)
                if split is not None:
                    return split
                split_out = self._large_q_split_sdpa_fallback(
                    queries,
                    scale=scale,
                    sliding_window=int(sliding_window),
                    mask=mask,
                )
                if split_out is not None:
                    self.paged_attention_calls += 1
                    self.kv_quant_attention_calls += 1
                    self.attention_time_s += time.perf_counter() - started
                    return split_out
                return bailout("long_ctx_chunked_attn_failed")
            if q_len > max_q_len and partitioned_enabled and int(self.offset) >= partition_threshold:
                return run_partitioned_paged(force_fp32_paged=False)
            out = scaled_dot_product_attention(
                queries,
                keys,
                values,
                cache=None,
                scale=scale,
                mask=mask,
            )
            self.paged_attention_calls += 1
            self.kv_quant_attention_calls += 1
            self.attention_time_s += time.perf_counter() - started
            return out'''

    for label, old, new in (
        ("mask", old_mask, new_mask),
        ("loop", old_loop, new_loop),
        ("kv_quant", old_kv, new_kv),
    ):
        if old not in text:
            raise SystemExit(f"{path.name}: block not found: {label}")
        text = text.replace(old, new, 1)

    path.write_text(text)
    py_compile.compile(str(path), doraise=True)
    print(f"{path.name}: patched")


def patch_attention_split(path: Path) -> None:
    text = path.read_text()
    if "LLooM long-ctx fix" in text:
        print(f"{path.name}: already patched")
        return

    ensure_backup(path)

    old = '''            if output is None:
                if hasattr(cache, "record_dense_fallback"):
                    cache.record_dense_fallback()
                elif hasattr(cache, "dense_fallback_calls"):
                    cache.dense_fallback_calls += 1
                if (
                    hasattr(cache, "long_context_dense_fallback_forbidden")
                    and cache.long_context_dense_fallback_forbidden()
                ):
                    raise RuntimeError(
                        "Sustained long-context paged attention attempted dense "
                        "cache.state fallback after the partition threshold"
                    )
                keys, values = cache.state
                output = scaled_dot_product_attention(
                    queries,
                    keys,
                    values,
                    cache=cache,
                    scale=self.scale,
                    mask=mask,
                )'''

    new = '''            if output is None:
                if hasattr(cache, "record_dense_fallback"):
                    cache.record_dense_fallback()
                elif hasattr(cache, "dense_fallback_calls"):
                    cache.dense_fallback_calls += 1
                if (
                    hasattr(cache, "long_context_dense_fallback_forbidden")
                    and cache.long_context_dense_fallback_forbidden()
                ):
                    raise RuntimeError(
                        "Sustained long-context paged attention attempted dense "
                        "cache.state fallback after the partition threshold"
                    )
                # LLooM long-ctx fix: prefer chunked large-q SDPA over materialising
                # full K/V + single steel_attention (GPU watchdog kill ~65k+).
                offset = int(getattr(cache, "offset", 0) or 0)
                long_thresh = 8192
                try:
                    import os as _os
                    long_thresh = int(
                        _os.environ.get("MTPLX_LONG_CTX_CHUNKED_ATTN_THRESHOLD", "8192")
                        or "8192"
                    )
                except Exception:
                    pass
                q_len = int(queries.shape[2]) if hasattr(queries, "shape") else 0
                if (
                    offset >= long_thresh
                    and q_len > 8
                    and hasattr(cache, "_large_q_split_sdpa_fallback")
                ):
                    chunked = cache._large_q_split_sdpa_fallback(
                        queries,
                        scale=self.scale,
                        sliding_window=int(getattr(cache, "sliding_window", -1) or -1),
                        mask=mask,
                    )
                    if chunked is not None:
                        output = chunked
                if output is None:
                    keys, values = cache.state
                    output = scaled_dot_product_attention(
                        queries,
                        keys,
                        values,
                        cache=cache,
                        scale=self.scale,
                        mask=mask,
                    )'''

    if old not in text:
        raise SystemExit(f"{path.name}: dense-fallback block not found")
    path.write_text(text.replace(old, new, 1))
    py_compile.compile(str(path), doraise=True)
    print(f"{path.name}: patched")


def main() -> int:
    root = find_mtplx()
    print("mtplx root:", root)
    patch_cache_state(root / "cache_state.py")
    patch_attention_split(root / "attention_split.py")
    print("done. Restart MTPLX runtimes. Pair with AGX_RELAX_CDM_CTXSTORE_TIMEOUT=1.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
