"""Private, single-flight image generation/editing backend for LLooM.

Seed policy: an omitted seed is a *fresh cryptographic* 53-bit seed per request
(``secrets.randbits``), never a fixed 42. A fixed omitted-seed value silently
replayed the same sampler noise across sequential edits and corrupted the
quality of follow-on edits. Callers that need reproducible output must pass an
explicit seed, which is honored exactly and never perturbed. Callers performing
sequential edits should send fresh seeds.

This server never logs image payloads.
"""
import asyncio
import base64
import binascii
import io
import json
import math
import os
import re
import secrets
import threading
import time
import warnings
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser
from pipeline import GATEWAY_ID, MODEL_ID, GenerationCancelled, Runner

MAX_BODY = 64 * 1024 * 1024
MAX_IMAGE = 8 * 1024 * 1024
MAX_IMAGES = 10
MAX_PIXELS = 16 * 1024 * 1024
MIN_AXIS = 256
MAX_AXIS = 2048
MAX_NATIVE_AXIS = 3072
AXIS_MULTIPLE = 32
MAX_OUTPUT_PIXELS = int(4.5 * 1024 * 1024)
DEFAULT_RESOLUTION = 1024
QUALITY_STEPS = {"high": 40, "medium": 25, "low": 12}
DEFAULT_QUALITY = "high"
SCALAR_FIELDS = ("seed", "steps", "resolution", "n", "cfg")
ALLOWED = {
    "model", "prompt", "image", "seed", "steps", "cfg", "resolution", "n",
    "response_format", "size", "quality",
}
DATA_URI = re.compile(r"data:image/(png|jpeg);base64,([A-Za-z0-9+/=]+)", re.IGNORECASE)
SIZE = re.compile(r"([0-9]{1,4})x([0-9]{1,4})")


class ApiError(Exception):
    def __init__(self, message, code="invalid_request", status=400):
        self.message, self.code, self.status = message, code, status


def _fresh_seed():
    return secrets.randbits(53)


def _check_common(payload):
    if not isinstance(payload, dict):
        raise ApiError("Request body must be a JSON object")
    if set(payload) - ALLOWED:
        raise ApiError("Unsupported fields: " + ", ".join(sorted(set(payload) - ALLOWED)))
    if payload.get("model") not in (MODEL_ID, GATEWAY_ID):
        raise ApiError("Unsupported model", "unsupported_model", 404)
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8192:
        raise ApiError("prompt must contain 1 to 8192 characters")
    # An omitted seed is fresh random entropy, never a replayed constant. An
    # explicit seed is honored exactly and never perturbed.
    seed = payload["seed"] if "seed" in payload else _fresh_seed()
    if type(seed) is not int or not 0 <= seed < 2**53:
        raise ApiError("seed must be an integer between 0 and 2^53-1")
    return prompt, seed


def _check_steps(payload, default):
    steps = payload.get("steps", default)
    if type(steps) is not int or not 1 <= steps <= 60:
        raise ApiError("steps must be an integer between 1 and 60")
    return steps


def _resolve_quality_steps(payload):
    """Return (quality, steps). Explicit ``steps`` overrides the preset."""
    requested = payload.get("quality")
    if "quality" in payload:
        if not isinstance(requested, str) or requested not in ("auto",) + tuple(QUALITY_STEPS):
            raise ApiError("quality must be one of auto, high, medium, low")
        quality = DEFAULT_QUALITY if requested == "auto" else requested
    else:
        quality = DEFAULT_QUALITY
    if "steps" in payload:
        return quality, _check_steps(payload, None)
    return quality, QUALITY_STEPS[quality]


def _check_fixed(payload):
    for field, expected in (("cfg", 1), ("n", 1)):
        value = payload.get(field, expected)
        if type(value) not in (int, float) or value != expected:
            raise ApiError(f"{field} must be {expected}")
    if payload.get("response_format", "b64_json") != "b64_json":
        raise ApiError("Only response_format=b64_json is supported")


def _validate_geometry(width, height):
    for axis, value in (("width", width), ("height", height)):
        if type(value) is not int or not MIN_AXIS <= value <= MAX_NATIVE_AXIS:
            raise ApiError(f"size {axis} must be between {MIN_AXIS} and {MAX_NATIVE_AXIS}")
        if value % AXIS_MULTIPLE:
            raise ApiError(f"size {axis} must be a multiple of {AXIS_MULTIPLE}")
    if width * height > MAX_OUTPUT_PIXELS:
        raise ApiError("size must be at most 4.5 megapixels")


def parse_resolution(payload):
    resolution = payload.get("resolution", DEFAULT_RESOLUTION)
    if type(resolution) is not int or not MIN_AXIS <= resolution <= MAX_AXIS or resolution % AXIS_MULTIPLE:
        raise ApiError(
            f"resolution must be an integer between {MIN_AXIS} and {MAX_AXIS} and a multiple of {AXIS_MULTIPLE}"
        )
    return resolution


def parse_size(payload, default=None):
    """Validate an explicit ``size``, or derive a square from ``resolution``.

    ``resolution`` is a square budget (256..2048, multiple of 32). An explicit
    ``size`` may use native 2K aspect sizes up to 3072 on the long axis. A
    validated request size is passed to the model unchanged.
    """
    resolution = parse_resolution(payload)
    size = payload.get("size")
    if size is None:
        width = height = resolution
    else:
        if not isinstance(size, str):
            raise ApiError("size must be WIDTHxHEIGHT such as 1024x1024")
        match = SIZE.fullmatch(size)
        if not match:
            raise ApiError("size must be WIDTHxHEIGHT such as 1024x1024")
        width, height = int(match[1]), int(match[2])
    _validate_geometry(width, height)
    return width, height, resolution


def _derive_edit_size(reference, resolution):
    """Output size for a reference: follow its aspect ratio at ``resolution``."""
    w, h = reference.size
    if min(w, h) < 1:
        raise ApiError("Reference image has invalid dimensions")
    width = round(math.sqrt(resolution * resolution * w / h) / AXIS_MULTIPLE) * AXIS_MULTIPLE
    height = round(math.sqrt(resolution * resolution * h / w) / AXIS_MULTIPLE) * AXIS_MULTIPLE
    width = max(width, AXIS_MULTIPLE)
    height = max(height, AXIS_MULTIPLE)
    if width * height > MAX_OUTPUT_PIXELS:
        scale = math.sqrt(MAX_OUTPUT_PIXELS / (width * height))
        width = max(AXIS_MULTIPLE, int(width * scale) // AXIS_MULTIPLE * AXIS_MULTIPLE)
        height = max(AXIS_MULTIPLE, int(height * scale) // AXIS_MULTIPLE * AXIS_MULTIPLE)
    _validate_geometry(width, height)
    return width, height


def _decode_data_uri(encoded):
    if not isinstance(encoded, str) or len(encoded) > MAX_IMAGE * 4 // 3 + 100:
        raise ApiError("Inline PNG/JPEG images must be at most 8 MiB each")
    match = DATA_URI.fullmatch(encoded)
    if not match:
        raise ApiError("images must be base64 PNG/JPEG data URIs; remote URLs and file paths are unsupported")
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
                # EXIF transpose first so decoded pixels match visual order.
                opened = ImageOps.exif_transpose(opened)
                image = opened.convert(
                    "RGBA" if "A" in opened.getbands() or "transparency" in opened.info else "RGB"
                )
    except (binascii.Error, ValueError, OSError, UnidentifiedImageError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        if isinstance(exc, ApiError):
            raise
        raise ApiError("Invalid PNG/JPEG image") from exc
    return image


def decode_images(payload):
    """Decode ordered 1..10 JSON references: a single data URI or a list."""
    encoded = payload.get("image")
    if isinstance(encoded, str):
        raw = [encoded]
    elif isinstance(encoded, list):
        raw = encoded
    else:
        raise ApiError("image must be a base64 PNG/JPEG data URI or a list of data URIs")
    if not 1 <= len(raw) <= MAX_IMAGES:
        raise ApiError(f"a request accepts between 1 and {MAX_IMAGES} reference images")
    images = []
    try:
        for item in raw:
            images.append(_decode_data_uri(item))
    except BaseException:
        for image in images:
            image.close()
        raise
    return images


def decode_image(payload):
    """Single-reference JSON decode, kept for existing callers."""
    images = decode_images(payload)
    if len(images) != 1:
        close_images(images)
        raise ApiError("decode_image accepts exactly one reference")
    return images[0]


def _check_edits_common(payload):
    prompt, seed = _check_common(payload)
    quality, steps = _resolve_quality_steps(payload)
    _check_fixed(payload)
    resolution = parse_resolution(payload)
    return prompt, seed, quality, steps, resolution


def _edit_params(payload, images):
    prompt, seed, quality, steps, resolution = _check_edits_common(payload)
    if "size" in payload:
        # An explicit edit size is validated and passed through unchanged. When
        # size is omitted the output follows the FIRST reference aspect ratio.
        width, height, _ = parse_size(payload)
    else:
        width, height = _derive_edit_size(images[0], resolution)
    return {
        "prompt": prompt, "seed": seed, "steps": steps, "width": width, "height": height,
        "resolution": resolution, "quality": quality,
    }


def parse_edit(payload):
    images = decode_images(payload)
    try:
        params = _edit_params(payload, images)
    except BaseException:
        for image in images:
            image.close()
        raise
    return params, images


def parse_generation(payload):
    prompt, seed = _check_common(payload)
    quality, steps = _resolve_quality_steps(payload)
    _check_fixed(payload)
    if "image" in payload:
        raise ApiError("image is not supported here; use /v1/images/edits")
    width, height, resolution = parse_size(payload)
    return {
        "prompt": prompt, "seed": seed, "steps": steps, "width": width, "height": height,
        "resolution": resolution, "quality": quality,
    }


def parse_request(payload):
    """Backwards-compatible alias for the JSON edit-reference contract."""
    return parse_edit(payload)


async def read_bytes(request):
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_BODY:
            raise ApiError("Request exceeds 64 MiB", "body_too_large", 413)
        body.extend(chunk)
    return bytes(body)


async def read_body(request):
    try:
        return json.loads(await read_bytes(request))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ApiError("Invalid JSON") from exc


def _normalize_upload(key):
    return "image" if key in ("image", "image[]") else key


def _upload_mime(data, declared):
    if declared in (None, "application/octet-stream"):
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if data.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        return None
    return declared


async def _read_form(request, max_files, max_fields):
    body = await read_bytes(request)

    async def stream():
        yield body

    try:
        return await MultiPartParser(
            request.headers, stream(), max_files=max_files, max_fields=max_fields,
            max_part_size=MAX_IMAGE,
        ).parse()
    except (MultiPartException, ValueError) as exc:
        raise ApiError("Invalid multipart form: " + str(exc)) from exc


async def read_multipart(request):
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "multipart/form-data":
        raise ApiError("Expected multipart/form-data")
    form = await _read_form(request, MAX_IMAGES + len(SCALAR_FIELDS) + 6, 16)
    try:
        payload = {}
        images = []
        try:
            for key, value in form.multi_items():
                key = _normalize_upload(key)
                if isinstance(value, UploadFile):
                    if key != "image":
                        raise ApiError("Only image/image[] reference uploads are supported; masks are unsupported")
                    data = await value.read(MAX_IMAGE + 1)
                    if len(data) > MAX_IMAGE:
                        raise ApiError("Image exceeds 8 MiB")
                    mime = _upload_mime(data, value.content_type)
                    if mime not in ("image/png", "image/jpeg"):
                        raise ApiError("Only PNG/JPEG uploads are supported")
                    if len(images) >= MAX_IMAGES:
                        raise ApiError(f"at most {MAX_IMAGES} reference images are supported")
                    images.append(_decode_data_uri(
                        "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")))
                elif key == "image":
                    raise ApiError("image must be a file upload")
                elif key in SCALAR_FIELDS or key in ("quality", "size", "model", "prompt", "response_format"):
                    if key in payload:
                        raise ApiError("Duplicate field: " + key)
                    try:
                        if key == "cfg":
                            value = float(value)
                        elif key in SCALAR_FIELDS:
                            value = int(value)
                    except ValueError as exc:
                        raise ApiError("Invalid numeric field: " + key) from exc
                    payload[key] = value
                else:
                    raise ApiError("Unsupported field: " + key)
            if not images:
                raise ApiError("One PNG/JPEG reference image is required")
            params = _edit_params(payload, images)
        except BaseException:
            for image in images:
                image.close()
            raise
        return params, images
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


def close_images(images):
    if not images:
        return
    for image in images:
        try:
            image.close()
        except Exception:
            pass


async def run_generate(app, request, params, image):
    """Backwards-compatible single-reference entry point."""
    images = None if image is None else (image if isinstance(image, list) else [image])
    return await _run(app, request, params, images)


async def run_edit(app, request, params, images):
    return await _run(app, request, params, images)


async def _run(app, request, params, images):
    if app.state.lock.locked():
        close_images(images)
        raise ApiError("Image backend is busy", "backend_busy", 429)
    await app.state.lock.acquire()
    cancel = threading.Event()
    primary = None if images is None else (images if len(images) > 1 else images[0])
    task = asyncio.create_task(asyncio.to_thread(app.state.runner.generate, params, primary, cancel))
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
        # Text-to-image has no reference image; only close real decoded images.
        close_images(images)


def _provenance(params):
    return {
        "seed": params["seed"],
        "steps": params["steps"],
        "size": f"{params['width']}x{params['height']}",
        "resolution": params["resolution"],
        "quality": params.get("quality"),
    }


def _png_with_provenance(png, params):
    """Attach seed/steps/size/resolution/quality text chunks to a PNG."""
    try:
        from PIL import PngImagePlugin
        with Image.open(io.BytesIO(png)) as base:
            base.load()
            info = PngImagePlugin.PngInfo()
            for key, value in _provenance(params).items():
                info.add_text("lloom:" + key, str(value))
            output = io.BytesIO()
            base.save(output, format="PNG", pnginfo=info)
            return output.getvalue()
    except Exception:
        return png


def _response(png, params):
    return {
        "created": int(time.time()),
        "data": [{"b64_json": base64.b64encode(png).decode("ascii")}],
        **{key: str(value) for key, value in _provenance(params).items()},
    }


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
        return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "created": 0, "owned_by": "Qwen", "capabilities": ["image-generation", "image-editing"]}]}

    @app.post("/v1/images/generations")
    async def generate(request: Request):
        if not app.state.ready:
            raise ApiError("Model is loading", "model_loading", 503)
        payload = await read_body(request)
        if isinstance(payload, dict) and "image" in payload:
            params, images = parse_edit(payload)
        else:
            params, images = parse_generation(payload), None
        png = await _run(app, request, params, images)
        return _response(_png_with_provenance(png, params), params)

    @app.post("/v1/images/edits")
    async def edit(request: Request):
        if not app.state.ready:
            raise ApiError("Model is loading", "model_loading", 503)
        params, images = await read_multipart(request)
        png = await _run(app, request, params, images)
        return _response(_png_with_provenance(png, params), params)

    return app


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(create_app(), host="0.0.0.0", port=8000)
