#!/usr/bin/env python3
"""Build/reuse the local image identified by its bundled source digest."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def source_digest(root=ROOT):
    files = [root / name for name in ('Dockerfile', 'requirements.txt', 'server.py', 'pipeline.py')]
    digest = hashlib.sha256()
    for file in sorted(files):
        digest.update(file.relative_to(root).as_posix().encode() + b'\0')
        digest.update(file.read_bytes() + b'\0')
    return digest.hexdigest()


def image_name():
    return 'lloom/qwen-image-diffusers:source-' + source_digest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--install-root', type=Path)
    parser.add_argument('--shim-dir', type=Path)
    parser.add_argument('--print-image', action='store_true')
    args = parser.parse_args()
    image = image_name()
    if args.print_image:
        print(image)
        return
    if args.install_root is None or args.shim_dir is None:
        parser.error('--install-root and --shim-dir are required')
    if sys.platform != 'linux':
        parser.error('The CUDA backend requires Linux and NVIDIA Container Toolkit')
    found = subprocess.run(['docker', 'image', 'inspect', image], capture_output=True, text=True)
    expected = source_digest()
    if found.returncode == 0:
        labels = json.loads(found.stdout)[0].get('Config', {}).get('Labels', {}) or {}
        if labels.get('dev.lloom.source-sha256') != expected:
            raise SystemExit('Refusing an existing image with an unexpected source identity: ' + image)
        print('Reusing ' + image)
    else:
        subprocess.run(['docker', 'build', '--label', 'dev.lloom.source-sha256=' + expected,
                        '--tag', image, str(ROOT)], check=True)
    if not shutil.which('hf'):
        venv = args.install_root / 'qwen-image-diffusers' / 'huggingface'
        if not (venv / 'bin/python').exists():
            subprocess.run([sys.executable, '-m', 'venv', str(venv)], check=True)
        subprocess.run([str(venv / 'bin/python'), '-m', 'pip', 'install', 'huggingface-hub==1.7.1'], check=True)
        args.shim_dir.mkdir(parents=True, exist_ok=True)
        shim = args.shim_dir / 'hf'
        if shim.exists() or shim.is_symlink():
            if shim.resolve() != (venv / 'bin/hf').resolve():
                raise SystemExit('Refusing to replace an unrelated hf shim')
        else:
            shim.symlink_to(venv / 'bin/hf')


if __name__ == '__main__':
    main()
