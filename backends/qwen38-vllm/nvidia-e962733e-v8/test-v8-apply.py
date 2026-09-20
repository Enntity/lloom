#!/usr/bin/env python3
"""Guard/apply tests for the Q38FN v8 PLE/QSA fusion overlays.

Exercises the real ``apply-overlays.py`` on temporary copies of the pinned
vLLM sources: it verifies the write path, the re-run idempotence, the
``--dry-run`` guard and the refused-unknown-source guard. It also cross-checks
the manifest ``baseSha256`` values against the in-repo baseline overlay files
where the post-baseline source is itself checked in. No GPU, image or network
is required.
"""

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def build_pack(tmp: Path):
    """Copy the pack, then synthesize a post-baseline vLLM root for it."""
    pack = tmp / "pack"
    (pack / "overlays").mkdir(parents=True)
    shutil.copy(ROOT / "apply-overlays.py", pack / "apply-overlays.py")
    for overlay in (ROOT / "overlays").glob("*.py"):
        shutil.copy(overlay, pack / "overlays" / overlay.name)
    manifest = json.loads((ROOT / "manifest.json").read_text())
    vllm_root = tmp / "vllm"
    for entry in manifest["files"]:
        prior = ("# synthesized post-baseline source: %s\n" % entry["source"]).encode()
        target = vllm_root / entry["target"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(prior)
        entry["baseSha256"] = sha(prior)
    (pack / "manifest.json").write_text(json.dumps(manifest))
    return pack, vllm_root, manifest


def run_apply(pack: Path, vllm_root: Path, *extra):
    return subprocess.run(
        [sys.executable, str(pack / "apply-overlays.py"), "--vllm-root", str(vllm_root), *extra],
        capture_output=True,
        text=True,
    )


class ApplyTests(unittest.TestCase):
    def test_apply_writes_then_is_idempotent(self):
        with tempfile.TemporaryDirectory() as raw:
            pack, vllm_root, manifest = build_pack(Path(raw))
            first = run_apply(pack, vllm_root)
            self.assertEqual(first.returncode, 0, first.stderr)
            reported = json.loads(first.stdout)
            self.assertEqual(reported["verified"], 5)
            self.assertTrue(reported["applied"])
            for entry in manifest["files"]:
                target = vllm_root / entry["target"]
                self.assertEqual(sha(target.read_bytes()), entry["sha256"], entry["source"])
            # A second run sees the already-applied sources and must succeed.
            second = run_apply(pack, vllm_root)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertTrue(json.loads(second.stdout)["applied"])

    def test_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as raw:
            pack, vllm_root, manifest = build_pack(Path(raw))
            before = {e["source"]: sha((vllm_root / e["target"]).read_bytes()) for e in manifest["files"]}
            result = run_apply(pack, vllm_root, "--dry-run")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(json.loads(result.stdout)["applied"])
            after = {e["source"]: sha((vllm_root / e["target"]).read_bytes()) for e in manifest["files"]}
            self.assertEqual(before, after)

    def test_refuses_unknown_source(self):
        with tempfile.TemporaryDirectory() as raw:
            pack, vllm_root, manifest = build_pack(Path(raw))
            victim = vllm_root / manifest["files"][0]["target"]
            victim.write_bytes(b"# unguarded local edit\n")
            result = run_apply(pack, vllm_root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("refusing unknown vLLM source", result.stderr)
            # The whole pack is left untouched when any guard fails.
            for entry in manifest["files"][1:]:
                target = vllm_root / entry["target"]
                self.assertNotEqual(sha(target.read_bytes()), entry["sha256"])


class RealGuardValueTests(unittest.TestCase):
    def test_post_baseline_hashes_match_checked_in_baseline_overlays(self):
        baseline = REPO / "backends/qwen38-vllm/nvidia-e962733e/overlays"
        manifest = json.loads((ROOT / "manifest.json").read_text())
        expected = {
            "ple_layer.py": baseline / "ple_layer.py",
            "ops_ple.py": baseline / "ops_ple.py",
        }
        seen = 0
        for entry in manifest["files"]:
            source = expected.get(entry["source"])
            if source is None:
                continue
            self.assertTrue(source.is_file(), source)
            self.assertEqual(sha(source.read_bytes()), entry["baseSha256"], entry["source"])
            seen += 1
        self.assertEqual(seen, 2)

    def test_base_revision_overlays_differ_from_post_baseline(self):
        manifest = json.loads((ROOT / "manifest.json").read_text())
        for entry in manifest["files"]:
            self.assertNotEqual(entry["baseSha256"], entry["sha256"], entry["source"])


if __name__ == "__main__":
    unittest.main()
