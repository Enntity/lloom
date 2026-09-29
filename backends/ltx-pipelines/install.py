#!/usr/bin/env python3
"""Build or reuse the local native LTX-2.5 image, identified by source digest.

Mirrors ``backends/ace-step-diffusers/install.py``: the image tag embeds a
SHA-256 over the fixed build inputs, and an existing image is only reused when
its ``dev.lloom.source-sha256`` label matches. A stale or foreign image with the
same tag is refused rather than silently built on top of.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent

SOURCE_FILES = ('Dockerfile', 'requirements.txt', 'server.py', 'pipelines.py', 'upstream-uv.lock', 'a2v.py', 'UPSTREAM-LICENSE', 'LICENSE-2_x')


def source_digest(root=ROOT):
    digest = hashlib.sha256()
    for name in SOURCE_FILES:
        file = root / name
        digest.update(name.encode() + b'\0')
        digest.update(file.read_bytes() + b'\0')
    return digest.hexdigest()


def image_name():
    return 'lloom/ltx-pipelines:source-' + source_digest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--print-image', action='store_true')
    parser.add_argument('--install-root', type=Path)
    parser.add_argument('--build-only', action='store_true')
    args = parser.parse_args()
    image = image_name()
    if args.print_image:
        print(image)
        return
    if sys.platform != 'linux':
        parser.error('The native LTX CUDA image requires Linux and NVIDIA Container Toolkit')
    expected = source_digest()
    found = subprocess.run(['docker', 'image', 'inspect', image], capture_output=True, text=True)
    if found.returncode == 0:
        labels = json.loads(found.stdout)[0].get('Config', {}).get('Labels', {}) or {}
        if labels.get('dev.lloom.source-sha256') != expected:
            raise SystemExit('Refusing an existing image with an unexpected source identity: ' + image)
        print('Reusing ' + image)
        return
    subprocess.run(['docker', 'build', '--label', 'dev.lloom.source-sha256=' + expected,
                    '--tag', image, str(ROOT)], check=True)


if __name__ == '__main__':
    main()
