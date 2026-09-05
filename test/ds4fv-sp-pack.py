"""Hermetic SP indexer transform and cold-JIT header tests; no GPU required."""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACK = ROOT / 'backends/dspark-vllm/packs/miaai-ds4fv-9414dd58-sp'
spec = importlib.util.spec_from_file_location('sp_patch', PACK / 'patches/hotfix-dsv4-sp-indexer-prefill.py')
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)


class PackTests(unittest.TestCase):
    def test_transform_idempotence_and_drift(self):
        stock = (PACK / 'scripts/fixtures/sparse-attn-indexer-752a3a504-stock.py').read_text()
        self.assertNotIn(patch.MARK, stock)
        with tempfile.TemporaryDirectory() as directory:
            target = pathlib.Path(directory) / 'indexer.py'
            target.write_text(stock)
            self.assertTrue(patch.apply(target))
            changed = target.read_text()
            compile(changed, 'indexer.py', 'exec')
            self.assertFalse(patch.apply(target))
            self.assertEqual(changed, target.read_text())
            drift = stock.replace(patch.LOOP_OLD, '# incompatible upstream loop\n')
            target.write_text(drift)
            with self.assertRaises(AssertionError):
                patch.apply(target)
            self.assertEqual(drift, target.read_text())

    def test_header_aliases_and_missing_source(self):
        import os
        script = str(PACK / 'patches/hotfix-deepgemm-sm121-mqa-header-alias.sh')
        kernels = ('fp8_mqa_logits', 'fp8_paged_mqa_logits', 'fp4_mqa_logits', 'fp4_paged_mqa_logits')
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            env = {**os.environ, 'DEEP_GEMM_IMPLS_DIR': directory}
            self.assertNotEqual(subprocess.run(['bash', script], env=env, capture_output=True).returncode, 0)
            for kernel in kernels:
                (root / f'sm120_{kernel}.cuh').write_text('// stock header fixture\n')
            subprocess.run(['bash', script], env=env, check=True, capture_output=True)
            before = {p.name: p.read_bytes() for p in root.iterdir()}
            subprocess.run(['bash', script], env=env, check=True, capture_output=True)
            subprocess.run(['bash', script, '--status'], env=env, check=True, capture_output=True)
            self.assertEqual(before, {p.name: p.read_bytes() for p in root.iterdir()})
            for kernel in kernels:
                self.assertIn(f'#define sm121_{kernel} sm120_{kernel}', (root / f'sm121_{kernel}.cuh').read_text())


if __name__ == '__main__':
    unittest.main()
