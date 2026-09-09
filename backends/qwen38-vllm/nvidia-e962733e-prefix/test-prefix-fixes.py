#!/usr/bin/env python3
"""Installer safety tests; cache semantics are separately verified on TP2."""
import hashlib
import importlib.util
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prefix_fixes', pathlib.Path(__file__).with_name('apply-prefix-fixes.py'))
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)


class PrefixInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.original = patch.PATCHES
        self.source = 'x = 1\n'
        digest = hashlib.sha256(self.source.encode()).hexdigest()
        patch.PATCHES = [('a.py', digest, 'x = 1', 'x = 2'), ('b.py', digest, 'x = 1', 'x = 2')]
        for name in ['a.py', 'b.py']:
            (self.root / name).write_text(self.source)

    def tearDown(self):
        patch.PATCHES = self.original
        self.temp.cleanup()

    def test_idempotent_exact_input(self):
        for path, changed in patch.prepare(self.root):
            path.write_text(changed)
        self.assertEqual(patch.prepare(self.root), [])

    def test_second_unknown_file_cannot_partially_modify_first(self):
        (self.root / 'b.py').write_text('x = 9\n')
        with self.assertRaises(AssertionError):
            for path, changed in patch.prepare(self.root):
                path.write_text(changed)
        self.assertEqual((self.root / 'a.py').read_text(), self.source)

    def test_unknown_already_patched_source_rejected(self):
        (self.root / 'a.py').write_text('x = 2\ny = 3\n')
        with self.assertRaises(AssertionError):
            patch.prepare(self.root)


if __name__ == '__main__':
    unittest.main()
