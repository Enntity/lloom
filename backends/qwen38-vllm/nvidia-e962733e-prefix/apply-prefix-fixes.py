#!/usr/bin/env python3
"""Version-guarded prefix-cache candidate for vLLM e962733e (stdlib only).

Block-size diagnosis and corrections: blazux/qwen3.8-Flash-DGX,
bd60fcb1b492ca920f74df7462f05da7b6d98f73, src/patch_mamba_block_size.py.
Apache-2.0 upstream attribution; this guarded installer validates both files
before modifying either. It does not change the target checkpoint or kernels.
"""
import ast
import hashlib
import json
import pathlib
import sys

PATCHES = [
    ('v1/worker/gpu/model_states/mamba_hybrid.py',
     '573e130ac5587d4822fabf97adad1ad0fda02ff83c5e70df879a5bb175ae845c',
     '(new_req_data.num_computed_tokens - 1) // self.cache_config.block_size',
     '(new_req_data.num_computed_tokens - 1)\n                // (self.cache_config.mamba_block_size or self.cache_config.block_size)'),
    ('v1/core/sched/scheduler.py',
     'e5e1c18b1d7a6ea73adbb4921f64a35b00a96abe673691bf6a7f57281a524519',
     '        block_size = self.cache_config.block_size\n        # The last block-aligned position',
     '        block_size = self.block_size  # LCM of hybrid KV group block sizes\n        # The last block-aligned position'),
]

def prepare(root):
    prepared = []
    for relative, expected, old, new in PATCHES:
        path = root / relative
        source = path.read_text()
        if new in source and old not in source:
            original = source.replace(new, old)
            assert hashlib.sha256(original.encode()).hexdigest() == expected, f'Unknown patched source: {relative}'
            continue
        assert hashlib.sha256(source.encode()).hexdigest() == expected, f'Unknown input: {relative}'
        assert source.count(old) == 1, f'Ambiguous replacement: {relative}'
        changed = source.replace(old, new)
        ast.parse(changed)
        prepared.append((path, changed))
    return prepared

if __name__ == '__main__':
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/usr/local/lib/python3.12/dist-packages/vllm')
    for path, changed in prepare(root):
        path.write_text(changed)
    print(json.dumps({'prefixFixes': 'e962733e-hybrid-block-size', 'verified': 2}))
