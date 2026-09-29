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
MAX_BODY_BYTES = 48 * 1024 * 1024  # 48 MiB streaming body cap
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MiB decoded inline image
MAX_IMAGE_AXIS = 4096
MAX_IMAGE_AREA = 16 * 1024 * 1024  # 16 MPixel
# Native Qwen-Image 2.1 advertises up to 10 references; this backend's Qwen 2.1
# lane composites exactly one, so a second reference is refused with a reason.
MAX_MULTIPART_IMAGES = 1
NATIVE_MAX_MULTIPART_IMAGES = 10
# Bounded multipart surface. A JSON scalar field is small by definition; a large
# part is either an upload under the wrong name or an attempt to hold memory.
MAX_MULTIPART_FIELD_BYTES = 8192
MAX_MULTIPART_PARTS = 64

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
    """Bound geometry, then verify and decode a single PNG/JPEG frame."""
    from PIL import Image
    from errors import BridgeError
    try:
        with Image.open(io.BytesIO(data)) as probe:
            fmt = (probe.format or "").upper()
            width, height = probe.size
            if fmt not in ("PNG", "JPEG"):
                raise rejected("Inline image must be PNG or JPEG.", "invalid_image")
            if width <= 0 or height <= 0:
                raise rejected("Inline image has invalid dimensions.", "invalid_image")
            if width > MAX_IMAGE_AXIS or height > MAX_IMAGE_AXIS or width * height > MAX_IMAGE_AREA:
                raise bad_request("Inline image dimensions exceed the allowed limits.", "image_too_large")
            if getattr(probe, "n_frames", 1) != 1:
                raise rejected("Animated reference images are unsupported.", "invalid_image")
            probe.verify()
        with Image.open(io.BytesIO(data)) as decoded:
            decoded.load()
    except BridgeError:
        raise
    except Exception:
        raise rejected("Inline image could not be decoded as PNG or JPEG.", "invalid_image") from None


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


async def read_multipart_form(request):
    """Bound the complete body before parsing and close every upload afterward."""
    from starlette.formparsers import MultiPartParser, MultiPartException
    from starlette.datastructures import UploadFile
    total = bytearray()
    async for chunk in request.stream():
        if len(total) + len(chunk) > MAX_BODY_BYTES:
            raise bad_request("Request body exceeds the 48 MiB limit.", "body_too_large")
        total.extend(chunk)
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "multipart/form-data":
        raise bad_request("Image editing requires multipart/form-data.", "invalid_content_type")
    async def stream():
        yield bytes(total)
    try:
        form = await MultiPartParser(request.headers, stream(), max_files=12,
                                     max_fields=32, max_part_size=MAX_MULTIPART_FIELD_BYTES).parse()
    except (MultiPartException, ValueError):
        raise bad_request("Malformed multipart request body.", "invalid_body") from None
    try:
        fields, uploads, counts = {}, {}, {}
        for name, part in form.multi_items():
            counts[name] = counts.get(name, 0) + 1
            if isinstance(part, UploadFile):
                data = await part.read(MAX_IMAGE_BYTES + 1)
                if len(data) > MAX_IMAGE_BYTES:
                    raise bad_request("The reference image exceeds the 8 MiB limit.", "image_too_large")
                uploads[name] = (part.filename, part.content_type or "", data)
            else:
                fields[name] = part
        return fields, uploads, counts
    finally:
        await form.close()


def multipart_scalar(fields: dict, counts: dict, name: str, *, maximum: int = MAX_MULTIPART_FIELD_BYTES):
    """Return one raw scalar text value, rejecting duplicates and oversize parts."""
    seen = counts.get(name, 0)
    if seen > 1:
        raise bad_request(f"Field '{name}' was supplied more than once.", "duplicate_field")
    if not seen:
        return None
    value = fields.get(name)
    if value is None or len(value.encode("utf-8")) > maximum:
        raise bad_request(f"Field '{name}' is too large.", "invalid_field")
    return value


def multipart_numeric(fields: dict, counts: dict, name: str, *, integer: bool = False):
    """Convert one native-shaped multipart scalar to the number its JSON twin takes.

    Native ComfyUI sends every multipart scalar as text, while a JSON caller
    sends an int or float, so the conversion happens here. An unparsable or
    non-finite value is a 400 rather than a value silently coerced to zero;
    booleans and fractional integers are refused exactly as the JSON path does.
    """
    raw = multipart_scalar(fields, counts, name)
    if raw is None:
        return None
    text = raw.strip()
    if not text or text.lower() in ("true", "false", "none", "null", "nan", "inf", "-inf", "+inf"):
        raise bad_request(f"Field '{name}' must be {'an integer' if integer else 'a number'}.", "invalid_field")
    try:
        value = float(text)
    except ValueError:
        raise bad_request(f"Field '{name}' must be {'an integer' if integer else 'a number'}.", "invalid_field") from None
    import math

    if not math.isfinite(value):
        raise bad_request(f"Field '{name}' must be a finite number.", "invalid_field")
    if integer:
        try:
            as_int = int(text)
        except ValueError:
            raise bad_request(f"Field '{name}' must be an integer.", "invalid_field") from None
        if float(as_int) != value:
            raise bad_request(f"Field '{name}' must be an integer.", "invalid_field")
        return as_int
    return value


# Declared types clients actually send for the two formats this decoder accepts.
# The bytes still have to prove themselves; a declaration only has to not
# contradict them, and an explicit mismatch is refused rather than relabelled.
_UPLOAD_MIME_SUFFIX = {
    "image/png": "png",
    "image/x-png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/pjpeg": "jpg",
    "application/octet-stream": None,
    "binary/octet-stream": None,
    "": None,
}
_UPLOAD_SUFFIX_MIME = {"png": "image/png", "jpg": "image/jpeg"}


def check_uploaded_image(data: bytes, mime: str, filename: str) -> str:
    """Validate uploaded bytes and return the canonical MIME type."""
    declared = (mime or "").split(";")[0].strip().lower()
    if declared not in _UPLOAD_MIME_SUFFIX:
        raise rejected(
            "The reference image must be a PNG or JPEG file part; "
            f"declared type {declared or 'none'!r} is not accepted.",
            "invalid_image",
        )
    check_image(data)
    actual = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpg"
    if _UPLOAD_MIME_SUFFIX[declared] not in (None, actual):
        raise rejected("The reference image does not match its declared MIME type.", "invalid_image")
    if filename and not isinstance(filename, str):
        raise rejected("The reference image filename must be text.", "invalid_image")
    return _UPLOAD_SUFFIX_MIME[actual]


def multipart_reference_images(uploads: dict, counts: dict) -> tuple[bytes, str, str]:
    """Validate exactly one uploaded reference image from ``image``/``image[]``.

    Only PNG/JPEG bytes are accepted, checked with the same decoder the inline
    JSON path uses, so size and dimensions are bounded identically. Nothing can
    name a URL or a server path: the file part's own bytes are the only input and
    its client filename is never used.
    """
    if counts.get("image", 0) > 1:
        raise bad_request("Field 'image' was supplied more than once.", "duplicate_field")
    if "image" in counts and "image[]" in counts:
        raise bad_request("Supply reference images as either 'image' or 'image[]', not both.", "duplicate_field")
    name = "image[]" if "image[]" in counts else ("image" if "image" in counts else None)
    if name is None:
        raise bad_request("Image editing requires one reference image.", "missing_image")
    if counts[name] > MAX_MULTIPART_IMAGES:
        raise bad_request(
            "This backend supports one reference image per edit; native Diffusers supports up to "
            f"{NATIVE_MAX_MULTIPART_IMAGES}. Send a single 'image' part.",
            "too_many_images",
        )
    uploaded = uploads.get(name)
    if uploaded is None:
        # A non-file part named "image" is not an upload, however it is typed.
        raise rejected("Field 'image' must be an uploaded PNG or JPEG file part.", "invalid_image")
    filename, mime, data = uploaded
    if not data:
        raise rejected("The reference image is empty.", "invalid_image")
    if len(data) > MAX_IMAGE_BYTES:
        raise bad_request("The reference image exceeds the 8 MiB limit.", "image_too_large")
    canonical = check_uploaded_image(data, mime, filename)
    return data, canonical, "png" if canonical == "image/png" else "jpg"


def fit_ltx_audio(audio, payload):
    """Keep driving samples, trim/pad to the requested video grid, duplicate mono."""
    import math
    import numpy as np
    import soundfile as sf
    from graphs import frame_count, number
    try:
        duration = number(payload, "duration", 5, 1, 10)
        frames = frame_count(payload, math.ceil(duration * 24 / 8) * 8 + 1, 25, 241, 8, 1)
        with sf.SoundFile(io.BytesIO(audio[0])) as source:
            if not (8000 <= source.samplerate <= 192000 and source.channels in (1, 2)):
                raise ValueError("audio must be mono/stereo at 8-192 kHz")
            count = math.ceil(frames / 24 * source.samplerate)
            samples = source.read(frames=count, dtype="float32", always_2d=True)
            rate = source.samplerate
        if not len(samples) or not np.isfinite(samples).all():
            raise ValueError("audio must contain finite samples")
        if samples.shape[1] == 1:
            samples = np.repeat(samples, 2, axis=1)
        samples = np.pad(samples, ((0, max(0, count - len(samples))), (0, 0)))
        output = io.BytesIO()
        sf.write(output, samples, rate, format="WAV", subtype="FLOAT")
        return output.getvalue(), "audio/wav", "wav"
    except (ValueError, RuntimeError, sf.LibsndfileError) as exc:
        raise bad_request("Invalid LTX driving audio: " + str(exc), "invalid_audio") from None
