#!/usr/bin/env python3
"""Offline integrity and execution-order tests for DSpark patch packs."""

from __future__ import annotations

import importlib.util
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "backends" / "dspark-vllm" / "apply-patch-pack.py"
PACK = ROOT / "backends" / "dspark-vllm" / "packs" / "miaai-dsv4flash-d1b76251-defaults"
MANIFEST = PACK / "manifest.json"


def load_runner():
    spec = importlib.util.spec_from_file_location("dspark_patch_pack", RUNNER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PatchPackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.runner = load_runner()
        cls.manifest = cls.runner.load_manifest(MANIFEST)

    def test_pinned_pack_inventory_and_checksums(self) -> None:
        verified = self.runner.verify_pack(MANIFEST, self.manifest)
        self.assertEqual(len(verified), 23)
        self.assertEqual(
            sum("upstreamSha256" in patch_data for patch_data, _ in verified),
            0,
        )
        self.assertEqual(
            [patch_data["id"] for patch_data, _ in verified if patch_data["enabled"]],
            [
                "issue21-dsml-dict-arguments",
                "issue22-nvfp4-sparse-mla-dispatch",
                "issue24-reasoning-grammar-boundary",
                "vllm52805-xgrammar-termination",
                "vllm51538-mtp-padding-length-clamp",
                "reasoning-stop-string-guard",
                "issue55-tool-truncation",
                "gb10-spin-wait",
                "empty-encoder-output",
                "issue27-partial-prefill-concurrency",
                "issue26-hybrid-swa-prefix-cache-v2",
                "issue43-decode-fairness",
                "vllm49486-skip-topk",
                "vllm48407-dense-prefill-indexer",
                "vllm50312-mtp-buffer",
                "vllm48957-skip-empty-c128",
                "vllm50298-flashmla-workspace",
            ],
        )

    def test_compatibility_is_fail_closed(self) -> None:
        compatibility = self.manifest["compatibility"]
        with self.assertRaisesRegex(self.runner.PackError, "incompatible runtimeImage"):
            self.runner.require_compatibility(
                self.manifest,
                "ghcr.io/example/wrong@sha256:bad",
                compatibility["model"],
                compatibility["modelRevision"],
            )

    def test_tampered_artifact_is_rejected_before_application(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            copied = Path(temp) / "pack"
            shutil.copytree(PACK, copied)
            target = copied / "patches" / "hotfix-encoding-dsv4-issue21.py"
            target.write_text(target.read_text(encoding="utf-8") + "\n# tampered\n", encoding="utf-8")
            manifest = self.runner.load_manifest(copied / "manifest.json")
            with self.assertRaisesRegex(self.runner.PackError, "checksum mismatch"):
                self.runner.verify_pack(copied / "manifest.json", manifest)

    def test_artifacts_cannot_escape_pack_root(self) -> None:
        with self.assertRaisesRegex(self.runner.PackError, "escapes patch-pack root"):
            self.runner.resolve_artifact(PACK.resolve(), "../outside.py")

    def test_enabled_patches_run_in_manifest_order_with_explicit_interpreters(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            temp_root = Path(temp)
            vllm_root = temp_root / "vllm"
            vllm_root.mkdir()
            first = temp_root / "first.py"
            second = temp_root / "second.sh"
            first.write_text("pass\n", encoding="utf-8")
            second.write_text(":\n", encoding="utf-8")
            verified = [
                (
                    {
                        "id": "first",
                        "kind": "python",
                        "enabled": True,
                        "args": ["{file}", "{vllmRoot}"],
                    },
                    first,
                ),
                (
                    {
                        "id": "disabled-middle",
                        "kind": "python",
                        "enabled": False,
                    },
                    first,
                ),
                (
                    {
                        "id": "second",
                        "kind": "shell",
                        "enabled": True,
                        "args": ["{file}"],
                        "env": {"VLLM_ROOT": "{vllmRoot}"},
                    },
                    second,
                ),
            ]
            with patch.object(self.runner.subprocess, "run") as run_mock:
                applied = self.runner.apply_enabled(verified, vllm_root)
            self.assertEqual(applied, 2)
            self.assertEqual(run_mock.call_args_list[0].args[0], ["python3", str(first), str(vllm_root)])
            self.assertEqual(run_mock.call_args_list[1].args[0], ["bash", str(second)])
            self.assertEqual(run_mock.call_args_list[1].kwargs["env"]["VLLM_ROOT"], str(vllm_root))


if __name__ == "__main__":
    unittest.main()
