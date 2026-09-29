"""Private, single-flight ACE-Step music generation backend for LLooM.

Serves the OpenAI-compatible audio-generation contract the gateway proxies:
``POST /v1/audio/generations`` with a JSON body, returning raw 16-bit PCM WAV.

Unlike the shared ComfyUI media bridge, musical parameters are first-class here.
``bpm``, ``keyscale`` and ``timesignature`` default to unset, which lets the
checkpoint infer them from the prompt instead of pinning every track to 100 BPM
in C major.
"""
import asyncio
import json
import os
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pipeline import GenerationCancelled, Runner

MAX_BODY = 1 * 1024 * 1024
MIN_DURATION = 1.0
MAX_DURATION = 600.0
MIN_STEPS = 1
MAX_STEPS = 200
DEFAULT_GUIDANCE = 7.0
DEFAULT_SHIFT = 3.0
SFT_STEPS = 50
TURBO_STEPS = 8
KEYS = [f"{root} {quality}" for quality in ("major", "minor")
        for root in ("C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#",
                     "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B")]
TIMESIGNATURES = ("2", "3", "4", "6")
LANGS = ("ar", "az", "bg", "bn", "ca", "cs", "da", "de", "el", "en", "es", "fa", "fi",
         "fr", "he", "hi", "hr", "ht", "hu", "id", "is", "it", "ja", "ko", "la", "lt",
         "ms", "ne", "nl", "no", "pa", "pl", "pt", "ro", "ru", "sa", "sk", "sr", "sv",
         "sw", "ta", "te", "th", "tl", "tr", "uk", "ur", "vi", "yue", "zh", "unknown")
ALLOWED = {"model", "prompt", "instructions", "lyrics", "duration", "max_duration",
           "bpm", "keyscale", "timesignature", "language", "vocal_language",
           "guidance_scale", "steps", "shift", "seed", "response_format"}


class ApiError(Exception):
    def __init__(self, message, code="invalid_request", status=400):
        self.message, self.code, self.status = message, code, status


def _optional_number(payload, field, low, high, cast):
    value = payload.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise ApiError(f"{field} must be a number between {low} and {high}")
    return cast(value)


def parse_generation(payload, default_steps):
    if not isinstance(payload, dict):
        raise ApiError("Request body must be a JSON object")
    unknown = set(payload) - ALLOWED
    if unknown:
        raise ApiError("Unsupported fields: " + ", ".join(sorted(unknown)))

    caption = payload.get("instructions", payload.get("prompt"))
    if not isinstance(caption, str) or not caption.strip() or len(caption) > 8192:
        raise ApiError("instructions must contain 1 to 8192 characters")

    lyrics = payload.get("lyrics", "")
    if not isinstance(lyrics, str) or len(lyrics) > 20000:
        raise ApiError("lyrics must be text of at most 20000 characters")

    if payload.get("duration") is not None and payload.get("max_duration") is not None:
        if payload["duration"] != payload["max_duration"]:
            raise ApiError("duration and max_duration must agree when both are set")
    duration = payload.get("duration", payload.get("max_duration", 30.0))
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) \
            or not MIN_DURATION <= duration <= MAX_DURATION:
        raise ApiError(f"duration must be a number between {MIN_DURATION} and {MAX_DURATION}")

    bpm = _optional_number(payload, "bpm", 10, 300, int)
    keyscale = payload.get("keyscale")
    if keyscale is not None and keyscale not in KEYS:
        raise ApiError("keyscale must be a key and mode such as 'E minor'")
    timesignature = payload.get("timesignature")
    if timesignature is not None:
        timesignature = str(timesignature)
        if timesignature not in TIMESIGNATURES:
            raise ApiError("timesignature must be one of " + ", ".join(TIMESIGNATURES))

    language = payload.get("language", payload.get("vocal_language", "en"))
    if language not in LANGS:
        raise ApiError("Unsupported music language")

    seed = payload.get("seed", 42)
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2 ** 63:
        raise ApiError("seed must be an integer between 0 and 2^63-1")

    steps = payload.get("steps", default_steps)
    if isinstance(steps, bool) or not isinstance(steps, int) or not MIN_STEPS <= steps <= MAX_STEPS:
        raise ApiError(f"steps must be an integer between {MIN_STEPS} and {MAX_STEPS}")

    if payload.get("response_format", "wav") != "wav":
        raise ApiError("Only response_format=wav is supported")

    return {
        "prompt": caption,
        "lyrics": lyrics,
        "duration": float(duration),
        "seed": seed,
        "steps": steps,
        "bpm": bpm,
        "keyscale": keyscale,
        "timesignature": timesignature,
        "language": language,
        "guidance_scale": _optional_number(payload, "guidance_scale", 0.0, 100.0, float)
        or DEFAULT_GUIDANCE,
        "shift": _optional_number(payload, "shift", 0.0, 20.0, float) or DEFAULT_SHIFT,
    }


async def read_bytes(request):
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_BODY:
            raise ApiError("Request exceeds 1 MiB", "body_too_large", 413)
        body.extend(chunk)
    return bytes(body)


async def read_body(request):
    try:
        return json.loads(await read_bytes(request))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ApiError("Invalid JSON") from exc


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
        task.exception()


async def run_generate(app, request, params):
    if app.state.lock.locked():
        raise ApiError("Music backend is busy", "backend_busy", 429)
    await app.state.lock.acquire()
    cancel = threading.Event()
    task = asyncio.create_task(asyncio.to_thread(app.state.runner.generate, params, cancel))
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


def create_app(runner_factory=None):
    def default_factory():
        path = os.environ.get("LLOOM_ACE_MODEL_PATH")
        model_id = os.environ.get("LLOOM_ACE_MODEL_ID")
        if not path or not model_id:
            raise SystemExit("LLOOM_ACE_MODEL_PATH and LLOOM_ACE_MODEL_ID are required")
        return Runner(path, model_id)

    factory = runner_factory or default_factory

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
        return JSONResponse({"error": {"message": exc.message, "type": "invalid_request_error",
                                       "code": exc.code}}, status_code=exc.status, headers=headers)

    @app.get("/health")
    async def health():
        return JSONResponse({"status": "ok" if app.state.ready else "loading"},
                            status_code=200 if app.state.ready else 503)

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{
            "id": app.state.runner.model_id if app.state.ready else "ACE-Step",
            "object": "model", "created": 0, "owned_by": "ACE-Step",
            "capabilities": ["audio-generation", "music-generation"]}]}

    @app.post("/v1/audio/generations")
    async def generate(request: Request):
        if not app.state.ready:
            raise ApiError("Model is loading", "model_loading", 503)
        payload = await read_body(request)
        default_steps = TURBO_STEPS if app.state.runner.is_turbo else SFT_STEPS
        params = parse_generation(payload, default_steps)
        wav = await run_generate(app, request, params)
        return Response(content=wav, media_type="audio/wav")

    return app


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(create_app(), host="0.0.0.0", port=8000)
