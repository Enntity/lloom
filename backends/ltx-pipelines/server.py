#!/usr/bin/env python3
"""LLooM native LTX-2.5 video backend.

Wraps the pinned official Lightricks ``ltx_pipelines`` CLIs behind the existing
LLooM OpenAI-compatible video endpoints:

* ``GET  /health``
* ``GET  /v1/models``
* ``POST /v1/videos/generations``  -> ``{created, data:[{b64_json, mime_type}]}``

Each request is validated up-front by :mod:`pipelines` (no torch import here)
and then answered by spawning exactly one ``python -m ltx_pipelines.<module>``
subprocess. The process-per-request design is deliberate: the 22B transformer
plus Gemma text encoder are loaded per call and released when the process exits,
so no weights stay resident between requests. We therefore advertise the lane as
*lazy*, not keep-warm.

Concurrency is a single-flight guard: one generation at a time per runtime, so
two 22B transformers never fight for unified memory. A waiter that is cancelled
(its HTTP client disconnected) or that exceeds the timeout has its whole
process *group* terminated (SIGTERM, then SIGKILL) and reaped before the next
request is admitted.
"""
from __future__ import annotations

import asyncio
import base64
import datetime
import contextlib
import json
import logging
import math
import io
import os
import shutil
import signal
import tempfile
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

import pipelines
from pipelines import ApiError

# The runner argv is overridable so CPU tests can point at a fake shim that
# writes a deterministic MP4 without importing torch or touching a GPU. In
# production the default (``python -m <pinned module>``) is used.
RUNNER_ENV = "LLOOM_LTX_RUNNER"
MODEL_ROOT_ENV = "LLOOM_LTX_MODEL_ROOT"
TIMEOUT_ENV = "LLOOM_LTX_TIMEOUT_SECONDS"

MANAGED = True
QUARANTINED = False


def model_root() -> Path:
    root = os.environ.get(MODEL_ROOT_ENV)
    if not root:
        raise ApiError(
            f"{MODEL_ROOT_ENV} is not configured; the LTX-2.5 components are not located",
            "model_unavailable",
            503,
        )
    return Path(root)


def runner_prefix() -> list[str]:
    """The argv prefix that launches one pinned upstream pipeline module.

    Accepts a JSON list (e.g. ``["/usr/bin/python3", "-m"]``) or a bare
    executable path. Never a shell string, so no request can inject flags.
    """
    raw = os.environ.get(RUNNER_ENV)
    if not raw:
        return ["python3", "-m"]
    if raw.lstrip().startswith("["):
        parsed = json.loads(raw)
        if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
            raise ApiError("invalid runner override", "server_error", 500)
        return parsed
    return [raw, "-m"]


def timeout_seconds() -> float:
    raw = os.environ.get(TIMEOUT_ENV)
    if not raw:
        return pipelines.DEFAULT_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return pipelines.DEFAULT_TIMEOUT_SECONDS
    return value if math.isfinite(value) and value > 0 else pipelines.DEFAULT_TIMEOUT_SECONDS


def _json_error(exc: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"message": exc.message, "type": exc.code, "code": exc.code}},
    )


def _rfc3339_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _terminate_process_group(proc: asyncio.subprocess.Process) -> None:
    """Kill the whole subprocess group and reap it before returning.

    The child is started with ``start_new_session=True`` so it owns its own
    process group; killing the group guarantees the upstream pipeline's worker
    processes (DataLoader helpers, torch.compile workers) die with it, which is
    what makes releasing unified memory reliable between requests.
    """
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(proc.wait(), timeout=10.0)
            # Also kill any ordinary descendants that outlived the leader.
            with contextlib.suppress(ProcessLookupError):
                os.killpg(proc.pid, signal.SIGKILL)
            return
        except asyncio.TimeoutError:
            continue
    global QUARANTINED
    QUARANTINED = True
    raise ApiError("pipeline did not exit; runtime quarantined and requires restart", "cleanup_failed", 503)


async def _run_pipeline(argv: list[str], timeout: float, disconnect: asyncio.Event, output_path: Path) -> None:
    """Run one pipeline subprocess; cancel/reap its group on timeout or disconnect."""
    # A file avoids pipe deadlocks and repeated cancellation of communicate().
    # Bound log growth without accumulating the full inference log in RAM.
    with tempfile.TemporaryFile() as output:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=output, stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        waiter = asyncio.create_task(proc.wait())
        deadline = asyncio.get_running_loop().time() + timeout
        try:
            while not waiter.done():
                if disconnect.is_set():
                    raise ApiError("client disconnected; generation cancelled", "cancelled", 499)
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise ApiError("generation exceeded its time budget", "timeout", 504)
                if os.fstat(output.fileno()).st_size > 16 * 1024 * 1024:
                    raise ApiError("pipeline log exceeded its limit", "generation_failed", 502)
                if output_path.exists() and output_path.stat().st_size > 256 * 1024 * 1024:
                    raise ApiError("pipeline output exceeds 256 MiB", "generation_failed", 502)
                await asyncio.wait({waiter}, timeout=min(0.2, remaining))
            if proc.returncode != 0:
                size = os.fstat(output.fileno()).st_size
                output.seek(max(0, size - 8192))
                logging.error("LTX pipeline failed: %s", output.read().decode("utf-8", "replace"))
                raise ApiError(f"LTX pipeline exited with code {proc.returncode}; see backend logs",
                               "generation_failed", 502)
        finally:
            cleanup = asyncio.create_task(_terminate_process_group(proc))
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                await cleanup
                raise
            finally:
                if not waiter.done():
                    waiter.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await waiter


def create_app() -> FastAPI:
    app = FastAPI(title="lloom-ltx-pipelines", version=pipelines.UPSTREAM_VERSION,
                  docs_url=None, redoc_url=None, openapi_url=None)
    lock = asyncio.Lock()
    validation_lock = asyncio.Lock()

    @app.get("/health")
    async def health():
        root = os.environ.get(MODEL_ROOT_ENV)
        available = []
        workflows = {}
        if root:
            for model, model_workflows in pipelines.PIPELINES.items():
                readiness = {}
                for workflow, spec in model_workflows.items():
                    try:
                        pipelines.resolve_assets(root, spec)
                        readiness[workflow] = True
                    except ApiError:
                        readiness[workflow] = False
                workflows[model] = readiness
                # A model is available when its default workflow's assets are
                # ready. Some workflows need extra components (refine needs the
                # detailing IC-LoRA), so a missing optional workflow must not
                # mark the model unavailable.
                if readiness.get(pipelines.DEFAULT_WORKFLOW, False):
                    available.append(model)
        ready = bool(available) and not QUARANTINED
        return JSONResponse(status_code=200 if ready else 503, content={
            "status": "ok" if ready else "degraded",
            "backend": "ltx-pipelines",
            "upstream": pipelines.UPSTREAM_VERSION,
            "upstream_commit": pipelines.UPSTREAM_COMMIT,
            "managed": MANAGED,
            "lazy_load": True,
            "keep_warm": False,
            "single_flight": True,
            "busy": lock.locked(),
            "quarantined": QUARANTINED,
            "model_root_configured": bool(root),
            "available_models": available,
            "unavailable_models": [model for model in pipelines.PIPELINES if model not in available],
            "workflow_ready": workflows,
        })

    @app.get("/v1/models")
    async def models():
        created = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
        data = []
        for entry in pipelines.describe():
            item = {
                "id": entry["id"],
                "object": "model",
                "created": created,
                "owned_by": "lightricks",
                "default_workflow": entry["default_workflow"],
                "workflows": entry["workflows"],
            }
            data.append(item)
        return {"object": "list", "data": data}

    @app.post("/v1/videos/generations")
    async def generate(request: Request):
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > pipelines.MAX_BODY:
                return _json_error(ApiError("request body too large", "body_too_large", 413))
            raw.extend(chunk)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return _json_error(ApiError("request body must be valid JSON"))

        # Validate before touching the single-flight lock so a bad request never
        # queues behind a running generation.
        try:
            if lock.locked() or validation_lock.locked():
                return _json_error(ApiError("a generation is already in flight", "busy", 409))
            async with validation_lock:
                validation = asyncio.create_task(asyncio.to_thread(pipelines.parse_generation, payload))
                try:
                    generation = await asyncio.shield(validation)
                except asyncio.CancelledError:
                    with contextlib.suppress(Exception):
                        await validation
                    raise
        except ApiError as exc:
            return _json_error(exc)

        try:
            assets = pipelines.resolve_assets(
                model_root(), generation["spec"], generation["temporal_upscalings"]
            )
        except ApiError as exc:
            return _json_error(exc)

        if QUARANTINED:
            return _json_error(ApiError("runtime quarantined; restart required", "cleanup_failed", 503))
        if lock.locked():
            return _json_error(
                ApiError("a generation is already in flight; this runtime is single-flight", "busy", 409)
            )

        disconnect = asyncio.Event()

        async def watch_disconnect():
            try:
                while True:
                    message = await request.receive()
                    if message["type"] == "http.disconnect":
                        disconnect.set()
                        return
            except Exception:
                disconnect.set()

        async with lock:
            workdir = Path(tempfile.mkdtemp(prefix="lltx-", dir=os.environ.get("TMPDIR") or None))
            try:
                media_paths = {}
                for image in generation["images"]:
                    path = pipelines.media_path_for(image, workdir)
                    path.write_bytes(image["bytes"])
                    media_paths[image["field"]] = path
                if generation["audio"] is not None:
                    audio_path = pipelines.media_path_for(
                        {"field": "audio", "ext": generation["audio"]["ext"]}, workdir
                    )
                    # Upstream requires enough audio latents for the requested
                    # frame grid. Preserve supplied samples and append silence
                    # when a return-to-idle tail or grid rounding needs it.
                    import numpy as np
                    import soundfile as sf
                    with sf.SoundFile(io.BytesIO(generation["audio"]["bytes"])) as source:
                        rate = source.samplerate
                        required = math.ceil((generation["audio_start_time"] + generation["num_frames"] / generation["frame_rate"]) * rate)
                        samples = source.read(frames=required, dtype="float32", always_2d=True)
                    if samples.shape[1] == 1:
                        samples = np.repeat(samples, 2, axis=1)
                    if len(samples) < required:
                        samples = np.pad(samples, ((0, required - len(samples)), (0, 0)))
                    audio_path = workdir / "audio.wav"
                    sf.write(audio_path, samples, rate, format="WAV", subtype="FLOAT")
                    media_paths["audio"] = audio_path

                if generation["video"] is not None:
                    video_path = workdir / "input.mp4"
                    video_path.write_bytes(generation["video"]["bytes"])
                    media_paths["video"] = video_path
                output_path = workdir / "out.mp4"
                argv = pipelines.build_argv(generation, assets, media_paths, output_path)
                argv[0:3] = runner_prefix() + [generation["spec"]["module"]]

                watcher = asyncio.create_task(watch_disconnect())
                try:
                    await _run_pipeline(argv, timeout_seconds(), disconnect, output_path)
                finally:
                    watcher.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await watcher
                if not output_path.is_file():
                    raise ApiError("pipeline produced no output file", "generation_failed", 502)
                if output_path.stat().st_size > 256 * 1024 * 1024:
                    raise ApiError("pipeline output exceeds 256 MiB", "generation_failed", 502)
                encoded = base64.b64encode(output_path.read_bytes()).decode("ascii")
            except ApiError as exc:
                return _json_error(exc)
            finally:
                shutil.rmtree(workdir, ignore_errors=True)

        return {
            "created": int(datetime.datetime.now(datetime.timezone.utc).timestamp()),
            "data": [{"b64_json": encoded, "mime_type": "video/mp4"}],
            "model": generation["model"],
            "workflow": generation["workflow"],
        }

    return app


app = create_app()
