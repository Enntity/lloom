"""Exercise multi-layer first install, restart, interrupted install and rejection."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('stack',Path(__file__).with_name('apply-stack.py'))
stack=importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack)

class StackTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)/'vllm';self.root.mkdir()
        self.base=Path(self.tmp.name)/'base';self.new=Path(self.tmp.name)/'new'
        self.raw=b'VALUE=0\n';self.mid=b'VALUE=1\n';self.final=b'VALUE=2\n'
        for pack,before,after in [(self.base,self.raw,self.mid),(self.new,self.mid,self.final)]:
            (pack/'overlays').mkdir(parents=True)
            (pack/'overlays'/'a.py').write_bytes(after)
            (pack/'manifest.json').write_text(json.dumps({'files':[{'source':'a.py','target':'a.py','baseSha256':stack.digest(before),'sha256':stack.digest(after)}]}))
        (self.root/'a.py').write_bytes(self.raw)
    def apply(self,**kw):stack.apply(self.root,self.base,self.new,**kw)
    def test_pristine_baseline_and_restart(self):
        for before in [self.raw,self.mid,self.final]:
            (self.root/'a.py').write_bytes(before);self.apply()
            self.assertEqual((self.root/'a.py').read_bytes(),self.final)
    def test_unknown_source_does_not_write(self):
        (self.root/'a.py').write_bytes(b'UNKNOWN=9\n')
        with self.assertRaisesRegex(RuntimeError,'unknown'):self.apply()
        self.assertEqual((self.root/'a.py').read_bytes(),b'UNKNOWN=9\n')
    def test_dry_run(self):
        self.apply(dry_run=True);self.assertEqual((self.root/'a.py').read_bytes(),self.raw)
    def test_baseline_payload_still_verified_after_upgrade(self):
        self.apply();(self.base/'overlays'/'a.py').write_bytes(b'TAMPER=3\n')
        with self.assertRaisesRegex(RuntimeError,'checksum'):self.apply()
    def test_incompatible_chain_refused(self):
        path=self.new/'manifest.json';m=json.loads(path.read_text());m['files'][0]['baseSha256']='wrong';path.write_text(json.dumps(m))
        with self.assertRaisesRegex(RuntimeError,'incompatible'):self.apply()
    def test_all_sources_checked_before_write(self):
        manifest=json.loads((self.base/'manifest.json').read_text())
        (self.base/'overlays'/'b.py').write_bytes(self.mid)
        manifest['files'].append({'source':'b.py','target':'b.py','baseSha256':stack.digest(self.raw),'sha256':stack.digest(self.mid)})
        (self.base/'manifest.json').write_text(json.dumps(manifest))
        (self.root/'b.py').write_bytes(b'UNKNOWN=9\n')
        with self.assertRaisesRegex(RuntimeError,'unknown'):self.apply()
        self.assertEqual((self.root/'a.py').read_bytes(),self.raw)

if __name__=='__main__':unittest.main()
