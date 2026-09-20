"""Bounded request reading and validation."""

from __future__ import annotations

import base64
import binascii
import io
import json
import re
import uuid

from errors import bad_request, rejected

# Server-side ceilings. No request field can raise these.
MAX_BODY_BYTES = 16 * 1024 * 1024  # 16 MiB streaming body cap
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MiB decoded inline image
MAX_IMAGE_AXIS = 4096
MAX_IMAGE_AREA = 16 * 1024 * 1024  # 16 MPixel

_DATA_URI_RE = re.compile(
    r"^data:(image/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$",
    re.IGNORECASE | re.DOTALL,
)
_SAFE_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


async def read_json_body(request) -> dict:
    """Stream the request body, refusing anything over the cap."""
    total = bytearray()
    async for chunk in request.stream():
        if len(total) + len(chunk) > MAX_BODY_BYTES:
            raise bad_request(f"Request body exceeds the {MAX_BODY_BYTES // (1024 * 1024)} MiB limit.", "body_too_large")
        total.extend(chunk)
    if not total:
        return {}
    try:
        parsed = json.loads(total.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise bad_request("Request body must be valid JSON.", "invalid_json")
    if not isinstance(parsed, dict):
        raise bad_request("Request body must be a JSON object.", "invalid_json")
    return parsed


def validate_model(payload: dict, models: dict) -> str:
    model = payload.get("model")
    if not isinstance(model, str) or not model:
        raise bad_request("Field 'model' is required.", "missing_model")
    if model not in models:
        from errors import unsupported_model

        raise unsupported_model(model, sorted(models))
    return model


def validate_response_format(payload: dict, allowed_from: tuple[str, ...]) -> None:
    value = payload.get("response_format")
    if value is None:
        return
    if not isinstance(value, str) or value not in allowed_from:
        raise rejected(
            "Unsupported response_format; supported values are " + ", ".join(sorted(allowed_from)) + ".",
            "unsupported_response_format",
        )


def image_filename() -> str:
    """Server-generated random safe basename for uploads."""
    return f"lloom-{uuid.uuid4().hex}.png"


def decode_inline_image(payload: dict) -> tuple[bytes, str, str] | None:
    """Decode an optional bounded inline data-URI image.

    Only PNG/JPEG data URIs are accepted. URLs, filesystem paths, bare base64
    blobs and every other encoding are rejected outright.
    """
    return decode_data_uri(payload, "image")


def decode_last_frame(payload: dict) -> tuple[bytes, str, str] | None:
    """Decode the optional end-frame image, used to pin where a clip lands."""
    return decode_data_uri(payload, "last_frame")


# Audio conditioning: a real clip can drive the LTX audio latent and supply a
# timbre reference. Bounded like images, with its own media types and caps.
MAX_AUDIO_BYTES = 16 * 1024 * 1024
_AUDIO_URI_RE = re.compile(
    r"^data:(audio/(?:wav|x-wav|wave|flac|mpeg|mp3));base64,([A-Za-z0-9+/=\s]+)$",
    re.IGNORECASE | re.DOTALL,
)
_AUDIO_SUFFIX = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/flac": "flac",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
}


def decode_audio(payload: dict) -> tuple[bytes, str, str] | None:
    """Decode an optional bounded inline audio data URI.

    Drives audio-to-video: the clip's latent replaces the generated one and its
    timbre conditions the model. Only inline data URIs are accepted; URLs and
    filesystem paths are refused, as with images.
    """
    raw = payload.get("audio")
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw:
        raise rejected("Field 'audio' must be an inline audio data URI.", "invalid_audio")
    if not raw.lower().startswith("data:"):
        raise rejected(
            "Field 'audio' must be an inline data URI; URLs and file paths are not accepted.",
            "invalid_audio",
        )
    match = _AUDIO_URI_RE.match(raw)
    if not match:
        raise rejected("Field 'audio' must be a base64 WAV, FLAC or MP3 data URI.", "invalid_audio")
    mime = match.group(1).lower()
    encoded = match.group(2)
    suffix = _AUDIO_SUFFIX.get(mime, "wav")
    if len(encoded) > (MAX_AUDIO_BYTES * 4) // 3 + 16:
        raise bad_request("Inline audio exceeds the 16 MiB limit.", "audio_too_large")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise rejected("Inline audio is not valid base64.", "invalid_audio")
    if len(data) > MAX_AUDIO_BYTES:
        raise bad_request("Inline audio exceeds the 16 MiB limit.", "audio_too_large")
    check_audio(data, suffix)
    return data, mime, suffix


def check_audio(data: bytes, suffix: str) -> None:
    """Confirm the bytes really are audio of the declared kind.

    A declared MIME type is not evidence, so the container magic is checked. A
    mislabelled payload would otherwise surface as a decode failure inside the
    graph, after the GPU has been committed.
    """
    head = data[:12]
    ok = False
    if suffix == "wav":
        ok = head[:4] == b"RIFF" and head[8:12] == b"WAVE"
    elif suffix == "flac":
        ok = head[:4] == b"fLaC"
    elif suffix == "mp3":
        ok = head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)
    if not ok:
        raise rejected("Inline audio does not match its declared format.", "invalid_audio")


def decode_data_uri(payload: dict, field: str) -> tuple[bytes, str, str] | None:
    """Decode one bounded inline PNG/JPEG data URI from ``field``.

    ``image`` and ``last_frame`` are separate fields rather than one list so a
    request that only needs a first frame keeps the original contract.
    """
    raw = payload.get(field)
    if raw is None:
        return None
    if not isinstance(raw, str) or not raw:
        raise rejected(f"Field '{field}' must be an inline PNG or JPEG data URI.", "invalid_image")
    if not raw.lower().startswith("data:"):
        raise rejected(f"Field '{field}' must be an inline data URI; URLs and file paths are not accepted.", "invalid_image")
    match = _DATA_URI_RE.match(raw)
    if not match:
        raise rejected(f"Field '{field}' must be a base64 PNG or JPEG data URI.", "invalid_image")
    mime = match.group(1).lower()
    encoded = match.group(2)
    if len(encoded) > (MAX_IMAGE_BYTES * 4) // 3 + 16:
        raise bad_request(f"Inline image in '{field}' exceeds the 8 MiB limit.", "image_too_large")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise rejected(f"Inline image in '{field}' is not valid base64.", "invalid_image")
    if len(data) > MAX_IMAGE_BYTES:
        raise bad_request(f"Inline image in '{field}' exceeds the 8 MiB limit.", "image_too_large")
    check_image(data)
    canonical = "image/png" if mime == "image/png" else "image/jpeg"
    return data, canonical, "png" if canonical == "image/png" else "jpg"


def check_image(data: bytes) -> None:
    """Inspect dimensions header-only, before fully decoding pixels."""
    from PIL import Image

    try:
        with Image.open(io.BytesIO(data)) as probe:
            fmt = (probe.format or "").upper()
            width, height = probe.size
    except Exception:
        raise rejected("Inline image could not be decoded as PNG or JPEG.", "invalid_image")
    if fmt not in ("PNG", "JPEG"):
        raise rejected("Inline image must be PNG or JPEG.", "invalid_image")
    if width <= 0 or height <= 0:
        raise rejected("Inline image has invalid dimensions.", "invalid_image")
    if width > MAX_IMAGE_AXIS or height > MAX_IMAGE_AXIS or width * height > MAX_IMAGE_AREA:
        raise bad_request("Inline image dimensions exceed the allowed limits.", "image_too_large")


def safe_prefix(prefix: str | None) -> str:
    if prefix is None:
        return "lloom"
    if not isinstance(prefix, str) or not _SAFE_NAME_RE.match(prefix):
        return "lloom"
    return prefix


def non_negative_int(payload: dict, field: str, *, default: int | None, maximum: int) -> int | None:
    value = payload.get(field)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise bad_request(f"Field '{field}' must be an integer.", "invalid_field")
    if value < 0 or value > maximum:
        raise bad_request(f"Field '{field}' is out of range.", "invalid_field")
    return value


def validate_bounded_text(payload: dict, field: str, maximum: int, *, required: bool = False) -> str | None:
    """Bound an optional free-form text field before it reaches the graph.

    Oversized or mistyped text is a client error (400); the ceiling is
    server-side and no request body can raise it. Must be called before any
    ComfyUI interaction so a rejected request never reaches the GPU.
    """
    value = payload.get(field)
    if value is None:
        if required:
            raise bad_request(f"Field '{field}' is required.", "missing_field")
        return None
    if not isinstance(value, str):
        raise bad_request(f"Field '{field}' must be a string.", "invalid_field")
    if len(value) > maximum:
        raise bad_request(f"Field '{field}' is too long.", "invalid_field")
    return value
