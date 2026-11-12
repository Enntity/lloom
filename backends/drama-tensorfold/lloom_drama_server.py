#!/usr/bin/env python3
"""LLooM speech server for Fish Audio Drama 3 on the TensorFold engine (DGX Spark).

The engine speaks OpenAI-style /v1/audio/speech but takes a cloned voice as codec codes, never as
audio. LLooM sends a voice profile as `ref_audio` (a data URL) plus `ref_text`. This server encodes
each new reference once with the engine's own encoder, keeps the codes on disk, and forwards the
request with those codes inline. Standard library only.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ENGINE_MODEL = "fishaudio/drama-3"
MAX_BODY_BYTES = 32 * 1024 * 1024
FORWARDED = ("stream", "temperature", "top_p", "top_k", "seed")
PASSED_HEADERS = ("Content-Type", "Content-Length", "X-Cfg-Gamma", "X-Controls-Stripped")
_encode_lock = threading.Lock()


class BadRequest(ValueError):
    pass


def decode_reference(value) -> bytes:
    """Reference audio arrives as bytes in a base64 data URL; a path or URL is never read."""
    if not isinstance(value, str) or not value.startswith("data:") or ";base64," not in value:
        raise BadRequest("ref_audio must be a base64 data URL")
    try:
        audio = base64.b64decode(value.split(";base64,", 1)[1], validate=True)
    except (binascii.Error, ValueError) as error:
        raise BadRequest("ref_audio is not valid base64") from error
    if not audio:
        raise BadRequest("ref_audio is empty")
    return audio


def reference_for(ref_audio, ref_text, cache_dir: Path, encode) -> dict:
    """The engine reference for a clip and its transcript, encoded on first use."""
    audio = decode_reference(ref_audio)
    text = str(ref_text or "").strip()
    if not text:
        raise BadRequest("ref_text (the reference clip's exact words) is required with ref_audio")
    key = hashlib.sha256(hashlib.sha256(audio).digest() + text.encode()).hexdigest()
    cached = cache_dir / f"{key}.json"
    with _encode_lock:
        if not cached.exists():
            cache_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=cache_dir) as work:
                clip, out = Path(work, "clip.wav"), Path(work, "reference.json")  # the encoder wants NAME.json
                clip.write_bytes(audio)
                encode(clip, text, out)
                os.replace(out, cached)
        voice = json.loads(cached.read_text())
    return {"text": voice["text"], "vq_codes": voice["vq_codes"]}


def engine_body(body: dict, reference: dict | None) -> dict:
    """Keep what the engine accepts; it refuses every other field."""
    text = body.get("input")
    if not isinstance(text, str) or not text.strip():
        raise BadRequest("input is required")
    response_format = body.get("response_format") or "wav"
    if response_format not in ("wav", "pcm"):
        raise BadRequest("response_format must be wav or pcm")
    out = {"model": ENGINE_MODEL, "input": text, "response_format": response_format}
    out.update({key: body[key] for key in FORWARDED if body.get(key) is not None})
    if reference:
        out["references"] = [reference]
    return out


def make_server(host: str, port: int, engine_url: str, cache_dir: Path, encode) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path != "/health":
                return self._json(404, {"error": "not found"})
            self._relay(urllib.request.Request(engine_url + "/health"), timeout=5)

        def do_POST(self):
            if self.path != "/v1/audio/speech":
                return self._json(404, {"error": "not found"})
            try:
                length = int(self.headers.get("Content-Length") or 0)
                if not 0 < length <= MAX_BODY_BYTES:
                    raise BadRequest("request body must be between 1 byte and 32 MiB")
                body = json.loads(self.rfile.read(length))
                if not isinstance(body, dict):
                    raise BadRequest("request body must be a JSON object")
                ref_audio = body.get("ref_audio") or body.get("audio_prompt_path")
                reference = reference_for(ref_audio, body.get("ref_text"), cache_dir, encode) if ref_audio else None
                payload = json.dumps(engine_body(body, reference)).encode()
            except (BadRequest, json.JSONDecodeError) as error:
                return self._json(400, {"error": {"message": str(error), "type": "invalid_request_error"}})
            except (OSError, subprocess.SubprocessError, KeyError) as error:
                return self._json(502, {"error": {"message": f"reference encode failed: {error}"}})
            self._relay(urllib.request.Request(engine_url + "/v1/audio/speech", payload,
                                               {"Content-Type": "application/json"}), timeout=1800)

        def _relay(self, request, timeout):
            try:
                response = urllib.request.urlopen(request, timeout=timeout)
            except urllib.error.HTTPError as error:
                response = error
            except OSError as error:
                return self._json(503, {"error": {"message": f"engine unavailable: {error}"}})
            with response:
                self.send_response(response.status)
                for name in PASSED_HEADERS:
                    if response.headers.get(name):
                        self.send_header(name, response.headers[name])
                self.end_headers()
                try:
                    while chunk := response.read1(65536):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except OSError:
                    pass  # the client left; closing the engine response cancels the take

        def _json(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return ThreadingHTTPServer((host, port), Handler)


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    home = Path(os.environ.get("LLOOM_DRAMA_HOME") or Path.home() / ".lloom/backends/drama-tensorfold")
    source = home / "src"
    weights = os.environ.get("LLOOM_DRAMA_WEIGHTS", "nvfp4")
    checkpoint = source / {"nvfp4": "drama-3-NVFP4-Pruned", "nvfp4-5900": "drama-3-NVFP4-Pruned-5900"}[weights]
    native = source / "build/tensorfold-nvfp4/zig-out/native/bin/tensorfold-native"
    for name in ("runtime", "runs"):
        (home / name).mkdir(parents=True, exist_ok=True)
    (home / "gpu.lock").touch()

    def encode(audio_path, text, out_path):
        subprocess.run([str(native), "voice", "encode", str(audio_path), "--model", str(checkpoint),
                        "--text", text, "--name", "reference", "--out", str(out_path)],
                       check=True, capture_output=True, timeout=120)

    # LLooM admits the load against its own memory budget, so the launcher's free-memory gate is off;
    # its cgroup cap, checkpoint verification and GPU lock stay.
    engine_port = free_port()
    engine = subprocess.Popen(
        [sys.executable, str(source / "recipe/pilot.py"), "--weights", weights,
         "--runtime-dir", str(home / "runtime"), "--gpu-lock", str(home / "gpu.lock"),
         "--evidence-dir", str(home / "runs" / time.strftime("%Y%m%dT%H%M%S")),
         "--port", str(engine_port), "--external-admission", "--parent-pid", str(os.getpid()),
         "--reserve-gib", os.environ.get("LLOOM_DRAMA_RESERVE_GIB", "8"), "--",
         *shlex.split(os.environ.get("LLOOM_DRAMA_SERVE_ARGS", "--max-frames 2048"))],
        cwd=source)

    server = make_server(args.host, args.port, f"http://127.0.0.1:{engine_port}", home / "voice-cache", encode)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown).start())
    threading.Thread(target=lambda: (engine.wait(), server.shutdown()), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if engine.poll() is None:
            engine.terminate()
        engine.wait()
    return engine.returncode or 0


if __name__ == "__main__":
    raise SystemExit(main())
