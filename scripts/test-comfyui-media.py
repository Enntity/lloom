#!/usr/bin/env python3
"""Run offline ComfyUI tests with the selected Python's installed test requirements."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
backend = root / 'backends/comfyui-media'
env = dict(os.environ)
env['PYTHONPATH'] = os.pathsep.join(str(backend / name) for name in ('bridge', 'graphs', 'build'))
raise SystemExit(subprocess.call([sys.executable, '-m', 'pytest', '-q', '-p', 'tests._runner',
    '-p', 'no:cacheprovider', '-c', str(backend / 'bridge/pytest.ini'), '--disable-warnings',
    str(backend / 'bridge/tests'), str(backend / 'graphs'), str(backend / 'build')], cwd=root, env=env))
