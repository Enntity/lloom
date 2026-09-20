#!/usr/bin/env python3
"""Compose the pinned baseline and v8 overlays before writing any source.

Accept pristine, baseline-patched or final bytes for each known target. This
makes normal container restarts safe without weakening the v7 installer guards.
"""
import argparse
import ast
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent

def digest(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None

def apply(root, baseline, upgrade=HERE, dry_run=False):
    entries = {}
    for pack in [baseline, upgrade]:
        manifest = json.loads((pack / 'manifest.json').read_text())
        for entry in manifest['files']:
            payload = (pack / 'overlays' / entry['source']).read_bytes()
            if digest(payload) != entry['sha256']:
                raise RuntimeError(f"overlay checksum mismatch: {entry['source']}")
            ast.parse(payload)
            target = root / entry['target']
            previous = entries.get(target)
            if previous and entry['baseSha256'] != digest(previous['payload']):
                raise RuntimeError(f'incompatible overlay chain: {target}')
            allowed = set(previous['allowed']) if previous else {entry['baseSha256']}
            allowed.add(entry['sha256'])
            entries[target] = {'payload': payload, 'allowed': allowed}
    changes = []
    for target, entry in entries.items():
        before = target.read_bytes() if target.exists() else None
        if digest(before) not in entry['allowed']:
            raise RuntimeError(f'refusing unknown vLLM source: {target} ({digest(before)})')
        changes.append((target, before, entry['payload']))
    if not dry_run:
        for target, before, _ in changes:
            if (target.read_bytes() if target.exists() else None) != before:
                raise RuntimeError(f'vLLM source changed during validation: {target}')
        for target, before, payload in changes:
            if before != payload:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(payload)
    print(json.dumps({'pack':'qwen38-v8-composed-stack','verified':len(changes),'applied':not dry_run}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--vllm-root',type=Path,default=Path('/usr/local/lib/python3.12/dist-packages/vllm'))
    parser.add_argument('--baseline',type=Path,default=Path('/opt/lloom/qwen-nvidia'))
    parser.add_argument('--dry-run',action='store_true')
    args=parser.parse_args()
    apply(args.vllm_root,args.baseline,dry_run=args.dry_run)
