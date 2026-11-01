#!/usr/bin/env python3
"""Refuse an edited or incomplete dependency snapshot before packaging."""
import hashlib
import json
from pathlib import Path
root = Path(__file__).resolve().parents[1]
lock = json.loads((root / 'vendor/accord-lock.json').read_text())
for name, digest in lock['files'].items():
    assert hashlib.sha256((root / 'vendor/accord' / name).read_bytes()).hexdigest() == digest, name
actual = {str(p.relative_to(root / 'vendor/accord')) for p in (root / 'vendor/accord').rglob('*') if p.is_file()}
assert actual == set(lock['files']), 'Unexpected dependency files'
print('Accord dependency matches its qualified package snapshot.')
