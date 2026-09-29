"""FastAPI bridge: LLooM OpenAI-shaped media calls -> local ComfyUI.

Run:
    PYTHONPATH=../graphs python -m uvicorn server:app --host 127.0.0.1 --port 8000

The ComfyUI endpoint is fixed by the ``--comfy-url`` CLI flag and cannot be
influenced by any request field.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import logging
import os
import time
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from comfy_client import ComfyClient, validate_comfy_base_url
from errors import BridgeError, backend_error, backend_unavailable, bad_request, rejected
from jobs import SingleFlightRunner
from media import DataRoots
from video_codec import decode_reference_video
from requests_in import (
    decode_audio,
    decode_inline_image,
    decode_last_frame,
    image_filename,
    multipart_numeric,
    multipart_reference_images,
    read_multipart_form,
    validate_bounded_text,
    read_json_body,
    validate_model,
    validate_response_format,
)

log = logging.getLogger("bridge")

DEFAULT_COMFY_URL = "http://127.0.0.1:8188"
# Optional single-model selector. When set, the bridge serves exactly that one
# registry entry. An empty or unknown value refuses startup rather than falling
# back to advertising every bundled model.
MAX_SEED = 2**31 - 1
MAX_DURATION_SECONDS = 600
# Text bounds, enforced here regardless of what the graph library does.
MAX_INSTRUCTIONS_CHARS = 8000
MAX_PROMPT_CHARS = 8000
MAX_INPUT_CHARS = 20000
MAX_LYRICS_CHARS = 20000
# Qwen 2.1 edit surface: the native multipart scalars a caller may set. Anything
# else in the form is either generation-only geometry or an unknown field.
# The INT8 and NVFP4 lanes are the same contract with different pinned weights,
# so every 2.1-only rule keys off this set rather than one ID.
MEDIA_MODEL_ENV = "LLOOM_MEDIA_MODEL"
QWEN_21_MODEL = "Qwen/Qwen-Image-2.1"
QWEN_21_MODELS = frozenset({"Qwen/Qwen-Image-2.1", "BennyDaBall/Qwen-Image-2.1-NVFP4"})
QWEN_EDIT_SCALARS = ("model", "prompt", "negative_prompt", "seed", "steps", "cfg", "quality", "resolution", "n", "response_format")
QWEN_EDIT_NUMERIC_INTS = ("seed", "steps", "resolution", "n")
QWEN_EDIT_NUMERIC_FLOATS = ("cfg",)
# Resolution is measured in the graph itself; this only bounds the transport so a
# 40-digit integer cannot become an unbounded string comparison.
MAX_EDIT_SCALAR_CHARS = 64
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


def _resolve_media_model(select: str | None = None) -> str | None:
    """The exact registry model a single-model runtime serves, if configured.

    ``select`` defaults to ``LLOOM_MEDIA_MODEL``. An absent variable selects
    nothing, which only in-process tests rely on: the container launcher
    refuses to start without a selection. A present
    but empty or whitespace-only value is a configuration error and refuses
    startup. Validation against the registry happens in ``create_app`` so the
    rejection also covers explicitly injected ``models``.
    """
    value = os.environ.get(MEDIA_MODEL_ENV) if select is None else select
    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        raise ValueError(f"{MEDIA_MODEL_ENV} is set but empty; set an exact model ID or unset it.")
    if stripped != value:
        # Surrounding whitespace is almost certainly a deployment mistake; an
        # exact model ID never carries it. Resolve to the trimmed ID, which is
        # then validated against the registry like any other selection.
        log.warning("%s has surrounding whitespace; using %r", MEDIA_MODEL_ENV, stripped)
    return stripped


def _select_models(models: dict, select: str | None) -> dict:
    """Filter ``models`` to ``select``; fail closed on an unknown selection."""
    if select is None:
        return models
    if not isinstance(models, dict) or select not in models:
        supported = ", ".join(sorted(models)) if isinstance(models, dict) and models else "(none)"
        raise ValueError(
            f"{MEDIA_MODEL_ENV}={select!r} is not in this bridge's model registry. Supported models: {supported}."
        )
    return {select: models[select]}


def create_app(
    comfy: ComfyClient | None = None,
    *,
    models: dict | None = None,
    build_graph=None,
    start_backend: bool = True,
    comfy_url: str | None = None,
    media_model: str | None = None,
) -> FastAPI:
    app = FastAPI(title="LLooM media bridge", docs_url=None, redoc_url=None, openapi_url=None)
    if models is None or build_graph is None:
        default_models, default_builder = _load_graphs()
        if models is None:
            models = default_models
        if build_graph is None:
            build_graph = default_builder
    # A single-model runtime must never advertise a model it cannot serve, so
    # the selector is applied here -- after any injected registry is known and
    # before the app can accept a request. An unknown or empty value raises out
    # of the app factory: startup (including uvicorn import of module-level
    # ``app``) fails closed instead of degrading to the full registry.
    models = _select_models(models, _resolve_media_model(media_model))
    video_preflight_lock = asyncio.Lock()
    state = {
        "comfy": comfy,
        "models": models,
        "build_graph": build_graph,
        "comfy_url": validate_comfy_base_url(comfy_url or _default_comfy_url()),
        "media_model": next(iter(models)) if len(models) == 1 else None,
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
        if model.startswith("MiniMaxAI/MiniMax-H3") or model in ("Lightricks/LTX-2.5", "Lightricks/LTX-2.5-Comfy-Full"):
            from graphs import normalize_video_payload
            try:
                payload = normalize_video_payload(model, payload)
            except ValueError as exc:
                raise bad_request(str(exc), "invalid_field") from None
        _validate_prompt(payload)
        image = decode_inline_image(payload)
        last_frame = decode_last_frame(payload)
        audio = decode_audio(payload)
        if audio is not None and model in ("Lightricks/LTX-2.5", "Lightricks/LTX-2.5-Comfy-Full"):
            from requests_in import fit_ltx_audio
            audio = fit_ltx_audio(audio, payload)
        video = None
        if payload.get("video") is not None:
            if video_preflight_lock.locked():
                raise bad_request("A video reference is already being validated.", "busy")
            async with video_preflight_lock:
                task = asyncio.create_task(asyncio.to_thread(decode_reference_video, payload))
                try:
                    video = await asyncio.shield(task)
                except asyncio.CancelledError:
                    try:
                        await task
                    except Exception:
                        pass
                    raise
        data, mime = await _run_generation(
            "video",
            model,
            payload,
            image=image,
            last_frame=last_frame,
            audio=audio,
            video=video,
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
        payload, seed_meta = _prepare_image_seed(model, payload)
        image = decode_inline_image(payload)
        data, mime = await _run_generation("image", model, payload, image=image)
        if mime != "image/png":
            raise backend_error("The media backend produced an unexpected output type.")
        body = {
            "created": int(time.time()),
            "data": [{"b64_json": base64.b64encode(data).decode("ascii"), "mime_type": "image/png"}],
        }
        if seed_meta is not None:
            body["seed"] = seed_meta["seed"]
            body["seed_source"] = seed_meta["seed_source"]
        return JSONResponse(content=body)

    @app.post("/v1/images/edits")
    async def image_edits(request: Request) -> Response:
        """Multipart reference-image edit, a native-compatible shape.

        Clients post multipart text scalars and an image file. This backend's edit lanes
        consume exactly one reference, so the form is validated here first and
        then handed to the same validation and generation path the JSON
        generation endpoint uses.
        """
        fields, uploads, counts = await read_multipart_form(request)
        payload = _multipart_edit_payload(fields, counts, uploads)
        model = validate_model(payload, state["models"])
        if not _supports_image_edit(model):
            # A generation-only lane has no reference-image input in its graph:
            # refusing here is a 400 that never reaches the GPU.
            raise bad_request(
                "This model does not support reference-image editing. Use /v1/images/generations.",
                "model_kind_mismatch",
            )
        validate_response_format(payload, ("b64_json", "json"))
        if model not in QWEN_21_MODELS and ("quality" in payload or "resolution" in payload):
            raise bad_request("quality and resolution apply only to Qwen Image 2.1.", "invalid_field")
        _validate_prompt(payload)
        payload, seed_meta = _prepare_image_seed(model, payload)
        image = multipart_reference_images(uploads, counts)
        data, mime = await _run_generation("image", model, payload, image=image)
        if mime != "image/png":
            raise backend_error("The media backend produced an unexpected output type.")
        body = {
            "created": int(time.time()),
            "data": [{"b64_json": base64.b64encode(data).decode("ascii"), "mime_type": "image/png"}],
            "image_validation": {"images": 1, "mime_type": image[1]},
        }
        if seed_meta is not None:
            body["seed"] = seed_meta["seed"]
            body["seed_source"] = seed_meta["seed_source"]
        return JSONResponse(content=body)

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
        kind: str, model: str, payload: dict, *, image, last_frame=None, audio=None, video=None
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

        if video is not None:
            frames.append((video, _media_name(video), "video_filename"))

        async def build(comfy: ComfyClient):
            # Build the graph *first* (cheap, no GPU) so its declared kind can be
            # checked before anything is uploaded. The generated filenames are
            # known up front, so no part of the graph depends on an upload.
            kwargs = {keyword: name for _frame, name, keyword in frames}
            try:
                graph, output_node, out_kind = build_graph(
                    model, payload, prefix="lloom_" + uuid.uuid4().hex, **kwargs
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


def _supports_image_edit(model: str) -> bool:
    """Whether the model's pinned graph consumes a reference image.

    The graph module owns the contract: a family is edit-capable only when its
    builder wires the reference into the text encoder. Registry metadata alone
    cannot decide this, so an import that fails or a builder that predates the
    edit lane is treated as generation-only.
    """
    try:
        from graphs import supports_image_edit
    except Exception:  # pragma: no cover - configuration failure
        return False
    try:
        return bool(supports_image_edit(model))
    except Exception:  # pragma: no cover - defensive
        return False


def _multipart_edit_payload(fields: dict, counts: dict, uploads: dict) -> dict:
    """Convert validated multipart text scalars into the graph's JSON payload.

    Native multipart sends numbers as text; the graph takes real numbers. Every
    scalar is bounds-checked here, duplicates and unknown fields are refused, and
    private parameters (a caller-supplied graph, checkpoint or path) cannot be
    smuggled in under a new name because only the listed scalars are copied.
    """
    from requests_in import multipart_scalar

    widths = {
        "model": MAX_EDIT_SCALAR_CHARS,
        "quality": MAX_EDIT_SCALAR_CHARS,
        "prompt": MAX_PROMPT_CHARS,
        "negative_prompt": MAX_PROMPT_CHARS,
        "response_format": MAX_EDIT_SCALAR_CHARS,
    }
    for name in counts:
        if name in ("image", "image[]"):
            continue
        if name not in QWEN_EDIT_SCALARS:
            raise bad_request(f"Unsupported form field '{name}'.", "invalid_field")
    payload: dict = {}
    for name in ("model", "prompt", "negative_prompt", "quality", "response_format"):
        # A text scalar is capped before it is ever copied into the payload, so a
        # 40 MiB "prompt" part is refused as a field error rather than carried
        # into the graph and rejected later for the wrong reason.
        raw = multipart_scalar(fields, counts, name, maximum=widths[name])
        if raw is None:
            continue
        if name == "quality":
            raw = raw.strip()
        payload[name] = raw
    for name in QWEN_EDIT_NUMERIC_INTS:
        value = multipart_numeric(fields, counts, name, integer=True)
        if value is not None:
            payload[name] = value
    for name in QWEN_EDIT_NUMERIC_FLOATS:
        value = multipart_numeric(fields, counts, name, integer=False)
        if value is not None:
            payload[name] = value
    return payload


def _prepare_image_seed(model: str, payload: dict) -> tuple[dict, dict | None]:
    """Return a copied payload carrying the seed the graph will actually use.

    Qwen 2.1 derives a fresh cryptographic seed when the caller omits one, so the
    seed in the graph is unknowable to the caller unless it is echoed. Injecting
    it here — once, before the graph is built — keeps both facts true: the graph
    still sees a fresh seed per request, and the caller can reproduce the render.
    Every other lane, and any explicit seed, is passed through untouched.
    """
    if model not in QWEN_21_MODELS:
        return payload, None
    import secrets

    copied = dict(payload)
    seed = copied["seed"] if "seed" in copied else secrets.randbits(53)
    if type(seed) is not int or not 0 <= seed < 2**53:
        raise bad_request("seed must be an integer between 0 and 2^53-1", "invalid_seed")
    copied["seed"] = seed
    return copied, {"seed": seed, "seed_source": "explicit" if "seed" in payload else "random"}


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
