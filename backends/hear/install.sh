#!/usr/bin/env bash
# Install the LLooM Hear backend into the LLooM-managed backend venv and expose a shim.
set -euo pipefail
HOME_ROOT="${LLOOM_HOME:-$HOME/.lloom}"
BACKEND_ROOT="${HOME_ROOT}/backends/hear"
SHIM_DIR="${HOME_ROOT}/bin"
REPO_SERVER="$(cd "$(dirname "$0")" && pwd)/lloom_hear_server.py"

mkdir -p "$BACKEND_ROOT" "$SHIM_DIR"
if [[ ! -d "$BACKEND_ROOT/venv" ]]; then
  python3 -m venv "$BACKEND_ROOT/venv"
fi
# shellcheck disable=SC1091
source "$BACKEND_ROOT/venv/bin/activate"
python -c 'import sys; assert sys.version_info >= (3, 11), "Hear requires Python 3.11 or newer"'
# librosa pulls numba; numba needs a writable cache dir or import fails.
python -m pip install -U \
  'fastapi==0.141.1' 'uvicorn==0.53.0' 'librosa==0.11.0' \
  'soundfile==0.14.0' 'numpy==2.4.6' 'matplotlib==3.11.2'
deactivate

mkdir -p "$BACKEND_ROOT/src"
cp -f "$REPO_SERVER" "$BACKEND_ROOT/src/lloom_hear_server.py"

# numba raises "cannot cache function ... no locator available" when its cache
# directory does not already exist, which breaks the librosa import outright.
mkdir -p "$BACKEND_ROOT/numba-cache"

cat > "$SHIM_DIR/lloom-hear-server" <<SH
#!/bin/sh
export NUMBA_CACHE_DIR="\${NUMBA_CACHE_DIR:-$BACKEND_ROOT/numba-cache}"
mkdir -p "\$NUMBA_CACHE_DIR"
exec "$BACKEND_ROOT/venv/bin/python" "$BACKEND_ROOT/src/lloom_hear_server.py" "\$@"
SH
chmod +x "$SHIM_DIR/lloom-hear-server"
echo "Installed lloom-hear-server -> $SHIM_DIR/lloom-hear-server"
