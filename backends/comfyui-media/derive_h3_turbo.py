#!/usr/bin/env python3
"""Derive the merged MXFP8 MiniMax-H3 Turbo checkpoint in the pinned media image.

The merge reads the recipe's two pinned downloads and writes one file next to
them. It needs the GPU for about five minutes and ~25 GB of host memory, so it
must not run beside a live H3 render.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import install  # noqa: E402

BASE = "Comfy-Org--MiniMax-H3/diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors"
LORA = "lightx2v--Minimax-h3-Turbo/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors"
OUT = "lloom-derived--MiniMax-H3-Turbo/minimax_h3_fl2va_turbo8_merged_mxfp8.safetensors"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-root", type=Path, required=True)
    args = parser.parse_args()
    base, lora, out = (args.model_root / name for name in (BASE, LORA, OUT))
    for path in (base, lora):
        if not path.is_file():
            raise SystemExit(f"Missing pinned input {path}; run the recipe's download steps first")
    image = install.ensure_image()
    stamp = out.with_name(out.name + ".json")
    identity = {"image": image, "base": base.name, "lora": lora.name}
    if out.is_file() and stamp.is_file() and json.loads(stamp.read_text()) == identity:
        print(f"Reusing {out}")
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    partial = out.with_name(out.name + ".partial")
    partial.unlink(missing_ok=True)
    subprocess.run([
        "docker", "run", "--rm", "--gpus", "all", "--user", f"{os.getuid()}:{os.getgid()}", "--entrypoint", "",
        "--mount", f"type=bind,src={base},dst=/in/base.safetensors,readonly",
        "--mount", f"type=bind,src={lora},dst=/in/lora.safetensors,readonly",
        "--mount", f"type=bind,src={out.parent},dst=/out",
        image, "/opt/venv/bin/python", "/opt/lloom-media/build/merge_h3_turbo.py",
        "/in/base.safetensors", "/in/lora.safetensors", f"/out/{partial.name}",
    ], check=True)
    partial.replace(out)
    stamp.write_text(json.dumps(identity) + "\n")


if __name__ == "__main__":
    main()
