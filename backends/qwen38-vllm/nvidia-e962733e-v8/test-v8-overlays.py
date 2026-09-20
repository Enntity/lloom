#!/usr/bin/env python3
"""Static source-guard tests for the Q38FN v8 PLE/QSA fusion overlays.

Runs without a GPU or the pinned image: it asserts the overlay files match the
guard manifest and that the specific fused kernels, signatures and launcher
defaults the candidate relies on are present and correctly wired.
"""

import ast
import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OVERLAYS = ROOT / "overlays"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.manifest = json.loads((ROOT / "manifest.json").read_text())

    def test_manifest_targets_and_hashes(self):
        self.assertEqual(len(self.manifest["files"]), 5)
        for entry in self.manifest["files"]:
            path = OVERLAYS / entry["source"]
            self.assertTrue(path.is_file(), entry["source"])
            self.assertEqual(sha(path), entry["sha256"], entry["source"])
            self.assertRegex(entry["baseSha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(entry["sha256"], r"^[0-9a-f]{64}$")
            self.assertNotEqual(entry["sha256"], entry["baseSha256"])

    def test_pinned_revision_and_deferrals(self):
        self.assertEqual(
            self.manifest["vllmRevision"],
            "e962733e08d10f7ca65dac4df99e116460b8b174",
        )
        deferred = {d["pr"]: d["reason"] for d in self.manifest["deferred"]}
        self.assertEqual(set(deferred), {"54713", "55513"})
        self.assertTrue(all(deferred.values()))

    def test_overlays_parse(self):
        for entry in self.manifest["files"]:
            ast.parse((OVERLAYS / entry["source"]).read_bytes())

    def test_manifest_guard_id_and_layer(self):
        self.assertEqual(self.manifest["layer"], "post-baseline")
        self.assertIn("55309", self.manifest["id"] + self.manifest["upstream"])


class PleFusionTests(unittest.TestCase):
    def setUp(self):
        self.ple = (OVERLAYS / "ple_layer.py").read_text()
        self.ops = (OVERLAYS / "ops_ple.py").read_text()

    def test_short_conv_threads_outer_residual(self):
        self.assertIn("outer_residual: torch.Tensor,", self.ple)
        self.assertIn("residual.add_(outer_residual)", self.ple)
        self.assertIn("outer_residual=outer_residual", self.ple)

    def test_short_conv_op_forwards_hidden_states(self):
        # The custom-op call must pass hidden_states so the no-op path keeps
        # the outer residual, and the op definition must accept it.
        self.assertRegex(
            self.ple,
            r"qwen4_exp_ple_short_conv\(\s*conv_input, gated_output, hidden_states",
        )
        self.assertIn("outer_residual: torch.Tensor,\n    layer_name: str,", self.ple)

    def test_fused_kernel_fp32_residual_add(self):
        self.assertIn(
            "ple_output = outer_residual.to(tl.float32) + ple_output.to(tl.float32)",
            self.ops,
        )

    def test_reasoning_chain_uses_ple_return(self):
        # The reasoning-chain hoist lives in model.py, not ple_layer.py.
        model = (OVERLAYS / "model.py").read_text()
        self.assertIn("hidden_states = self.ple(", model)
        self.assertNotIn("hidden_states = hidden_states + self.ple(", model)


class QsaFusionTests(unittest.TestCase):
    def setUp(self):
        self.qsa = (OVERLAYS / "qsa.py").read_text()
        self.ops = (OVERLAYS / "ops_qsa.py").read_text()

    def test_gate_is_mandatory_and_sigmoid_moves_to_kernel(self):
        self.assertIn("assert gate is not None", self.qsa)
        self.assertNotIn("flat_output = flat_output * torch.sigmoid(gate)", self.qsa)
        self.assertIn("output_gate: torch.Tensor,", self.ops)

    def test_gate_reaches_the_fused_custom_op(self):
        self.assertRegex(
            self.qsa,
            r"qwen4_exp_qsa_with_output\(\s*hidden_states,\s*positions,\s*query,"
            r"\s*key,\s*value,\s*attn_output,\s*gate,",
        )
        self.assertIn("output_gate: torch.Tensor,\n    layer_name: LayerNameType,", self.qsa)

    def test_kernels_apply_fp32_sigmoid_gate(self):
        self.assertEqual(self.ops.count("tl.sigmoid(output_gate)"), 2)
        self.assertIn("assert output_gate.is_contiguous()", self.ops)

    def test_warmup_passes_gate(self):
        self.assertIn("output_gate_ptr = TritonWarmupTensor(", self.ops)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT / "entrypoint.sh").read_text()

    def test_kv_budget_default_is_28gib(self):
        self.assertIn('KV_CACHE_MEMORY_BYTES:-30064771072', self.text)
        self.assertIn('--kv-cache-memory-bytes "$KV_CACHE_MEMORY_BYTES"', self.text)

    def test_composed_stack_precedes_prefix(self):
        self.assertLess(self.text.index('/opt/lloom/qwen-v8/apply-stack.py'),
                        self.text.index('/opt/lloom/qwen-prefix/apply-prefix-fixes.py'))

    def test_preserves_engine_settings(self):
        for flag in (
            "--quantization modelopt",
            "--tensor-parallel-size",
            "--max-model-len",
            "--load-format safetensors",
            "--safetensors-load-strategy lazy",
            "--enable-chunked-prefill",
            "--no-enable-flashinfer-autotune",
            "--reasoning-parser qwen3",
            "--tool-call-parser qwen3_xml",
            '{"mode":0,"cudagraph_mode":"FULL_DECODE_ONLY"}',
            "MTP_NUM_SPECULATIVE_TOKENS:-3",
            "PREFIX_CACHE_RETENTION_INTERVAL:-1600",
        ):
            self.assertIn(flag, self.text)

    def test_bf16_kv_only(self):
        self.assertNotIn("fp8", self.text.lower())


if __name__ == "__main__":
    unittest.main()
