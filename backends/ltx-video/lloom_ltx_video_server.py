#!/usr/bin/env python3
"""Small OpenAI-shaped HTTP wrapper around official LTX-2.3 pipelines."""

import base64
import json
import os
import subprocess
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


MODEL_ID = os.environ.get("LTX_MODEL_ID", "Lightricks/LTX-2.3-DR34ML4Y")
PIPELINE = os.environ.get("LTX_PIPELINE", "distilled")
CHECKPOINT = os.environ.get("LTX_CHECKPOINT", "/models/ltx-2.3-22b-distilled-1.1.safetensors")
UPSCALER = os.environ.get("LTX_UPSCALER", "/models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors")
GEMMA_ROOT = os.environ.get("LTX_GEMMA_ROOT", "/models/gemma-3-12b")
LORA = os.environ.get("LTX_LORA", "/models/DR34ML4Y_LT3X_V3.safetensors")
DISTILLED_LORA = os.environ.get(
    "LTX_DISTILLED_LORA", "/models/ltx-2.3-22b-distilled-lora-384-1.1.safetensors"
)
DEFAULT_LORA_STRENGTH = float(os.environ.get("LTX_LORA_STRENGTH", "0.7"))
DEFAULT_DISTILLED_LORA_STRENGTH = float(os.environ.get("LTX_DISTILLED_LORA_STRENGTH", "0.3"))
DEFAULT_INFERENCE_STEPS = int(os.environ.get("LTX_NUM_INFERENCE_STEPS", "30"))
DEFAULT_VIDEO_CFG = float(os.environ.get("LTX_VIDEO_CFG_GUIDANCE_SCALE", "3.0"))
DEFAULT_QUANTIZATION = os.environ.get("LTX_QUANTIZATION", "fp8-cast")
DEFAULT_OFFLOAD = os.environ.get("LTX_OFFLOAD", "none")
MAX_BODY_BYTES = 2 * 1024 * 1024


def error(message, code="bad_request"):
    return {"error": {"message": message, "type": "invalid_request_error", "code": code}}


def validate_int(body, key, default, minimum, maximum, multiple=None):
    value = int(body.get(key, default))
    if value < minimum or value > maximum or (multiple and value % multiple):
        suffix = f" and divisible by {multiple}" if multiple else ""
        raise ValueError(f"{key} must be between {minimum} and {maximum}{suffix}")
    return value


class Handler(BaseHTTPRequestHandler):
    server_version = "lloom-ltx-video/1"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def send_json(self, status, payload):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def begin_long_response(self):
        """Send headers before long inference so proxies do not time out waiting."""
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("connection", "close")
        self.end_headers()
        self.wfile.flush()

    def write_long_response(self, payload):
        self.wfile.write(json.dumps(payload).encode("utf-8"))
        self.wfile.flush()
        self.close_connection = True

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"ok": True, "model": MODEL_ID})
            return
        if self.path == "/v1/models":
            self.send_json(200, {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "lloom"}]})
            return
        self.send_json(404, error("not found", "not_found"))

    def do_POST(self):
        if self.path != "/v1/videos/generations":
            self.send_json(404, error("not found", "not_found"))
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > MAX_BODY_BYTES:
                raise ValueError("request body is empty or too large")
            body = json.loads(self.rfile.read(length))
            prompt = str(body.get("prompt", "")).strip()
            if not prompt:
                raise ValueError("prompt is required")
            width = validate_int(body, "width", 768, 256, 1920, 64)
            height = validate_int(body, "height", 512, 256, 1920, 64)
            num_frames = validate_int(body, "num_frames", 97, 9, 257)
            if (num_frames - 1) % 8:
                raise ValueError("num_frames must equal 8*K+1")
            frame_rate = float(body.get("frame_rate", 24.0))
            if frame_rate <= 0 or frame_rate > 60:
                raise ValueError("frame_rate must be between 0 and 60")
            seed = int(body.get("seed", 42))
            lora_strength = float(body.get("lora_strength", DEFAULT_LORA_STRENGTH))
            if not 0 <= lora_strength <= 2:
                raise ValueError("lora_strength must be between 0 and 2")
            response_format = body.get("response_format", "b64_json")
            if response_format != "b64_json":
                raise ValueError("only response_format=b64_json is currently supported")
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self.send_json(400, error(str(exc)))
            return

        self.begin_long_response()
        started = time.time()
        with tempfile.TemporaryDirectory(prefix="lloom-ltx-") as temp_dir:
            output = Path(temp_dir) / "output.mp4"
            common = [
                "--spatial-upsampler-path", UPSCALER,
                "--gemma-root", GEMMA_ROOT,
                "--lora", LORA, str(lora_strength),
                "--prompt", prompt,
                "--output-path", str(output),
                "--width", str(width),
                "--height", str(height),
                "--num-frames", str(num_frames),
                "--frame-rate", str(frame_rate),
                "--seed", str(seed),
            ]
            if PIPELINE == "two-stage":
                distilled_lora_strength = float(
                    body.get("distilled_lora_strength", DEFAULT_DISTILLED_LORA_STRENGTH)
                )
                if not 0 <= distilled_lora_strength <= 1:
                    self.write_long_response(error("distilled_lora_strength must be between 0 and 1"))
                    return
                inference_steps = int(body.get("num_inference_steps", DEFAULT_INFERENCE_STEPS))
                video_cfg = float(body.get("video_cfg_guidance_scale", DEFAULT_VIDEO_CFG))
                command = [
                    "python3", "-m", "ltx_pipelines.ti2vid_two_stages",
                    "--checkpoint-path", CHECKPOINT,
                    "--distilled-lora", DISTILLED_LORA, str(distilled_lora_strength),
                    "--num-inference-steps", str(inference_steps),
                    "--video-cfg-guidance-scale", str(video_cfg),
                    *common,
                ]
            else:
                distilled_lora_strength = None
                inference_steps = None
                video_cfg = None
                command = [
                    "python3", "-m", "ltx_pipelines.distilled",
                    "--distilled-checkpoint-path", CHECKPOINT,
                    *common,
                ]
            quantization = str(body.get("quantization", DEFAULT_QUANTIZATION)).strip()
            offload = str(body.get("offload", DEFAULT_OFFLOAD)).strip()
            if quantization and quantization != "none":
                command.extend(["--quantization", quantization])
            if offload and offload != "none":
                command.extend(["--offload", offload])
            if body.get("enhance_prompt") is True:
                command.append("--enhance-prompt")
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 3600
            while True:
                try:
                    stdout, stderr = process.communicate(timeout=30)
                    break
                except subprocess.TimeoutExpired:
                    if time.monotonic() >= deadline:
                        process.kill()
                        process.communicate()
                        self.write_long_response(error("video generation timed out", "generation_timeout"))
                        return
                    self.wfile.write(b" ")
                    self.wfile.flush()
            completed = subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
            if completed.returncode != 0 or not output.is_file():
                detail = (completed.stderr or completed.stdout or "generation failed")[-8000:]
                print(detail, flush=True)
                self.write_long_response(error(detail, "generation_failed"))
                return
            encoded = base64.b64encode(output.read_bytes()).decode("ascii")
            self.write_long_response({
                "created": int(time.time()),
                "model": MODEL_ID,
                "data": [{"b64_json": encoded}],
                "metadata": {
                    "width": width,
                    "height": height,
                    "num_frames": num_frames,
                    "frame_rate": frame_rate,
                    "seed": seed,
                    "lora": Path(LORA).name,
                    "lora_strength": lora_strength,
                    "pipeline": PIPELINE,
                    "distilled_lora_strength": distilled_lora_strength,
                    "num_inference_steps": inference_steps,
                    "video_cfg_guidance_scale": video_cfg,
                    "generation_seconds": round(time.time() - started, 3),
                },
            })


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    print(f"LLooM LTX video server listening on http://{host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
