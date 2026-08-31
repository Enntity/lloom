#!/usr/bin/env python3
"""Enable the image's existing FP8 PLE loader for ModelOpt NVFP4 weights.

The RadixArk checkpoint excludes PLE from its parent NVFP4 config but stores
that table in the exact sharded FP8 format handled by vLLM's PLE FP8 method.
The pinned day-one image gates that method on an Fp8Config parent, so loading
otherwise attempts a BF16 embedding and fails on the checkpoint weight_scale.
"""

from __future__ import annotations

import glob
import hashlib
import pathlib
import re
import sys


MARKER = "# lloom: RadixArk NVFP4 uses the checkpoint's FP8 PLE shards"
EXPECTED_SOURCE_SHA256 = "a71144c1d36e06f22a2da1b1ada900076597fe5e824a911e7ada86249a0993e7"


def candidates() -> list[pathlib.Path]:
    roots = glob.glob("/usr/local/lib/python*/dist-packages/vllm/models")
    roots += glob.glob("/usr/local/lib/python*/site-packages/vllm/models")
    paths: list[pathlib.Path] = []
    for root in roots:
        base = pathlib.Path(root)
        paths.extend(
            [
                base / "qwen3_8_flash_next/nvidia/ple_layer.py",
                base / "qwen4_exp/nvidia/ple_layer.py",
            ]
        )
    return [path for path in paths if path.is_file()]


def patch(path: pathlib.Path) -> None:
    source = path.read_text()
    if MARKER in source:
        print(f"PLE loader patch already present: {path}", flush=True)
        return

    source_sha256 = hashlib.sha256(source.encode()).hexdigest()
    if source_sha256 != EXPECTED_SOURCE_SHA256:
        raise RuntimeError(
            f"refusing unknown PLE source at {path}: "
            f"expected {EXPECTED_SOURCE_SHA256}, found {source_sha256}"
        )

    class_match = re.search(r"^class (Qwen\w*PLEFp8EmbeddingMethod)\(", source, re.MULTILINE)
    if not class_match:
        raise RuntimeError(f"FP8 PLE method not found in {path}")
    method = class_match.group(1)
    anchor = "    if not isinstance(quant_config, Fp8Config):\n"
    if source.count(anchor) != 1:
        raise RuntimeError(f"expected one PLE Fp8Config gate in {path}, found {source.count(anchor)}")
    if "import os\n" not in source:
        import_anchor = "import math\n"
        if source.count(import_anchor) != 1:
            raise RuntimeError(f"stable import anchor not found in {path}")
        source = source.replace(import_anchor, "import math\nimport os\n", 1)
    override = (
        f"    {MARKER}\n"
        "    if os.environ.get(\"PLE_FORCE_FP8\") == \"1\":\n"
        f"        return {method}()\n\n"
    )
    path.write_text(source.replace(anchor, override + anchor, 1))
    print(f"Applied FP8 PLE loader patch: {path}", flush=True)


paths = [pathlib.Path(sys.argv[1])] if len(sys.argv) == 2 else candidates()
if len(paths) != 1:
    raise SystemExit(f"expected one Qwen PLE implementation, found {len(paths)}: {paths}")
patch(paths[0])
