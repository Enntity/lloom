#!/usr/bin/env python3
"""Apply reviewed Qwen overlays only to the exact pinned vLLM sources."""

import argparse
import ast
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def sha(data):
    return hashlib.sha256(data).hexdigest()


def apply(root, dry_run=False):
    manifest = json.loads((ROOT / "manifest.json").read_text())
    changes = []
    for entry in manifest["files"]:
        target = root / entry["target"]
        payload = (ROOT / "overlays" / entry["source"]).read_bytes()
        if sha(payload) != entry["sha256"]:
            raise RuntimeError(f"overlay checksum mismatch: {entry['source']}")
        ast.parse(payload)
        before = target.read_bytes() if target.exists() else None
        actual = sha(before) if before is not None else None
        if actual not in (entry["baseSha256"], entry["sha256"]):
            raise RuntimeError(f"refusing unknown vLLM source: {target} ({actual})")
        changes.append((target, before, payload))
    # Validate every file before applying any overlay.
    if not dry_run:
        for target, before, _ in changes:
            if (target.read_bytes() if target.exists() else None) != before:
                raise RuntimeError(f"vLLM source changed during validation: {target}")
        for target, before, payload in changes:
            if before != payload:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(payload)
    print(json.dumps({"pack": manifest["id"], "verified": len(changes), "applied": not dry_run}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vllm-root", type=Path, default=Path("/usr/local/lib/python3.12/dist-packages/vllm"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    apply(args.vllm_root, args.dry_run)
