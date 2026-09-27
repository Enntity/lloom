"""Keep the loopback ComfyUI engine and the LLooM bridge in one lifecycle."""
import os
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import model_paths  # noqa: E402

# Each container serves exactly one model, whose files the recipe bind-mounts
# read-only into ComfyUI's model tree. There is no shared multi-model runtime.
if not os.environ.get("LLOOM_MEDIA_MODEL", "").strip():
    raise SystemExit("LLOOM_MEDIA_MODEL is required: each media runtime serves exactly one model")
HOST_MODELS_ROOT = os.environ.get("LLOOM_MODELS_ROOT", "/opt/ComfyUI/models")
EXTRA_PATHS_FILE = "/data/extra_model_paths.yaml"
CACHE_MODE = os.environ.get("LLOOM_COMFY_CACHE_MODE", "none")
if CACHE_MODE not in ("none", "classic"):
    raise SystemExit("LLOOM_COMFY_CACHE_MODE must be none or classic")

children = []
stopping = False


def stop(signum=None, frame=None):
    global stopping
    stopping = True
    for child in children:
        if child.poll() is None:
            child.terminate()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
for directory in ("input", "output", "temp"):
    os.makedirs("/data/" + directory, exist_ok=True)
try:
    roots = model_paths.write_extra_model_paths(HOST_MODELS_ROOT, EXTRA_PATHS_FILE, manifest="/opt/lloom-media/model-roots.json")
    print(f"[launch] extra model roots: {[name for name, _, _ in roots]}", flush=True)
except OSError as error:
    roots = []
    print(f"[launch] extra model roots unavailable: {error}", flush=True)
comfy_args = [
    sys.executable, "/opt/ComfyUI/main.py", "--listen", "127.0.0.1",
    "--port", "8188", "--disable-auto-launch", "--disable-api-nodes", "--disable-all-custom-nodes",
    "--cache-" + CACHE_MODE, "--reserve-vram", "18", "--log-stdout",
    "--input-directory", "/data/input", "--output-directory", "/data/output",
    "--temp-directory", "/data/temp",
]
if roots:
    comfy_args += ["--extra-model-paths-config", EXTRA_PATHS_FILE]
children.append(subprocess.Popen(comfy_args, cwd="/opt/ComfyUI"))

children.append(subprocess.Popen([
    sys.executable, "/opt/lloom-media/bridge/server.py",
    "--host", "0.0.0.0", "--port", "8000",
], cwd="/opt/lloom-media/bridge"))
while not stopping and all(child.poll() is None for child in children):
    time.sleep(1)
unexpected = not stopping
stop()
deadline = time.monotonic() + 20
for child in children:
    try:
        child.wait(timeout=max(0.1, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
sys.exit(1 if unexpected else 0)
