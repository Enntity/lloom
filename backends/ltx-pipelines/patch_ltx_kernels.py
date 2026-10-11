#!/usr/bin/env python3
"""Teach the pinned ltx-kernels build about GB10 (DGX Spark, sm_121).

Upstream's NVFP4 extension targets the arch-specific Blackwell codes it was
validated on (sm_100a, sm_110a, sm_120a). Arch-specific ("a") cubins do not run
on a different SM, so an sm_120a build cannot load on the GB10's sm_121, and the
pre-quantized NVFP4 checkpoint fails with "ltx-kernels not built". sm_121a has
the same E2M1 conversion instructions and cuBLASLt block-scaled FP4 kernels, so
the fix is to add it to the target list and to the TORCH_CUDA_ARCH_LIST mapping.

Every edit is asserted, so a future upstream change to setup.py fails the image
build instead of silently building without the extension.
"""
import sys
from pathlib import Path

path = Path(sys.argv[1])
source = path.read_text()

EDITS = [
    (
        '_NVFP4_ARCHES = ["100a", "110a", "120a"]',
        '_NVFP4_ARCHES = ["100a", "110a", "120a", "121a"]',
    ),
    (
        '        elif tok.startswith("12.0"):\n            sel.append("120a")\n    return [a for a in dict.fromkeys(sel) if a in base]',
        '        elif tok.startswith("12.0"):\n            sel.append("120a")\n        elif tok.startswith("12.1"):\n            sel.append("121a")\n    return [a for a in dict.fromkeys(sel) if a in base]',
    ),
]

for old, new in EDITS:
    if source.count(old) != 1:
        raise SystemExit(f"ltx-kernels setup.py changed upstream; cannot apply: {old.splitlines()[0]!r}")
    source = source.replace(old, new)

path.write_text(source)
print("ltx-kernels: NVFP4 extension will also build for sm_121a")
