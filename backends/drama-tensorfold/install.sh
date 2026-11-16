#!/usr/bin/env bash
# Build the pinned Drama 3 TensorFold engine for DGX Spark and expose the LLooM speech server shim.
set -euo pipefail

HOME_ROOT="${LLOOM_HOME:-$HOME/.lloom}"
BACKEND_ROOT="${LLOOM_DRAMA_HOME:-$HOME_ROOT/backends/drama-tensorfold}"
SHIM_DIR="$HOME_ROOT/bin"
HERE="$(cd "$(dirname "$0")" && pwd)"

RECIPE_REPOSITORY=https://github.com/plotarmordev/drama-tensorfold
RECIPE_COMMIT=3786fd16eae932a96ee5ef92c57994aff78dcfc7
ZIG_URL=https://ziglang.org/download/0.17.0/zig-aarch64-linux-0.17.0.tar.xz
ZIG_SHA256=9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8
WEIGHTS_REPOSITORY=plotarmordev/drama-3-NVFP4-Pruned
WEIGHTS_REVISION=494db08481db952f834b2241bce63fb3dfa72554
NVCC="${NVCC:-/usr/local/cuda/bin/nvcc}"

[[ "$(uname -sm)" == "Linux aarch64" ]] || { echo "drama-tensorfold: Linux arm64 (DGX Spark) only" >&2; exit 1; }
[[ -x "$NVCC" ]] || { echo "drama-tensorfold: CUDA 13 nvcc not found at $NVCC (set NVCC)" >&2; exit 1; }
mkdir -p "$BACKEND_ROOT" "$SHIM_DIR"
cd "$BACKEND_ROOT"

if [[ ! -x zig/zig ]]; then
  curl -fsSL -o zig.tar.xz "$ZIG_URL"
  echo "$ZIG_SHA256  zig.tar.xz" | sha256sum -c -
  mkdir -p zig && tar -xJf zig.tar.xz -C zig --strip-components=1 && rm zig.tar.xz
fi

[[ -d src/.git ]] || git clone -q "$RECIPE_REPOSITORY" src
git -C src fetch -q origin "$RECIPE_COMMIT"
git -C src checkout -q --detach "$RECIPE_COMMIT"
ZIG="$BACKEND_ROOT/zig/zig" NVCC="$NVCC" src/scripts/build-engine.sh --weights nvfp4

# The launcher verifies every weight file against its pinned checksums at each start.
if [[ ! -d src/drama-3-NVFP4-Pruned ]]; then
  [[ -d venv ]] || python3 -m venv venv
  venv/bin/pip install -q -U 'huggingface_hub[cli]'
  venv/bin/hf download "$WEIGHTS_REPOSITORY" --revision "$WEIGHTS_REVISION" --local-dir src/drama-3-NVFP4-Pruned
fi

cp -f "$HERE/lloom_drama_server.py" "$BACKEND_ROOT/lloom_drama_server.py"
cat > "$SHIM_DIR/lloom-drama-server" <<SH
#!/bin/sh
exec python3 "$BACKEND_ROOT/lloom_drama_server.py" "\$@"
SH
chmod +x "$SHIM_DIR/lloom-drama-server"
echo "Installed lloom-drama-server -> $SHIM_DIR/lloom-drama-server"
