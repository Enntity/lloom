#!/usr/bin/env bash
# Install mlx-audio into the LLooM-managed backend venv and expose shims.
set -euo pipefail
HOME_ROOT="${LLOOM_HOME:-$HOME/.lloom}"
BACKEND_ROOT="${HOME_ROOT}/backends/mlx-audio"
SHIM_DIR="${HOME_ROOT}/bin"
REPO_SERVER="$(cd "$(dirname "$0")" && pwd)/lloom_audio_server.py"

mkdir -p "$BACKEND_ROOT" "$SHIM_DIR"
if [[ ! -d "$BACKEND_ROOT/venv" ]]; then
  python3 -m venv "$BACKEND_ROOT/venv"
fi
# shellcheck disable=SC1091
source "$BACKEND_ROOT/venv/bin/activate"
python -m pip install -U pip wheel
python -m pip install -U 'mlx-audio[server]' soundfile webrtcvad-wheels
deactivate

mkdir -p "$BACKEND_ROOT/src"
cp -f "$REPO_SERVER" "$BACKEND_ROOT/src/lloom_audio_server.py"

cat > "$SHIM_DIR/lloom-audio-server" <<SH
#!/bin/sh
exec "$BACKEND_ROOT/venv/bin/python" "$BACKEND_ROOT/src/lloom_audio_server.py" "\$@"
SH
chmod +x "$SHIM_DIR/lloom-audio-server"
echo "Installed lloom-audio-server -> $SHIM_DIR/lloom-audio-server"
