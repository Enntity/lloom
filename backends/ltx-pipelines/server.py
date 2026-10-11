#!/usr/bin/env python3
"""LLooM native LTX-2.5 video backend.

Wraps the pinned official Lightricks ``ltx_pipelines`` CLIs behind the existing
LLooM OpenAI-compatible video endpoints:

* ``GET  /health``
* ``GET  /v1/models``
* ``POST /v1/videos/generations``  -> ``{created, data:[{b64_json, mime_type}]}``

Each request is validated up-front by :mod:`pipelines` (no torch import here).
By default it is then answered by spawning exactly one
``python -m ltx_pipelines.<module>`` subprocess: the 22B transformer plus Gemma
text encoder are loaded per call and released when the process exits, so no
weights stay resident between requests and the lane is *lazy*, not keep-warm.

``LLOOM_LTX_WARM=1`` opts into a warm worker (:mod:`warm_worker`): one
persistent process per module + weights key that builds the upstream pipeline
on its first request and keeps its models resident for the next ones. It is
released (its process group killed, so memory returns to the host) after
``LLOOM_LTX_WARM_IDLE_SECONDS`` without a request, on timeout or cancel, on any
failure, when a request needs other weights, and before any workflow the
worker does not serve runs as a per-request subprocess.

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
import warm_worker
from pipelines import ApiError

# The runner argv is overridable so CPU tests can point at a fake shim that
# writes a deterministic MP4 without importing torch or touching a GPU. In
# production the default (``python -m <pinned module>``) is used. The warm
# worker is launched through the same prefix as ``warm_worker <module>``.
RUNNER_ENV = "LLOOM_LTX_RUNNER"
MODEL_ROOT_ENV = "LLOOM_LTX_MODEL_ROOT"
TIMEOUT_ENV = "LLOOM_LTX_TIMEOUT_SECONDS"
WARM_ENV = "LLOOM_LTX_WARM"
WARM_IDLE_ENV = "LLOOM_LTX_WARM_IDLE_SECONDS"
DEFAULT_WARM_IDLE_SECONDS = 300.0
LOG_LIMIT = 16 * 1024 * 1024
OUTPUT_LIMIT = 256 * 1024 * 1024

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


def _positive_seconds(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name) or default)
    except ValueError:
        return default
    return value if math.isfinite(value) and value > 0 else default


def timeout_seconds() -> float:
    return _positive_seconds(TIMEOUT_ENV, pipelines.DEFAULT_TIMEOUT_SECONDS)


def warm_enabled() -> bool:
    return os.environ.get(WARM_ENV) == "1"


def warm_idle_seconds() -> float:
    return _positive_seconds(WARM_IDLE_ENV, DEFAULT_WARM_IDLE_SECONDS)


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


async def _finish(coro) -> None:
    """Run cleanup to completion even when the caller is being cancelled."""
    task = asyncio.ensure_future(coro)
    try:
        await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


async def _supervise(done: asyncio.Future, log, timeout: float, disconnect: asyncio.Event,
                     output_path: Path) -> None:
    """Wait for ``done``; raise on disconnect, timeout, or runaway log/output growth.

    The caller owns cleanup: every raise here leaves the process to be reaped.
    Log growth is measured from the start of this request.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    log_start = os.fstat(log.fileno()).st_size
    try:
        while not done.done():
            if disconnect.is_set():
                raise ApiError("client disconnected; generation cancelled", "cancelled", 499)
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise ApiError("generation exceeded its time budget", "timeout", 504)
            if os.fstat(log.fileno()).st_size - log_start > LOG_LIMIT:
                raise ApiError("pipeline log exceeded its limit", "generation_failed", 502)
            if output_path.exists() and output_path.stat().st_size > OUTPUT_LIMIT:
                raise ApiError("pipeline output exceeds 256 MiB", "generation_failed", 502)
            await asyncio.wait({done}, timeout=min(0.2, remaining))
    finally:
        if not done.done():
            done.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await done


def _log_tail(log, what: str) -> None:
    size = os.fstat(log.fileno()).st_size
    log.seek(max(0, size - 8192))
    logging.error("%s: %s", what, log.read().decode("utf-8", "replace"))


async def _run_pipeline(argv: list[str], timeout: float, disconnect: asyncio.Event, output_path: Path) -> None:
    """Run one pipeline subprocess; cancel/reap its group on timeout or disconnect."""
    # A file avoids pipe deadlocks and repeated cancellation of communicate().
    # Bound log growth without accumulating the full inference log in RAM.
    with tempfile.TemporaryFile() as output:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=output, stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            await _supervise(asyncio.ensure_future(proc.wait()), output, timeout, disconnect, output_path)
            if proc.returncode != 0:
                _log_tail(output, "LTX pipeline failed")
                raise ApiError(f"LTX pipeline exited with code {proc.returncode}; see backend logs",
                               "generation_failed", 502)
        finally:
            await _finish(_terminate_process_group(proc))


class WarmWorker:
    """At most one persistent :mod:`warm_worker` process, keyed by module + weights.

    Only touched under the app's single-flight lock, except the idle reaper,
    which never takes that lock (so it cannot turn a new request away with 409);
    a request that arrives mid-release waits for the old process to be reaped
    before a new one may load weights.
    """

    def __init__(self) -> None:
        self.proc: asyncio.subprocess.Process | None = None
        self.key: tuple | None = None
        self.log = None
        self.served = 0
        self.last_used: float | None = None
        self._reaper: asyncio.Task | None = None
        self._releasing: asyncio.Task | None = None

    def describe(self, busy: bool) -> dict:
        if self._releasing is not None:
            state = "releasing"
        elif self.proc is None:
            state = "stopped"
        else:
            state = "busy" if busy else "idle"
        module, transformer, quantization = self.key or (None, None, None)
        idle_for = None
        if state == "idle" and self.last_used is not None:
            idle_for = round(asyncio.get_running_loop().time() - self.last_used, 1)
        return {
            "state": state,
            "pid": self.proc.pid if self.proc else None,
            "module": module,
            "transformer": transformer,
            "quantization": quantization,
            "requests_served": self.served,
            "idle_for_seconds": idle_for,
            "idle_release_seconds": warm_idle_seconds(),
        }

    async def release(self) -> None:
        """Kill the worker's process group and wait until it is reaped."""
        if self._reaper is not None and self._reaper is not asyncio.current_task():
            self._reaper.cancel()
        self._reaper = None
        if self._releasing is None:
            if self.proc is None:
                return
            proc, log = self.proc, self.log
            self.proc, self.log = None, None

            async def terminate():
                try:
                    await _terminate_process_group(proc)
                finally:
                    log.close()
            self._releasing = asyncio.ensure_future(terminate())
        releasing = self._releasing
        try:
            await _finish(releasing)
        finally:
            if self._releasing is releasing and releasing.done():
                self._releasing = None
                self.key = None

    async def _release_when_idle(self, lock: asyncio.Lock) -> None:
        await asyncio.sleep(warm_idle_seconds())
        # A running request reschedules this reaper when it finishes.
        if lock.locked():
            return
        logging.info("LTX warm worker idle for %.0fs; releasing it", warm_idle_seconds())
        try:
            await self.release()
        except Exception:  # noqa: BLE001 - quarantine is already recorded
            logging.exception("LTX warm worker release failed")

    async def render(self, key: tuple, argv: list[str], timeout: float, disconnect: asyncio.Event,
                     output_path: Path, lock: asyncio.Lock) -> dict:
        if self._releasing is not None or (self.proc is not None and (self.key != key or self.proc.returncode is not None)):
            await self.release()
        if self._reaper is not None:
            self._reaper.cancel()
            self._reaper = None
        if self.proc is None:
            self.log = tempfile.TemporaryFile()
            self.proc = await asyncio.create_subprocess_exec(
                *runner_prefix(), "warm_worker", key[0],
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=self.log,
                start_new_session=True,
            )
            self.key, self.served = key, 0
        try:
            try:
                self.proc.stdin.write((json.dumps({"argv": argv}) + "\n").encode())
                await self.proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError) as exc:
                raise ApiError("LTX warm worker exited; see backend logs", "generation_failed", 502) from exc
            reply = asyncio.ensure_future(self.proc.stdout.readline())
            await _supervise(reply, self.log, timeout, disconnect, output_path)
            line = reply.result()
            result = json.loads(line) if line.strip() else {"ok": False, "error": "worker exited"}
            if not result.get("ok"):
                _log_tail(self.log, "LTX warm worker failed")
                raise ApiError("LTX warm worker failed: " + str(result.get("error"))[:300],
                               "generation_failed", 502)
        except BaseException:
            await _finish(self.release())
            raise
        self.served += 1
        self.last_used = asyncio.get_running_loop().time()
        logging.info("LTX warm render %s: %ss (built=%s, served=%d)", key, result.get("seconds"),
                     result.get("built"), self.served)
        if os.fstat(self.log.fileno()).st_size > 4 * LOG_LIMIT:
            await self.release()  # bound the log file; the next request rebuilds
        else:
            self._reaper = asyncio.ensure_future(self._release_when_idle(lock))
        return result


def create_app() -> FastAPI:
    app = FastAPI(title="lloom-ltx-pipelines", version=pipelines.UPSTREAM_VERSION,
                  docs_url=None, redoc_url=None, openapi_url=None)
    lock = asyncio.Lock()
    validation_lock = asyncio.Lock()
    warm = WarmWorker()

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
            # Both modes load weights on the first request that needs them.
            # Warm mode keeps them only until the worker's idle release.
            "lazy_load": True,
            "keep_warm": warm_enabled(),
            "mode": "warm-worker" if warm_enabled() else "per-request",
            "warm_worker": warm.describe(lock.locked()) if warm_enabled() else None,
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
                module = generation["spec"]["module"]

                watcher = asyncio.create_task(watch_disconnect())
                try:
                    if (warm_enabled() and module in warm_worker.WARM_MODULES
                            and generation["offload"] == "none"):
                        key = (module, generation["spec"]["transformer"], generation["quantization"])
                        await warm.render(key, [str(arg) for arg in argv[3:]], timeout_seconds(),
                                          disconnect, output_path, lock)
                    else:
                        # Never hold a warm pipeline beside a per-request one.
                        await warm.release()
                        argv[0:3] = runner_prefix() + [module]
                        await _run_pipeline(argv, timeout_seconds(), disconnect, output_path)
                finally:
                    watcher.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await watcher
                if not output_path.is_file():
                    raise ApiError("pipeline produced no output file", "generation_failed", 502)
                if output_path.stat().st_size > OUTPUT_LIMIT:
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
