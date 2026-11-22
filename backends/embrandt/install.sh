#!/usr/bin/env bash
# Build Embrandt (Qwen3-Embedding-4B on the Radeon 680M through Vulkan) at a pinned commit,
# fetch the pinned Q8_0 GGUF and expose the LLooM embeddings server shim.
set -euo pipefail

HOME_ROOT="${LLOOM_HOME:-$HOME/.lloom}"
BACKEND_ROOT="${LLOOM_EMBRANDT_HOME:-$HOME_ROOT/backends/embrandt}"
SHIM_DIR="$HOME_ROOT/bin"

RECIPE_REPOSITORY=https://github.com/Enntity/embrandt
RECIPE_COMMIT=0cf190be8e538597e8487a0b3e90ee9163d7820c
MODEL_FILE=Qwen3-Embedding-4B-Q8_0.gguf
MODEL_URL=https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF/resolve/f4602530db1d980e16da9d7d3a70294cf5c190be/$MODEL_FILE
MODEL_SHA256=b60ae5ce2dd6a0b77f82cadf21def1f310a3e10cde380ad0081b07a9d416949d

[[ "$(uname -sm)" == "Linux x86_64" ]] || { echo "embrandt: Linux x86_64 with a Radeon 680M only" >&2; exit 1; }
for tool in git cmake ninja g++ glslc python3 curl sha256sum; do
  command -v "$tool" >/dev/null || { echo "embrandt: $tool not found on PATH" >&2; exit 1; }
done
mkdir -p "$BACKEND_ROOT" "$SHIM_DIR"
cd "$BACKEND_ROOT"

[[ -d src/.git ]] || git clone -q "$RECIPE_REPOSITORY" src
git -C src fetch -q origin "$RECIPE_COMMIT"
git -C src checkout -q --detach "$RECIPE_COMMIT"
src/build.sh

model_ok() { [[ -f "$MODEL_FILE" ]] && echo "$MODEL_SHA256  $MODEL_FILE" | sha256sum -c --status -; }
if ! model_ok; then
  curl -fL -C - -o "$MODEL_FILE" "$MODEL_URL"
  model_ok || { echo "embrandt: $MODEL_FILE does not match its pinned SHA-256" >&2; exit 1; }
fi

# A Mesa outside the system paths is found through VK_DRIVER_FILES and, for its libraries,
# EMBRANDT_VULKAN_LIBRARY_PATH. The shim keeps the ones this install ran with, so the gateway
# starts the service against the same driver.
{
  cat <<'SH'
#!/bin/sh
# A gateway whose login session predates its user joining the render group cannot open the GPU.
# sg applies the membership. It also clears LD_LIBRARY_PATH, so the driver paths are set after it.
if [ -z "${EMBRANDT_SG:-}" ] && ! id -Gn | grep -qw render && id -Gn "$(id -un)" | grep -qw render; then
  exec sg render -c "EMBRANDT_SG=1 exec \"$0\" $*"
fi
SH
  [[ -z "${VK_DRIVER_FILES:-}" ]] || echo "export VK_DRIVER_FILES='$VK_DRIVER_FILES'"
  [[ -z "${EMBRANDT_VULKAN_LIBRARY_PATH:-}" ]] || echo "export LD_LIBRARY_PATH='$EMBRANDT_VULKAN_LIBRARY_PATH'"
  echo "export EMBRANDT_MODEL='$BACKEND_ROOT/$MODEL_FILE'"
  echo "exec python3 '$BACKEND_ROOT/src/service.py' \"\$@\""
} > "$SHIM_DIR/lloom-embrandt"
chmod +x "$SHIM_DIR/lloom-embrandt"
echo "Installed lloom-embrandt -> $SHIM_DIR/lloom-embrandt"
