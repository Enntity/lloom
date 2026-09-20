"""Private, single-flight image-edit backend for LLooM."""
import asyncio
import base64
import binascii
import io
import json
import math
import os
import re
import threading
import time
import warnings
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser
from pipeline import GATEWAY_ID, MODEL_ID, GenerationCancelled, Runner

MAX_BODY = 16 * 1024 * 1024
MAX_IMAGE = 8 * 1024 * 1024
MAX_PIXELS = 16 * 1024 * 1024
ALLOWED = {"model", "prompt", "image", "seed", "steps", "cfg", "resolution", "n", "response_format"}
DATA_URI = re.compile(r"data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)", re.IGNORECASE)


class ApiError(Exception):
    def __init__(self, message, code="invalid_request", status=400):
        self.message, self.code, self.status = message, code, status


def parse_request(payload):
    if not isinstance(payload, dict):
        raise ApiError("Request body must be a JSON object")
    if set(payload) - ALLOWED:
        raise ApiError("Unsupported fields: " + ", ".join(sorted(set(payload) - ALLOWED)))
    if payload.get("model") not in (MODEL_ID, GATEWAY_ID):
        raise ApiError("Unsupported model", "unsupported_model", 404)
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8192:
        raise ApiError("prompt must contain 1 to 8192 characters")
    seed, steps = payload.get("seed", 42), payload.get("steps", 40)
    if type(seed) is not int or not 0 <= seed < 2**63:
        raise ApiError("seed must be an integer between 0 and 2^63-1")
    if type(steps) is not int or not 1 <= steps <= 60:
        raise ApiError("steps must be an integer between 1 and 60")
    for field, expected in (("cfg", 1), ("resolution", 1024), ("n", 1)):
        value = payload.get(field, expected)
        if type(value) not in (int, float) or value != expected:
            raise ApiError(f"{field} must be {expected}")
    if payload.get("response_format", "b64_json") != "b64_json":
        raise ApiError("Only response_format=b64_json is supported")
    encoded = payload.get("image")
    if not isinstance(encoded, str) or len(encoded) > MAX_IMAGE * 4 // 3 + 100:
        raise ApiError("One inline PNG/JPEG image, at most 8 MiB, is required")
    match = DATA_URI.fullmatch(encoded)
    if not match:
        raise ApiError("image must be a base64 PNG/JPEG data URI; URLs and paths are unsupported")
    try:
        data = base64.b64decode(match[2], validate=True)
        if len(data) > MAX_IMAGE:
            raise ApiError("Image exceeds 8 MiB")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as opened:
                if opened.format != {"png": "PNG", "jpeg": "JPEG"}[match[1].lower()]:
                    raise ApiError("Image bytes do not match the declared MIME type")
                w, h = opened.size
                if min(w, h) < 32 or max(w, h) > 4096 or w * h > MAX_PIXELS:
                    raise ApiError("Image dimensions must be 32..4096 with at most 16 MP")
                if getattr(opened, "n_frames", 1) != 1:
                    raise ApiError("Animated images are unsupported")
                opened.load()
                image = opened.convert("RGBA" if "A" in opened.getbands() or "transparency" in opened.info else "RGB")
    except (binascii.Error, ValueError, OSError, UnidentifiedImageError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ApiError("Invalid PNG/JPEG image") from exc
    width = round(math.sqrt(1024 * 1024 * w / h) / 32) * 32
    height = round(math.sqrt(1024 * 1024 * h / w) / 32) * 32
    if min(width, height) < 32 or max(width, height) > 2048:
        raise ApiError("Image aspect ratio would exceed the 2048-pixel output-axis limit")
    return {"prompt": prompt, "seed": seed, "steps": steps, "width": width, "height": height}, image


async def read_bytes(request):
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_BODY:
            raise ApiError("Request exceeds 16 MiB", "body_too_large", 413)
        body.extend(chunk)
    return bytes(body)


async def read_body(request):
    try:
        return json.loads(await read_bytes(request))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ApiError("Invalid JSON") from exc


async def read_multipart(request):
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "multipart/form-data":
        raise ApiError("Expected multipart/form-data")
    body = await read_bytes(request)

    async def stream():
        yield body

    try:
        form = await MultiPartParser(request.headers, stream(), max_files=1,
                                     max_fields=12, max_part_size=MAX_IMAGE).parse()
    except (MultiPartException, ValueError) as exc:
        raise ApiError("Invalid multipart form: " + str(exc)) from exc
    try:
        payload = {}
        for key, value in form.multi_items():
            key = "image" if key == "image[]" else key
            if key in payload:
                raise ApiError("Duplicate field: " + key)
            if isinstance(value, UploadFile):
                if key != "image":
                    raise ApiError("Only one image upload is supported")
                data = await value.read(MAX_IMAGE + 1)
                if len(data) > MAX_IMAGE:
                    raise ApiError("Image exceeds 8 MiB")
                mime = value.content_type
                if mime in (None, "application/octet-stream"):
                    mime = "image/png" if data.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg" if data.startswith(b"\xff\xd8\xff") else None
                if mime not in ("image/png", "image/jpeg"):
                    raise ApiError("Only PNG/JPEG uploads are supported")
                value = "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")
            elif key == "image":
                raise ApiError("image must be a file upload")
            elif key in ("seed", "steps", "resolution", "n", "cfg"):
                try:
                    value = float(value) if key == "cfg" else int(value)
                except ValueError as exc:
                    raise ApiError("Invalid numeric field: " + key) from exc
            payload[key] = value
        return parse_request(payload)
    finally:
        await form.close()


async def finish_worker(task):
    # Cancelling an asyncio waiter does not stop a CUDA worker. Retain ownership
    # until the thread actually exits, even if the HTTP task is cancelled again.
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            continue
        except Exception:
            break
    if not task.cancelled():
        task.exception()  # Retrieve exceptions even after a disconnected client.


async def run_edit(app, request, params, image):
    if app.state.lock.locked():
        image.close()
        raise ApiError("Image backend is busy", "backend_busy", 429)
    await app.state.lock.acquire()
    cancel = threading.Event()
    task = asyncio.create_task(asyncio.to_thread(app.state.runner.generate, params, image, cancel))
    try:
        while not task.done():
            if await request.is_disconnected():
                cancel.set()
                raise ApiError("Client disconnected", "cancelled", 499)
            await asyncio.sleep(0.1)
        return task.result()
    except asyncio.CancelledError:
        cancel.set()
        raise
    except GenerationCancelled as exc:
        raise ApiError("Generation cancelled", "cancelled", 499) from exc
    finally:
        if not task.done():
            cancel.set()
        await finish_worker(task)
        app.state.lock.release()
        image.close()


def create_app(runner_factory=None):
    factory = runner_factory or (lambda: Runner(os.environ.get("LLOOM_QWEN_MODEL_PATH", "/models/Qwen--Qwen-Image-2.1")))

    @asynccontextmanager
    async def lifespan(app):
        app.state.runner = await asyncio.to_thread(factory)
        app.state.ready = True
        yield
        app.state.ready = False

    app = FastAPI(lifespan=lifespan)
    app.state.ready = False
    app.state.lock = asyncio.Lock()

    @app.exception_handler(ApiError)
    async def handle_error(request, exc):
        headers = {"Retry-After": "1"} if exc.status == 429 else None
        return JSONResponse({"error": {"message": exc.message, "type": "invalid_request_error", "code": exc.code}}, status_code=exc.status, headers=headers)

    @app.get("/health")
    async def health():
        return JSONResponse({"status": "ok" if app.state.ready else "loading"}, status_code=200 if app.state.ready else 503)

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "created": 0, "owned_by": "Qwen", "capabilities": ["image-editing"]}]}

    @app.post("/v1/images/generations")
    async def generate(request: Request):
        if not app.state.ready:
            raise ApiError("Model is loading", "model_loading", 503)
        params, image = parse_request(await read_body(request))
        png = await run_edit(app, request, params, image)
        return {"created": int(time.time()), "data": [{"b64_json": base64.b64encode(png).decode("ascii")}]}

    @app.post("/v1/images/edits")
    async def edit(request: Request):
        if not app.state.ready:
            raise ApiError("Model is loading", "model_loading", 503)
        params, image = await read_multipart(request)
        png = await run_edit(app, request, params, image)
        return {"created": int(time.time()), "data": [{"b64_json": base64.b64encode(png).decode("ascii")}]}

    return app


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(create_app(), host="0.0.0.0", port=8000)
