#!/usr/bin/env python3
"""Backport vLLM PR #51538's padded-MTP indexer clamp.

DeepSeek V4 sparse-MLA decode pads CUDA-graph batches with requests whose
``seq_len`` is zero. When MTP expands each request to multiple token rows, the
first row of a padded request can receive a negative context length. The pinned
SM120/SM121 runtime consumes those lengths as unsigned values in its compiled
top-k extension, which can strand a cooperative CTA at a barrier and deadlock
the engine.

Upstream commit 318d623b497f53e7d1d3f12c4f07124e782c711b clamps both
indexer paths at zero. This compatibility-gated backport applies those exact
semantic changes to the pinned wheel's Python source. Upstream's additional
compiled-kernel hardening (f633bd67cdb105f3a37437e728dbac2df16511f3) cannot be
retrofitted into this source-less wheel; the indexer clamp prevents the known
invalid value from reaching that extension.
"""

from pathlib import Path
import sys


if len(sys.argv) != 2:
    raise SystemExit("usage: hotfix-dsv4-mtp-padding-lengths-51538.py INDEXER_PATH")

target = Path(sys.argv[1])
source = target.read_text(encoding="utf-8")

uniform_old = "    per_token_seq_len = seq_len - max_decode_len + local_idx + 1\n"
uniform_new = (
    "    # [vllm51538-hotfix] Padding requests have seq_len == 0; keep their\n"
    "    # expanded MTP context lengths non-negative before uint32 consumers.\n"
    "    per_token_seq_len = tl.maximum(\n"
    "        seq_len - max_decode_len + local_idx + 1, 0\n"
    "    )\n"
)
native_old = (
    "                seq_lens_buffer[:] = (\n"
    "                    seq_lens.unsqueeze(1)\n"
    "                    - max_decode_len\n"
    "                    + 1\n"
    "                    + self.offsets_buffer[:max_decode_len]\n"
    "                )\n"
)
native_new = (
    "                # [vllm51538-hotfix] Clamp CUDA-graph padding slots at 0.\n"
    "                seq_lens_buffer[:] = (\n"
    "                    seq_lens.unsqueeze(1)\n"
    "                    - max_decode_len\n"
    "                    + 1\n"
    "                    + self.offsets_buffer[:max_decode_len]\n"
    "                ).clamp_(min=0)\n"
)

uniform_fixed = uniform_new in source
native_fixed = native_new in source
if uniform_fixed and native_fixed:
    print(f"[vllm51538-hotfix] already applied to {target}")
    raise SystemExit(0)
if uniform_fixed or native_fixed:
    raise SystemExit("vLLM #51538 indexer clamp is only partially present; refusing to patch")
if source.count(uniform_old) != 1:
    raise SystemExit("uniform padded-MTP length anchor not found exactly once; refusing to patch")
if source.count(native_old) != 1:
    raise SystemExit("native padded-MTP length anchor not found exactly once; refusing to patch")

source = source.replace(uniform_old, uniform_new, 1)
source = source.replace(native_old, native_new, 1)
target.write_text(source, encoding="utf-8")
print(f"[vllm51538-hotfix] patched {target}")
