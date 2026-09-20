"""Check dependencies, including NVIDIA's nonstandard SBSA wheel tag."""
import importlib.metadata
import platform
import subprocess
import sys


def main():
    check = subprocess.run([sys.executable, '-m', 'pip', 'check'], capture_output=True, text=True)
    lines = check.stdout.strip().splitlines()
    # CUDA 13 ships its ARM cuSPARSELt wheel with manylinux2014_sbsa instead
    # of manylinux2014_aarch64. pip installs it as a CUDA dependency but its
    # platform audit rejects that tag. Permit only this exact metadata defect.
    expected = 'nvidia-cusparselt-cu13 0.8.0 is not supported on this platform'
    if check.returncode:
        wheel = importlib.metadata.distribution('nvidia-cusparselt-cu13').read_text('WHEEL') or ''
        if not (platform.machine() == 'aarch64' and lines == [expected]
                and 'Tag: py3-none-manylinux2014_sbsa' in wheel and not check.stderr.strip()):
            raise SystemExit(check.stdout + check.stderr)
        print('Accepted known NVIDIA SBSA wheel-tag defect; verifying CUDA library imports.')
    import torch
    import torchvision
    import torchaudio
    assert torch.__version__ == '2.11.0+cu130', torch.__version__
    assert torchvision.__version__ == '0.26.0+cu130', torchvision.__version__
    assert torchaudio.__version__ == '2.11.0+cu130', torchaudio.__version__
    assert torch.version.cuda == '13.0', torch.version.cuda
    print('CUDA dependency imports passed.')


if __name__ == '__main__':
    main()
