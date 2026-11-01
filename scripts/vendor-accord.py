#!/usr/bin/env python3
"""Import a qualified npm package as an immutable dependency snapshot, recording its digest."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
package = Path(sys.argv[1]).resolve()
root = Path(__file__).resolve().parents[1]
qualification = json.loads(Path(sys.argv[2]).read_text())
assert qualification['status'] == 'passed', 'Accord qualification must pass before vendoring'
with tempfile.TemporaryDirectory(prefix="lloom-accord-vendor-") as temporary:
    destination = Path(temporary)
    with tarfile.open(package) as archive:
        # npm packages are regular files/directories; never follow links or traversal paths.
        for member in archive.getmembers():
            parts = Path(member.name).parts
            if not parts or parts[0] != 'package' or '..' in parts or member.issym() or member.islnk():
                raise ValueError('Unsafe package entry')
        archive.extractall(destination, filter='data')
    source = destination / 'package'
    info = json.loads((source / 'package.json').read_text())
    assert info['name'] == '@enntity/accord'
    for name, digest in qualification['sources'].items():
        candidate = source / name
        if candidate.is_file():
            assert hashlib.sha256(candidate.read_bytes()).hexdigest() == digest, f'Package differs from qualified source: {name}'
    target = root / 'vendor/accord'
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(exist_ok=True)
    shutil.copytree(source, target)
    (root / 'vendor/accord-lock.json').write_text(json.dumps({
        'name': info['name'], 'version': info['version'], 'qualifiedAt': qualification['at'],
        'packageSHA256': hashlib.sha256(package.read_bytes()).hexdigest(),
        'files': {str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in sorted(target.rglob('*')) if p.is_file()},
    }, indent=2) + '\n')
