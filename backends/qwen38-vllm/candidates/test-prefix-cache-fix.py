#!/usr/bin/env python3
"""CPU regression against exact files extracted from the pinned image.

Usage: python3 test-prefix-cache-fix.py /path/to/extracted-files
The directory must contain mamba_hybrid.py and scheduler.py. No GPU/import of
vLLM required: executes the real methods with small state/tensor substitutes.
"""

import ast
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace as NS

spec = importlib.util.spec_from_file_location("patch", Path(__file__).with_name("apply-prefix-cache-fix.py"))
patch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patch)


def method(source, name):
    tree = ast.parse(source)
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name)
    fn.returns = None
    for arg in fn.args.args:
        arg.annotation = None
    return ast.unparse(fn)


def seed(source, computed, generic_block, mamba_block):
    namespace = {}
    exec("class Base:\n    def add_request(self, *args): pass\nclass Worker(Base):\n" +
         "\n".join("    " + line for line in method(source, "add_request").splitlines()), namespace)
    worker = namespace['Worker']()
    slot = NS(value=None)
    slot.fill_ = lambda value: setattr(slot, 'value', value)
    worker.num_accepted_tokens_gpu = [NS(fill_=lambda value: None)]
    worker._mamba_state_idx_gpu = [slot]
    worker._align_mode = True
    worker.cache_config = NS(block_size=generic_block, mamba_block_size=mamba_block)
    worker.add_request(0, NS(num_computed_tokens=computed))
    return slot.value


def split(source, start, chunk, generic_block, state_block):
    namespace = {}
    exec(method(source, "_mamba_block_aligned_split"), namespace)
    scheduler = NS(cache_config=NS(block_size=generic_block), block_size=state_block,
                   use_eagle=True, max_num_scheduled_tokens=8192,
                   scheduler_config=NS(long_prefill_token_threshold=0),
                   mamba_partial_cache_hit=False, hash_block_size=16)
    request = NS(num_computed_tokens=start, num_prompt_tokens=32000,
                 num_tokens=32000, shared_prefix_boundary=0)
    return namespace['_mamba_block_aligned_split'](scheduler, request, chunk)


with tempfile.TemporaryDirectory(prefix='q38-prefix-regression-') as tmp:
    root = Path(tmp)
    for relative, *_ in patch.PATCHES:
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((Path(sys.argv[1]) / destination.name).read_bytes())
    changes = patch.plan(root)
    old_worker, new_worker = changes[0][1:]
    old_scheduler, new_scheduler = changes[1][1:]
    assert seed(old_worker, 16000, 16, 1600) == 999
    assert seed(new_worker, 16000, 16, 1600) == 9
    assert split(old_scheduler, 0, 8192, 16, 1600) == 8192
    assert split(new_scheduler, 0, 8192, 16, 1600) == 8000
    for computed in [0, 1, 1600, 16000, 262000]:
        assert seed(old_worker, computed, 1600, 1600) == seed(new_worker, computed, 1600, 1600)
    for start in [0, 1600, 3200, 16000]:
        n = split(new_scheduler, start, 8192, 16, 1600)
        assert (start + n) % 1600 == 0
        assert split(old_scheduler, start, 8192, 1600, 1600) == n
    for path, _, updated in changes:
        path.write_text(updated)
    assert all(before == after for _, before, after in patch.plan(root)), 'must be idempotent'
    # A partially patched/unknown image must fail before any source is written.
    changes[1][0].write_text(changes[1][2] + '\n# unexpected drift\n')
    before = changes[0][0].read_bytes()
    try:
        patch.plan(root)
        raise AssertionError('unknown source accepted')
    except RuntimeError as exc:
        assert 'refusing unknown source' in str(exc)
    assert changes[0][0].read_bytes() == before
print('PASS: reproduced wrong state slot and misaligned chunk; corrected geometry, equal-layout parity, idempotence, unknown-source refusal')
