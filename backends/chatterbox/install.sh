#!/usr/bin/env bash
# Install Chatterbox into a LLooM-managed backend venv and expose the server shim.
set -euo pipefail

HOME_ROOT="${LLOOM_HOME:-$HOME/.lloom}"
BACKEND_ROOT="${HOME_ROOT}/backends/chatterbox"
SHIM_DIR="${HOME_ROOT}/bin"
REPO_SERVER="$(cd "$(dirname "$0")" && pwd)/lloom_chatterbox_server.py"

pick_python() {
  if [[ -n "${LLOOM_CHATTERBOX_PYTHON:-}" && -x "${LLOOM_CHATTERBOX_PYTHON}" ]]; then
    printf '%s\n' "${LLOOM_CHATTERBOX_PYTHON}"
    return
  fi
  local candidate
  for candidate in \
    /opt/homebrew/opt/python@3.11/bin/python3.11 \
    /usr/local/opt/python@3.11/bin/python3.11 \
    python3.11 \
    python3; do
    if command -v "$candidate" >/dev/null 2>&1 || [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  echo "No Python 3.11+ interpreter found for Chatterbox." >&2
  exit 1
}

PYTHON_BIN="$(pick_python)"
mkdir -p "$BACKEND_ROOT" "$SHIM_DIR"
if [[ ! -d "$BACKEND_ROOT/venv" ]]; then
  "$PYTHON_BIN" -m venv "$BACKEND_ROOT/venv"
fi
# shellcheck disable=SC1091
source "$BACKEND_ROOT/venv/bin/activate"
python -m pip install -U pip wheel
python -m pip install -U 'chatterbox-tts>=0.1.6' soundfile fastapi 'uvicorn[standard]' numpy
deactivate

mkdir -p "$BACKEND_ROOT/src"
cp -f "$REPO_SERVER" "$BACKEND_ROOT/src/lloom_chatterbox_server.py"

cat > "$SHIM_DIR/lloom-chatterbox-server" <<SH
#!/bin/sh
exec "$BACKEND_ROOT/venv/bin/python" "$BACKEND_ROOT/src/lloom_chatterbox_server.py" "\$@"
SH
chmod +x "$SHIM_DIR/lloom-chatterbox-server"
echo "Installed lloom-chatterbox-server -> $SHIM_DIR/lloom-chatterbox-server (python=$PYTHON_BIN)"
