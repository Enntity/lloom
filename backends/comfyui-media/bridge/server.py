"""FastAPI bridge: LLooM OpenAI-shaped media calls -> local ComfyUI.

Run:
    PYTHONPATH=../graphs python -m uvicorn server:app --host 127.0.0.1 --port 8000

The ComfyUI endpoint is fixed by the ``--comfy-url`` CLI flag and cannot be
influenced by any request field.
"""

from __future__ import annotations

import argparse
import base64
import logging
import os
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from comfy_client import ComfyClient, validate_comfy_base_url
from errors import BridgeError, backend_error, backend_unavailable, bad_request, rejected
from jobs import SingleFlightRunner
from media import DataRoots
from requests_in import (
    decode_audio,
    decode_inline_image,
    decode_last_frame,
    image_filename,
    validate_bounded_text,
    read_json_body,
    validate_model,
    validate_response_format,
)

log = logging.getLogger("bridge")

DEFAULT_COMFY_URL = "http://127.0.0.1:8188"
MAX_SEED = 2**31 - 1
MAX_DURATION_SECONDS = 600
# Text bounds, enforced here regardless of what the graph library does.
MAX_INSTRUCTIONS_CHARS = 8000
MAX_PROMPT_CHARS = 8000
MAX_INPUT_CHARS = 20000
MAX_LYRICS_CHARS = 20000
# Startup readiness probe against the fixed ComfyUI endpoint.
READY_ATTEMPTS = 30
READY_DELAY = 1.0


def _load_graphs() -> tuple[dict, object]:
    try:
        import graphs  # type: ignore
    except Exception:  # pragma: no cover - configuration failure
        log.error("graphs module could not be imported; check PYTHONPATH")
        return {}, None
    models = getattr(graphs, "MODELS", None)
    if not isinstance(models, dict):
        log.error("graphs.MODELS is missing")
        models = {}
    return models, getattr(graphs, "build_graph", None)


def _default_comfy_url() -> str:
    return os.environ.get("LLOOM_COMFY_URL", DEFAULT_COMFY_URL)


def _default_data_roots() -> DataRoots:
    return DataRoots.from_env()


def create_app(
    comfy: ComfyClient | None = None,
    *,
    models: dict | None = None,
    build_graph=None,
    start_backend: bool = True,
    comfy_url: str | None = None,
) -> FastAPI:
    app = FastAPI(title="LLooM media bridge", docs_url=None, redoc_url=None, openapi_url=None)
    if models is None or build_graph is None:
        default_models, default_builder = _load_graphs()
        if models is None:
            models = default_models
        if build_graph is None:
            build_graph = default_builder
    state = {
        "comfy": comfy,
        "models": models,
        "build_graph": build_graph,
        "comfy_url": validate_comfy_base_url(comfy_url or _default_comfy_url()),
    }
    runner = SingleFlightRunner(comfy, _default_data_roots()) if comfy is not None else None
    state["runner"] = runner
    app.state.bridge = state

    @app.on_event("startup")
    async def _startup() -> None:  # pragma: no cover - exercised live
        if state["comfy"] is None:
            state["comfy"] = ComfyClient(state["comfy_url"])
            state["runner"] = SingleFlightRunner(state["comfy"], _default_data_roots())
        if start_backend:
            await state["comfy"].start()
            # Don't accept traffic until the fixed ComfyUI service answers
            # /system_stats; the server is useless without it.
            if not await state["comfy"].wait_until_ready(attempts=READY_ATTEMPTS, delay=READY_DELAY):
                log.warning("ComfyUI did not become ready within the startup budget")

    @app.on_event("shutdown")
    async def _shutdown() -> None:  # pragma: no cover
        if state["comfy"] is not None:
            await state["comfy"].aclose()

    @app.exception_handler(BridgeError)
    async def _bridge_error(_request: Request, exc: BridgeError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.body())

    @app.exception_handler(Exception)
    async def _unhandled(_request: Request, exc: Exception) -> JSONResponse:
        log.error("unhandled bridge error: %s", type(exc).__name__)
        return JSONResponse(
            status_code=500,
            content={"error": {"message": "Internal bridge error.", "type": "api_error", "code": "internal_error"}},
        )

    def _runner() -> SingleFlightRunner:
        return state["runner"]

    def _registry_ready() -> bool:
        """True when the model registry can actually serve a request.

        An empty registry, a missing build_graph, or a missing runner means no
        modality can be generated; ``/system_stats`` answering is not enough.
        """
        if state.get("runner") is None or state.get("build_graph") is None:
            return False
        models = state.get("models")
        return isinstance(models, dict) and bool(models)

    # -- discovery ---------------------------------------------------------

    @app.get("/health")
    async def health() -> JSONResponse:
        comfy_client = state["comfy"]
        reachable = False
        if comfy_client is not None:
            try:
                await comfy_client.system_stats()
                reachable = True
            except Exception:
                reachable = False
        runner = state.get("runner")
        # ``backend_ready`` means the whole pipeline is usable, not merely that
        # ComfyUI answers: an empty registry or missing graph wiring is a 503
        # even though /system_stats is up.
        healthy = reachable and _registry_ready() and not (runner is not None and runner.unhealthy)
        body = {
            "status": "ok" if healthy else "degraded",
            "backend_ready": healthy,
            "busy": bool(runner is not None and runner.busy),
            "unhealthy": bool(runner is not None and runner.unhealthy),
        }
        return JSONResponse(status_code=200 if healthy else 503, content=body)

    @app.get("/v1/models")
    async def list_models() -> dict:
        created = int(time.time())
        return {
            "object": "list",
            "data": [
                {"id": model_id, "object": "model", "created": created, "owned_by": "lloom"}
                for model_id in sorted(state["models"])
            ],
        }

    # -- video -------------------------------------------------------------

    @app.post("/v1/videos/generations")
    async def video_generations(request: Request) -> Response:
        payload = await read_json_body(request)
        model = validate_model(payload, state["models"])
        validate_response_format(payload, ("b64_json", "json"))
        _validate_prompt(payload)
        image = decode_inline_image(payload)
        last_frame = decode_last_frame(payload)
        audio = decode_audio(payload)
        data, mime = await _run_generation(
            "video",
            model,
            payload,
            image=image,
            last_frame=last_frame,
            audio=audio,
        )
        if mime != "video/mp4":
            raise backend_error("The media backend produced an unexpected output type.")
        return JSONResponse(
            content={
                "created": int(time.time()),
                "data": [{"b64_json": base64.b64encode(data).decode("ascii"), "mime_type": "video/mp4"}],
            }
        )

    # -- images ------------------------------------------------------------

    @app.post("/v1/images/generations")
    async def image_generations(request: Request) -> Response:
        payload = await read_json_body(request)
        model = validate_model(payload, state["models"])
        validate_response_format(payload, ("b64_json", "json"))
        _validate_prompt(payload)
        image = decode_inline_image(payload)
        data, mime = await _run_generation("image", model, payload, image=image)
        if mime != "image/png":
            raise backend_error("The media backend produced an unexpected output type.")
        return JSONResponse(
            content={
                "created": int(time.time()),
                "data": [{"b64_json": base64.b64encode(data).decode("ascii"), "mime_type": "image/png"}],
            }
        )

    # -- audio -------------------------------------------------------------

    @app.post("/v1/audio/speech")
    async def audio_speech(request: Request) -> Response:
        raise bad_request("Music models use /v1/audio/generations.", "wrong_model_kind")

    @app.post("/v1/audio/generations")
    async def audio_generations(request: Request) -> Response:
        payload = await read_json_body(request)
        model = validate_model(payload, state["models"])
        validate_response_format(payload, ("wav",))
        data, mime = await _run_generation("audio", model, payload, image=None)
        if mime != "audio/wav":
            raise backend_error("The media backend produced an unexpected output type.")
        return Response(content=data, media_type="audio/wav")

    # -- shared generation path -------------------------------------------

    def _upload_name(frame) -> str:
        """Server-generated safe basename for one conditioning image upload."""
        name = image_filename()
        return name[:-4] + ".jpg" if frame[2] == "jpg" else name

    def _media_name(frame) -> str:
        """Server-generated safe basename for an audio upload."""
        return image_filename()[:-4] + "." + frame[2]

    async def _run_generation(
        kind: str, model: str, payload: dict, *, image, last_frame=None, audio=None
    ) -> tuple[bytes, str]:
        expected_kind = "audio" if kind in ("audio", "speech") else kind
        for field, limit in (("prompt", 8000), ("instructions", 8000), ("input", 20000), ("lyrics", 20000)):
            validate_bounded_text(payload, field, limit)
        runner = _runner()
        if runner is None:
            raise backend_unavailable("Media backend is not configured.")
        build_graph = state.get("build_graph")
        if build_graph is None:
            raise backend_unavailable("Media backend is not configured.")
        # The expected media kind is validated against the registry (and, below,
        # against the graph's own declared kind) *before* any upload or submit,
        # so a wrong-kind request is a 400 that never reaches the GPU.
        metadata = state["models"].get(model)
        declared = metadata.get("kind") if isinstance(metadata, dict) else metadata
        if declared in ("speech", "audio_speech"):
            declared = "audio"
        if declared in ("video", "audio", "image") and declared != expected_kind:
            raise bad_request("Model does not support this media endpoint.", "model_kind_mismatch")
        # Mutable context shared with the runner. The upload references become
        # known inside ``build`` after Comfy accepts each upload, and the runner
        # carries them through every terminal/cancellation cleanup path.
        upload_ref: list[str] = []

        # Every conditioning image travels as (decoded frame, generated name,
        # build_graph keyword). Order matters: the first frame anchors the clip.
        frames = []
        if image is not None:
            frames.append((image, _upload_name(image), "image_filename"))
        if last_frame is not None:
            frames.append((last_frame, _upload_name(last_frame), "last_image_filename"))
        if audio is not None:
            # Audio rides the same upload path; Comfy stores it beside the images
            # and the graph's LoadAudio reads it by name.
            frames.append((audio, _media_name(audio), "audio_filename"))

        async def build(comfy: ComfyClient):
            # Build the graph *first* (cheap, no GPU) so its declared kind can be
            # checked before anything is uploaded. The generated filenames are
            # known up front, so no part of the graph depends on an upload.
            kwargs = {keyword: name for _frame, name, keyword in frames}
            try:
                graph, output_node, out_kind = build_graph(
                    model, payload, prefix="lloom", **kwargs
                )
            except ValueError as exc:
                # Surface the specific reason. A generic "invalid parameters"
                # message hides which field was wrong and what it may be, which
                # makes one bad value look like a model that cannot do the job.
                # These messages name only the field and its permitted range.
                raise bad_request(
                    str(exc) or "Invalid generation parameters for this model.", "invalid_field"
                ) from None
            if out_kind not in ("video", "audio", "image"):
                raise backend_error("The media backend produced an unsupported output.")
            if out_kind != expected_kind:
                # The graph wants to generate a different medium than this
                # endpoint promises: reject before anything reaches the GPU.
                raise bad_request("Model does not support this media endpoint.", "model_kind_mismatch")
            for frame, name, _keyword in frames:
                data, content_type, _ext = frame
                # Comfy returns the authoritative, subfolder-qualified
                # reference; the graph must use that, never our local basename.
                uploaded = await comfy.upload_image(data, name, content_type)
                upload_ref.append(uploaded)
                if uploaded != name:
                    # The reference the graph already baked in must be the one
                    # Comfy actually stored, or the graph would load a file that
                    # does not exist. Comfy's response is authoritative, so a
                    # mismatch is an uncertain-state error, not a silent rename.
                    raise backend_error("Image upload to the media backend failed.")
            return graph, output_node, out_kind

        return await runner.run(build, kind=expected_kind, upload_ref=upload_ref)

    return app


def _validate_prompt(payload: dict) -> None:
    prompt = payload.get("prompt")
    if prompt is not None and not isinstance(prompt, str):
        raise bad_request("Field 'prompt' must be a string.", "invalid_field")
    if isinstance(prompt, str) and len(prompt) > MAX_INSTRUCTIONS_CHARS:
        raise bad_request("Field 'prompt' is too long.", "invalid_field")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LLooM media bridge")
    parser.add_argument("--comfy-url", default=DEFAULT_COMFY_URL, help="Fixed ComfyUI base URL (loopback only).")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address; loopback by default.")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    import uvicorn

    uvicorn.run(create_app(comfy_url=args.comfy_url), host=args.host, port=args.port, log_level="info")
    return 0


app = create_app()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
