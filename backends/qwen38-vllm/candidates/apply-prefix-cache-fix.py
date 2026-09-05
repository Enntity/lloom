#!/usr/bin/env python3
"""Candidate only: repair the pinned Qwen image's hybrid prefix-cache geometry.

Not invoked by the production recipe. Validate fresh versus cached continuation
through the TP2 gateway before promotion. Adapted from blazux/qwen3.8-Flash-DGX
b76890d5a033dd00166c792393d39cf908f56034 (Apache-2.0), with exact input/output
hash guards and validation of both files before either is written.
"""

import argparse
import ast
import hashlib
from pathlib import Path


PATCHES = (
    (
        "v1/worker/gpu/model_states/mamba_hybrid.py",
        "2e65f1da0a440f11a784bd36afe9206a7a2f674d522c047b838ad604e4c6acc0",
        "                (new_req_data.num_computed_tokens - 1) // self.cache_config.block_size\n",
        "                (new_req_data.num_computed_tokens - 1)\n"
        "                // (self.cache_config.mamba_block_size or self.cache_config.block_size)\n",
    ),
    (
        "v1/core/sched/scheduler.py",
        "c710f49e41e974e5b7b8f1cd2f5fb9722523f4da0165252e16351199ebd03124",
        "        block_size = self.cache_config.block_size\n"
        "        # The last block-aligned position whose state can be cached.",
        "        block_size = self.block_size  # LCM of Qwen's KV groups; includes the Mamba grid\n"
        "        # The last block-aligned position whose state can be cached.",
    ),
)


def digest(source):
    return hashlib.sha256(source.encode()).hexdigest()


def plan(root):
    changes = []
    for relative, expected, old, new in PATCHES:
        path = root / relative
        source = path.read_text()
        if digest(source) == expected:
            if source.count(old) != 1:
                raise RuntimeError(f"expected one patch anchor: {path}")
            updated = source.replace(old, new, 1)
        elif source.count(new) == 1 and digest(source.replace(new, old, 1)) == expected:
            updated = source
        else:
            raise RuntimeError(f"refusing unknown source: {path} ({digest(source)})")
        ast.parse(updated)
        changes.append((path, source, updated))
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vllm_root", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    changes = plan(args.vllm_root)
    for path, before, after in changes:
        print(f"{path.name}: {'already patched' if before == after else 'verified candidate'}; sha256={digest(after)}")
    if args.apply:
        for path, before, _ in changes:
            if path.read_text() != before:
                raise RuntimeError(f"source changed during validation: {path}")
        for path, before, after in changes:
            if before != after:
                path.write_text(after)
    else:
        print("Dry run; no files changed")


if __name__ == "__main__":
    main()
