#!/usr/bin/env python3
"""Native LTX-2.5 pipeline selection, request validation and argv assembly.

This module deliberately imports nothing from torch, FastAPI or the LTX runtime:
request validation, media decoding and subprocess argv construction can all be
exercised on CPU without a GPU, a checkpoint or the serving stack. The gateway
model ID in a request selects exactly one pinned official ``ltx_pipelines``
entry point from the table below; callers can never name a module, a script or a
filesystem path.

Reference: Lightricks LTX-2 v1.3.0, commit
``598ab41247a77dbfe29b5186e915bcf4f9040ec7``. Every flag emitted here is taken
from that revision's argparse surface
(``packages/ltx-pipelines/src/ltx_pipelines/utils/args.py`` and the per-pipeline
``main()`` parsers); the split component filenames match the repository README.
"""
from __future__ import annotations

import argparse
import base64
import json
import io
import re
import sys
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

UPSTREAM_REPO = "https://github.com/Lightricks/LTX-2.git"
UPSTREAM_COMMIT = "598ab41247a77dbfe29b5186e915bcf4f9040ec7"
UPSTREAM_VERSION = "1.3.0"

# ---------------------------------------------------------------------------
# Body / media ceilings. Still images and (for A2V) the driving audio are
# conditioners carried inline, so the request budget only has to fit them.
# ---------------------------------------------------------------------------
MAX_BODY = 64 * 1024 * 1024
MAX_IMAGE_BYTES = 16 * 1024 * 1024
MAX_AUDIO_BYTES = 48 * 1024 * 1024
MAX_KEYFRAMES = 8
MAX_PROMPT_CHARS = 32768
MAX_NEGATIVE_CHARS = 8192
MAX_IMAGE_PIXELS = 4096 * 4096
MAX_AUDIO_SECONDS = 600.0

# ---------------------------------------------------------------------------
# Geometry ceilings. These are explicit and modest on purpose: two-stage LTX
# runs stage 2 at the requested output resolution while holding a 22B
# transformer plus the Gemma text encoder resident, so a 4K*4K canvas is not a
# request this backend will admit on a 128 GiB unified-memory host. The area
# ceiling and the per-axis ceiling are both enforced, and callers cannot widen
# them from a request. num_frames is 8*k + 1 (the temporal grid the model was
# trained on).
# ---------------------------------------------------------------------------
MIN_DIMENSION = 64
MAX_DIMENSION = 2048
DIMENSION_STEP = 64
MAX_PIXELS = 1920 * 1088  # 2_088_960, roughly 1080p-class two-stage canvas
MIN_FRAMES = 9
MAX_FRAMES = 8 * 60 + 1  # 481 frames (~20 s at 24 fps)
MIN_FRAME_RATE = 1.0
MAX_FRAME_RATE = 60.0
MIN_DURATION = 0.25
MAX_DURATION = 20.0
MIN_STEPS = 1
MAX_STEPS = 100
MIN_SEED = 0
MAX_SEED = 2**63 - 1

IMAGE_DATA_RE = re.compile(r"^data:image/(png|jpeg);base64,(?P<data>[A-Za-z0-9+/=\s]+)$")
AUDIO_DATA_RE = re.compile(r"^data:audio/(?:x-)?(wav|flac);base64,(?P<data>[A-Za-z0-9+/=\s]+)$")
SIZE_RE = re.compile(r"^\s*(\d{1,5})\s*[xX\u00d7]\s*(\d{1,5})\s*$")

OFFLOAD_MODES = ("none", "cpu", "disk")
QUANTIZATION_POLICIES = ("fp8-cast", "fp8-scaled-mm", "nvfp4-cast", "nvfp4-prequant")
RESPONSE_FORMATS = ("b64_json",)

# ---------------------------------------------------------------------------
# Split component filenames, relative to the configured MODEL_ROOT. These are
# the exact names published by Lightricks/LTX-2.5, plus the separate detailing
# IC-LoRA repository
# Lightricks/LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler
# (revision 380e63e764cad353c47a8e7c9c7ad6095d25e814). No request may override
# them.
# ---------------------------------------------------------------------------
MODEL_FILES = {
    "dev_transformer": "diffusion_models/ltx-2.5-22b-dev-transformer-bf16.safetensors",
    "distilled_transformer": "diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors",
    "text_encoder": "text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",
    "video_vae": "vae/ltx-2.5-video-vae-bf16.safetensors",
    "audio_vae": "vae/ltx-2.5-audio-vae-bf16.safetensors",
    "spatial_upsampler": "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
    "temporal_upsampler": "latent_upscale_models/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors",
    "distilled_lora": "loras/ltx-2.5-22b-distilled-lora-450-bf16.safetensors",
    "detailing_lora": "loras/ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors",
}

# Optional components: present in the download set but not required to serve.
# The Gemma text encoder is a packed BF16 single file with embedded tokenizer
# and sidecars (``gemma_assets.py``), so no extra online tokenizer download is
# required at inference.
OPTIONAL_FILES = {
    "duration_head": "model_patches/ltx-2.5-duration-head-bf16.safetensors",
    "video_vae_conv": "vae/ltx-2.5-video-vae-conv-bf16.safetensors",
}

# Fixed baseline assets shared by every pipeline.
_BASE_ASSETS = ("text_encoder", "video_vae", "audio_vae", "spatial_upsampler")

# Generous ceilings for a serialized, single-flight generation.
DEFAULT_TIMEOUT_SECONDS = 1800.0


def _pipeline(module, title, transformer, *, assets=(), **flags):
    spec = {
        "module": module,
        "title": title,
        "transformer": transformer,
        "assets": tuple(assets),
        "supports_negative_prompt": False,
        "supports_guidance": False,
        "supports_steps": False,
        "supports_generated_keyframes": False,
        "accepts_audio": False,
        "accepts_video": False,
        "requires_audio": False,
        "supports_temporal_upscalings": False,
        "default_width": 832,
        "default_height": 512,
        "default_num_frames": 121,
        "default_frame_rate": 24.0,
        "default_seed": 0,
    }
    spec.update(flags)
    return spec


# Public gateway model ID -> workflow name -> official pipeline spec. The model
# ID plus the explicit ``workflow`` request field are the only selectors; no
# hidden compatibility IDs or aliases exist. ``generate`` is the default
# workflow for each model when ``workflow`` is absent. Each value is the
# original per-pipeline spec (:func:`_pipeline`) with its module, transformer,
# assets and capability flags unchanged, so per-workflow validation and
# inference behaviour are preserved exactly.
PIPELINES = {
    "Lightricks/LTX-2.5-Full": {
        "generate": _pipeline(
            "ltx_pipelines.ti2vid_two_stages",
            "LTX-2.5 Full (guided two-stage generate)",
            "dev_transformer",
            assets=("distilled_lora",),
            supports_negative_prompt=True,
            supports_guidance=True,
            supports_steps=True,
            supports_generated_keyframes=True,
            default_steps=30,
        ),
        "generate-hq": _pipeline(
            "ltx_pipelines.ti2vid_two_stages_hq",
            "LTX-2.5 Full (res_2s guided two-stage generate-hq)",
            "dev_transformer",
            assets=("distilled_lora",),
            supports_negative_prompt=True,
            supports_guidance=True,
            supports_steps=True,
            supports_generated_keyframes=True,
            default_steps=15,
        ),
        "audio-to-video": _pipeline(
            "a2v",
            "LTX-2.5 Full (native ancestral audio-to-video, frozen audio)",
            "dev_transformer",
            assets=("distilled_lora",),
            supports_negative_prompt=True,
            supports_guidance=True,
            supports_steps=True,
            accepts_audio=True,
            requires_audio=True,
            default_steps=30,
        ),
        "keyframes": _pipeline(
            "ltx_pipelines.keyframe_interpolation",
            "LTX-2.5 Full (native keyframe interpolation)",
            "dev_transformer",
            assets=("distilled_lora",),
            supports_negative_prompt=True,
            supports_guidance=True,
            supports_steps=True,
            default_steps=30,
        ),
    },
    "Lightricks/LTX-2.5-Distilled": {
        "generate": _pipeline(
            "ltx_pipelines.distilled",
            "LTX-2.5 Distilled (native BF16 fast generate)",
            "distilled_transformer",
            supports_generated_keyframes=True,
        ),
        "retake": _pipeline(
            "ltx_pipelines.retake",
            "LTX-2.5 Distilled (retake an existing video interval)",
            "distilled_transformer",
            accepts_video=True,
        ),
        "refine": _pipeline(
            "ltx_pipelines.dfr_pipeline",
            "LTX-2.5 Distilled (production refine/detailing)",
            "distilled_transformer",
            assets=("detailing_lora",),
            supports_temporal_upscalings=True,
        ),
    },
}

DEFAULT_WORKFLOW = "generate"
MODEL_ID_LIST = tuple(PIPELINES)


class ApiError(Exception):
    """A client-visible request error; carries an HTTP status and a short code."""

    def __init__(self, message, code="invalid_request", status=400):
        super().__init__(message)
        self.message, self.code, self.status = message, code, status


def required_assets(spec, temporal_upscalings=0):
    """Return the (relative) component paths a pipeline run needs."""
    assets = [spec["transformer"], *[key for key in _BASE_ASSETS if key != "spatial_upsampler" or not spec["accepts_video"]], *spec["assets"]]
    if spec["supports_temporal_upscalings"] and temporal_upscalings > 0:
        assets.append("temporal_upsampler")
    return tuple(dict.fromkeys(assets))


def resolve_assets(model_root, spec, temporal_upscalings=0):
    """Map required component keys to absolute paths, or raise if any is absent."""
    root = Path(model_root)
    # Recipe downloads use one directory per upstream repository. Also accept
    # an explicitly configured flat component pack for existing installations.
    pack = root / "Lightricks--LTX-2.5"
    if not pack.is_dir():
        pack = root
    resolved = {}
    missing = []
    for key in required_assets(spec, temporal_upscalings):
        path = pack / MODEL_FILES[key]
        if key == "detailing_lora" and not path.is_file():
            path = root / "Lightricks--LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler" / Path(MODEL_FILES[key]).name
        if not path.is_file():
            missing.append(str(path))
        resolved[key] = path
    if missing:
        raise ApiError(
            "Missing model components under MODEL_ROOT: " + ", ".join(missing),
            "model_unavailable",
            503,
        )
    return resolved


# ---------------------------------------------------------------------------
# Media decoding. Base64 alone is not enough: an inline PNG/JPEG must parse as
# a real image of a bounded size, and a WAV/FLAC must parse as real audio, all
# before any process is spawned.
# ---------------------------------------------------------------------------
def _decode_image(raw, field):
    """Return ``(format, width, height)`` for a raw PNG or JPEG payload."""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        if len(raw) < 33 or raw[12:16] != b"IHDR":
            raise ApiError(f"{field} is not a valid PNG image")
        width = int.from_bytes(raw[16:20], "big")
        height = int.from_bytes(raw[20:24], "big")
        fmt = "png"
    elif raw.startswith(b"\xff\xd8"):
        width = height = 0
        index = 2
        while index + 4 <= len(raw):
            if raw[index] != 0xFF:
                index += 1
                continue
            marker = raw[index + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                index += 2
                continue
            if marker == 0xD9:
                break
            segment = int.from_bytes(raw[index + 2:index + 4], "big")
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                if index + 9 > len(raw):
                    raise ApiError(f"{field} is not a valid JPEG image")
                height = int.from_bytes(raw[index + 5:index + 7], "big")
                width = int.from_bytes(raw[index + 7:index + 9], "big")
                break
            index += 2 + segment
        if not width or not height:
            raise ApiError(f"{field} is not a valid JPEG image")
        fmt = "jpeg"
    else:
        raise ApiError(f"{field} is not a PNG or JPEG image")
    if width < 1 or height < 1:
        raise ApiError(f"{field} has an invalid image size")
    if width * height > MAX_IMAGE_PIXELS:
        raise ApiError(f"{field} exceeds {MAX_IMAGE_PIXELS} pixels", "body_too_large", 413)
    try:
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as image:
            image.verify()
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
    except Exception as exc:
        raise ApiError(f"{field} is not a valid {fmt.upper()} image") from exc
    return fmt, width, height


def _decode_wav(raw, field):
    if raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ApiError(f"{field} is not a valid WAV file")
    index = 12
    fmt = None
    data_len = None
    while index + 8 <= len(raw):
        chunk = raw[index:index + 4]
        size = int.from_bytes(raw[index + 4:index + 8], "little")
        body = index + 8
        if body + size > len(raw):
            raise ApiError(f"{field} has a truncated WAV chunk")
        if chunk == b"fmt ":
            if size < 16 or body + 16 > len(raw):
                raise ApiError(f"{field} has a truncated WAV format chunk")
            channels = int.from_bytes(raw[body + 2:body + 4], "little")
            sample_rate = int.from_bytes(raw[body + 4:body + 8], "little")
            bits = int.from_bytes(raw[body + 14:body + 16], "little")
            fmt = (channels, sample_rate, bits)
        elif chunk == b"data":
            data_len = size
        index = body + size + (size & 1)
    if fmt is None or data_len is None:
        raise ApiError(f"{field} is missing WAV format/data chunks")
    channels, sample_rate, bits = fmt
    if channels < 1 or sample_rate < 1 or bits < 8:
        raise ApiError(f"{field} has an unsupported WAV layout")
    duration = data_len / (sample_rate * channels * (bits // 8))
    return {"format": "wav", "channels": channels, "sample_rate": sample_rate,
            "bits": bits, "duration": duration}


def _decode_flac(raw, field):
    if raw[:4] != b"fLaC":
        raise ApiError(f"{field} is not a valid FLAC file")
    index = 4
    while index + 4 <= len(raw):
        header = raw[index]
        last = bool(header & 0x80)
        block_type = header & 0x7F
        length = int.from_bytes(raw[index + 1:index + 4], "big")
        body = raw[index + 4:index + 4 + length]
        if block_type == 0:  # STREAMINFO
            if length < 34:
                raise ApiError(f"{field} has a truncated FLAC STREAMINFO block")
            packed = int.from_bytes(body[10:18], "big")
            sample_rate = (packed >> 44) & 0xFFFFF
            channels = ((packed >> 41) & 0x7) + 1
            bits = ((packed >> 36) & 0x1F) + 1
            total_samples = packed & 0xFFFFFFFFF
            if sample_rate < 1:
                raise ApiError(f"{field} has an invalid FLAC sample rate")
            duration = total_samples / sample_rate if total_samples else None
            return {"format": "flac", "channels": channels, "sample_rate": sample_rate,
                    "bits": bits, "duration": duration}
        if last:
            break
        index += 4 + length
    raise ApiError(f"{field} is missing a FLAC STREAMINFO block")


def decode_audio(raw, audio_format, field):
    """Return decoded audio facts for a raw WAV/FLAC payload."""
    if audio_format == "wav":
        info = _decode_wav(raw, field)
    elif audio_format == "flac":
        info = _decode_flac(raw, field)
    else:
        raise ApiError(f"{field} must be WAV or FLAC")
    if info["duration"] is not None and info["duration"] > MAX_AUDIO_SECONDS:
        raise ApiError(f"{field} exceeds {MAX_AUDIO_SECONDS} seconds", "body_too_large", 413)
    try:
        import soundfile as sf
        with sf.SoundFile(io.BytesIO(raw)) as audio:
            if audio.channels not in (1, 2) or not 8000 <= audio.samplerate <= 192000:
                raise ApiError(f"{field} must have 1-2 channels and an 8-192 kHz sample rate")
            if audio.frames <= 0 or audio.frames / audio.samplerate > MAX_AUDIO_SECONDS:
                raise ApiError(f"{field} has an invalid audio duration")
            count = 0
            for block in audio.blocks(blocksize=16384, dtype="float32"):
                count += len(block)
            if count != audio.frames:
                raise ApiError(f"{field} contains truncated audio")
            if info["duration"] is not None and abs(count / audio.samplerate - info["duration"]) > 1 / audio.samplerate:
                raise ApiError(f"{field} contains truncated audio")
            info["duration"] = count / audio.samplerate
    except ApiError:
        raise
    except Exception as exc:
        raise ApiError(f"{field} is not a valid {audio_format.upper()} file") from exc
    return info


def _optional_bool(payload, field):
    value = payload.get(field)
    if value is None:
        return None
    if not isinstance(value, bool):
        raise ApiError(f"{field} must be a boolean")
    return value


def _number(payload, field, low, high, cast, default=None):
    value = payload.get(field)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise ApiError(f"{field} must be a number between {low} and {high}")
    return cast(value)


def _integer(payload, field, low, high, default=None):
    value = payload.get(field)
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ApiError(f"{field} must be an integer between {low} and {high}")
    return value


def _decode_data_uri(value, pattern, field, limit, label):
    if not isinstance(value, str):
        raise ApiError(f"{field} must be an inline data URI string")
    match = pattern.match(value.strip())
    if not match:
        raise ApiError(f"{field} must be a base64 {label} data URI")
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", match.group("data")), validate=True)
    except (ValueError, base64.binascii.Error) as exc:  # type: ignore[attr-defined]
        raise ApiError(f"{field} is not valid base64") from exc
    if not raw:
        raise ApiError(f"{field} decoded to zero bytes")
    if len(raw) > limit:
        raise ApiError(f"{field} exceeds {limit} bytes", "body_too_large", 413)
    return raw, match.group(1)


def _frames_from_duration(duration, frame_rate):
    target = int(round(duration * frame_rate))
    # Nearest 8*k + 1 (k >= 1): the temporal compression the model was trained on.
    k = max(1, int(round((target - 1) / 8)))
    frames = 8 * k + 1
    if not MIN_FRAMES <= frames <= MAX_FRAMES:
        raise ApiError(
            f"duration {duration} at {frame_rate} fps is outside the supported range"
        )
    return frames


def normalize_prompt(value):
    """Turn explicit structured instructions into readable text, without dropping keys."""
    if isinstance(value, str):
        return value
    if not isinstance(value, dict) or not value:
        raise ApiError("prompt must be a non-empty string or structured object")
    allowed = {"description", "subject", "action", "camera", "lighting", "environment", "style", "dialogue", "motion", "audio", "timeline"}
    unknown = set(value) - allowed
    if unknown:
        raise ApiError("Unsupported structured prompt fields: " + ", ".join(sorted(unknown)))
    lines = []
    for key, item in value.items():
        if not isinstance(item, (str, list, dict)) or not item:
            raise ApiError(f"prompt.{key} must be non-empty text, a list, or an object")
        rendered = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
        lines.append(key.replace("_", " ").capitalize() + ": " + rendered)
    return "\n".join(lines)


def decode_video(value):
    pattern = re.compile(r"^data:(video/mp4);base64,(?P<data>[A-Za-z0-9+/=\s]+)$")
    raw, _ = _decode_data_uri(value, pattern, "video", 32 * 1024 * 1024, "MP4")
    if len(raw) < 12 or raw[4:8] != b"ftyp":
        raise ApiError("video must be an MP4 file")
    try:
        with tempfile.TemporaryDirectory(prefix="lltx-probe-") as folder:
            path = Path(folder) / "input.mp4"
            path.write_bytes(raw)
            probe = subprocess.run(["ffprobe", "-v", "error", "-f", "mov", "-count_frames", "-show_entries", "stream=codec_type,channels,width,height,avg_frame_rate,r_frame_rate,nb_read_frames,duration", "-of", "json", str(path)], capture_output=True, text=True, timeout=20, check=True)
            streams = json.loads(probe.stdout)["streams"]
            stream = next(s for s in streams if s["codec_type"] == "video")
            width, height = int(stream["width"]), int(stream["height"])
            frames = int(stream["nb_read_frames"])
            fps = float(Fraction(stream["avg_frame_rate"]))
            if not (64 <= width <= MAX_DIMENSION and 64 <= height <= MAX_DIMENSION and width * height <= MAX_PIXELS and width % 32 == 0 and height % 32 == 0):
                raise ApiError("retake video dimensions must be bounded multiples of 32")
            if not fps.is_integer() or Fraction(stream["r_frame_rate"]) != Fraction(stream["avg_frame_rate"]):
                raise ApiError("Retake requires a constant integer frame rate (for example 24 or 30 fps)")
            if not (MIN_FRAMES <= frames <= MAX_FRAMES and (frames - 1) % 8 == 0 and 1 <= fps <= 60 and (frames - 1) / fps <= MAX_DURATION):
                raise ApiError("retake video needs 8k+1 frames, at most 20 seconds and 1-60 fps")
            # Decode the full accepted clip so malformed packets fail before GPU admission.
            subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-f", "mov", "-i", str(path), "-f", "null", "-"], capture_output=True, timeout=30, check=True)
            audio = next((s for s in streams if s["codec_type"] == "audio"), None)
            if audio and audio.get("channels") != 2:
                normalized = Path(folder) / "stereo.mp4"
                subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(path), "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-ac", "2", "-c:a", "aac", "-b:a", "192k", "-t", str(frames / fps), str(normalized)], capture_output=True, timeout=30, check=True)
                if normalized.stat().st_size > 33 * 1024 * 1024:
                    raise ApiError("normalized retake video exceeds the size limit")
                raw = normalized.read_bytes()
    except ApiError:
        raise
    except (ValueError, StopIteration, ZeroDivisionError, KeyError, IndexError, subprocess.SubprocessError, OSError) as exc:
        raise ApiError("video is malformed or cannot be decoded within its limits") from exc
    return {"bytes": raw, "width": width, "height": height, "num_frames": frames, "frame_rate": fps, "duration": frames / fps}


def parse_generation(payload):
    """Validate a request body and return a normalized generation spec.

    All checks run before any process is spawned. Unknown fields, wrong
    pipelines for a capability, out-of-range geometry, malformed media and
    conflicting aliases are rejected here with an :class:`ApiError`.
    """
    if not isinstance(payload, dict):
        raise ApiError("Request body must be a JSON object")

    model = payload.get("model")
    if not isinstance(model, str) or model not in PIPELINES:
        raise ApiError(
            "model must be one of: " + ", ".join(MODEL_ID_LIST), "model_not_found", 404
        )
    workflows = PIPELINES[model]
    # ``workflow`` is an explicit selector: it must be a non-empty string, must
    # name a workflow this model actually supports (null, arrays, numbers and
    # wrong-family names are rejected), and absence alone defaults to
    # ``generate``. Workflow is never inferred from audio/video conditioning.
    workflow = payload.get("workflow", DEFAULT_WORKFLOW)
    if not isinstance(workflow, str) or not workflow:
        raise ApiError(
            "workflow must be a non-empty string; " + model + " supports: "
            + ", ".join(workflows),
        )
    if workflow not in workflows:
        raise ApiError(
            f"{model} does not support workflow {workflow!r}; supports: "
            + ", ".join(workflows),
        )
    spec = workflows[workflow]
    if "sampler" in payload and not spec["requires_audio"]:
        raise ApiError(f"{model} does not accept sampler")

    unknown = set(payload) - _ALLOWED_FIELDS
    if unknown:
        raise ApiError("Unsupported fields: " + ", ".join(sorted(unknown)))

    response_format = payload.get("response_format")
    if response_format is not None and response_format not in RESPONSE_FORMATS:
        raise ApiError("response_format must be one of " + ", ".join(RESPONSE_FORMATS))

    prompt = normalize_prompt(payload.get("prompt"))
    if not isinstance(prompt, str) or not prompt.strip():
        raise ApiError("prompt is required")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ApiError(f"prompt must be at most {MAX_PROMPT_CHARS} characters")

    negative_prompt = payload.get("negative_prompt")
    if negative_prompt is not None:
        if not spec["supports_negative_prompt"]:
            raise ApiError(f"{model} does not accept negative_prompt")
        if not isinstance(negative_prompt, str) or len(negative_prompt) > MAX_NEGATIVE_CHARS:
            raise ApiError(f"negative_prompt must be at most {MAX_NEGATIVE_CHARS} characters")

    video = None
    start_time = end_time = None
    if spec["accepts_video"]:
        if "image_strength" in payload:
            raise ApiError(f"{model} does not accept image_strength")
        forbidden = {"image", "last_frame", "keyframes", "audio", "audio_start_time", "width", "height", "size", "duration", "num_frames", "fps", "frame_rate"} & set(payload)
        if forbidden:
            raise ApiError("Retake uses source video geometry/timing and rejects: " + ", ".join(sorted(forbidden)))
        video = decode_video(payload.get("video"))
        start_time = _number(payload, "start_time", 0, video["duration"], float)
        end_time = _number(payload, "end_time", 0, video["duration"], float)
        if start_time is None or end_time is None or start_time >= end_time:
            raise ApiError("retake requires 0 <= start_time < end_time <= video duration")
    elif any(field in payload for field in ("video", "start_time", "end_time")):
        owner = next(
            (name for name, workflows in PIPELINES.items()
             if any(spec["accepts_video"] for spec in workflows.values())),
            None,
        )
        raise ApiError(
            f"{model} does not accept video editing inputs; use the retake workflow "
            + (f"on {owner} with workflow 'retake'" if owner else "on a video model")
        )

    # ``size`` ("WIDTHxHEIGHT") and ``width``/``height`` are aliases; accepting
    # both at once is ambiguous, so it is an error.
    size = payload.get("size")
    if size is not None:
        if payload.get("width") is not None or payload.get("height") is not None:
            raise ApiError("Provide either size or width/height, not both")
        if not isinstance(size, str) or not SIZE_RE.match(size):
            raise ApiError('size must be a string like "832x512"')
        match = SIZE_RE.match(size)
        width, height = int(match.group(1)), int(match.group(2))
    else:
        width = _integer(payload, "width", MIN_DIMENSION, MAX_DIMENSION, spec["default_width"])
        height = _integer(payload, "height", MIN_DIMENSION, MAX_DIMENSION, spec["default_height"])
    for name, value in (("width", width), ("height", height)):
        if value % DIMENSION_STEP:
            raise ApiError(f"{name} must be divisible by {DIMENSION_STEP}")
        if not MIN_DIMENSION <= value <= MAX_DIMENSION:
            raise ApiError(f"{name} must be between {MIN_DIMENSION} and {MAX_DIMENSION}")
    if width * height > MAX_PIXELS:
        raise ApiError(
            f"width x height must be at most {MAX_PIXELS} pixels", "body_too_large", 413
        )

    # ``fps`` aliases ``frame_rate``.
    if payload.get("fps") is not None and payload.get("frame_rate") is not None:
        raise ApiError("Provide either fps or frame_rate, not both")
    if payload.get("fps") is not None:
        frame_rate = _number(payload, "fps", MIN_FRAME_RATE, MAX_FRAME_RATE, float)
    else:
        frame_rate = _number(payload, "frame_rate", MIN_FRAME_RATE, MAX_FRAME_RATE, float,
                            spec["default_frame_rate"])

    duration = payload.get("duration")
    num_frames = payload.get("num_frames")
    if duration is not None and num_frames is not None:
        raise ApiError("Provide either duration or num_frames, not both")
    if duration is not None:
        duration = _number(payload, "duration", MIN_DURATION, MAX_DURATION, float)
        num_frames = _frames_from_duration(duration, frame_rate)
        num_frames_source = "duration"
    elif num_frames is not None:
        num_frames = _integer(payload, "num_frames", MIN_FRAMES, MAX_FRAMES)
        if (num_frames - 1) % 8:
            raise ApiError("num_frames must satisfy num_frames = 8 * k + 1")
        num_frames_source = "explicit"
    else:
        num_frames = spec["default_num_frames"]
        num_frames_source = "default"

    if (num_frames - 1) / frame_rate > MAX_DURATION:
        raise ApiError("frame count and fps exceed the 20-second output limit")

    seed = _integer(payload, "seed", MIN_SEED, MAX_SEED, spec["default_seed"])

    steps = payload.get("steps")
    if steps is not None:
        if not spec["supports_steps"]:
            raise ApiError(f"{model} uses a fixed distilled schedule and does not accept steps")
        steps = _integer(payload, "steps", MIN_STEPS, MAX_STEPS)

    guidance = _parse_guidance(payload, spec)
    sampler = None
    if spec["requires_audio"]:
        sampler = payload.get("sampler", "euler_ancestral")
        if not isinstance(sampler, str) or sampler not in ("euler", "euler_ancestral"):
            raise ApiError("sampler must be euler or euler_ancestral")
        # Validated audio-driven defaults; explicit caller values take precedence.
        for flag, value in {"video-cfg-guidance-scale": 3.0,
                            "video-stg-guidance-scale": 0.0,
                            "video-rescale-scale": 0.0, "a2v-guidance-scale": 1.0}.items():
            guidance.setdefault(flag, value)

    images = []
    for field, frame_idx in (("image", 0), ("last_frame", num_frames - 1)):
        if payload.get(field) is not None:
            raw, fmt = _decode_data_uri(payload[field], IMAGE_DATA_RE, field, MAX_IMAGE_BYTES, "PNG/JPEG")
            width_px, height_px = _decode_image(raw, field)[1:]
            images.append({"field": field, "frame_idx": frame_idx, "strength": 0.7 if field == "image" and spec["requires_audio"] else 1.0, "bytes": raw,
                           "format": fmt, "width_px": width_px, "height_px": height_px})

    # ``image_strength`` tunes only the first-frame guide (``image`` at frame 0).
    # ``last_frame`` stays at 1.0 and interior keyframes keep their explicit
    # strength, so a single value never silently rescales other guides.
    if "image_strength" in payload:
        if payload.get("image") is None:
            raise ApiError("image_strength requires an image")
        if payload["image_strength"] is None:
            raise ApiError("image_strength must be a number between 0.0 and 1.0")
        strength = _number(payload, "image_strength", 0.0, 1.0, float)
        for item in images:
            if item["frame_idx"] == 0:
                item["strength"] = strength
                break

    keyframes = payload.get("keyframes")
    if keyframes is not None:
        if not isinstance(keyframes, list) or not keyframes:
            raise ApiError("keyframes must be a non-empty list")
        if len(keyframes) > MAX_KEYFRAMES:
            raise ApiError(f"keyframes is limited to {MAX_KEYFRAMES} entries")
        occupied = {item["frame_idx"] for item in images}
        for index, entry in enumerate(keyframes):
            if not isinstance(entry, dict):
                raise ApiError("each keyframe must be an object")
            unknown = set(entry) - {"image", "frame", "strength"}
            if unknown:
                raise ApiError("Unsupported keyframe fields: " + ", ".join(sorted(unknown)))
            frame = _integer(entry, "frame", 1, max(1, num_frames - 2))
            if frame is None:
                raise ApiError(f"keyframes[{index}].frame is required")
            if frame in occupied:
                raise ApiError(f"keyframe frame {frame} is already conditioned")
            occupied.add(frame)
            raw, fmt = _decode_data_uri(entry.get("image"), IMAGE_DATA_RE,
                                        f"keyframes[{index}].image", MAX_IMAGE_BYTES, "PNG/JPEG")
            width_px, height_px = _decode_image(raw, f"keyframes[{index}].image")[1:]
            strength = _number(entry, "strength", 0.0, 1.0, float, 1.0)
            images.append({"field": f"keyframes[{index}]", "frame_idx": frame,
                           "strength": strength, "bytes": raw, "format": fmt,
                           "width_px": width_px, "height_px": height_px})

    if payload.get("audio_start_time") is not None and not spec["accepts_audio"]:
        raise ApiError(f"{model} does not accept audio_start_time")
    audio = None
    audio_info = None
    audio_start_time = 0.0
    if payload.get("audio") is not None:
        if not spec["accepts_audio"]:
            raise ApiError(f"{model} does not accept audio")
        raw, audio_format = _decode_data_uri(payload["audio"], AUDIO_DATA_RE, "audio",
                                             MAX_AUDIO_BYTES, "WAV/FLAC")
        audio_info = decode_audio(raw, audio_format, "audio")
        audio = {"bytes": raw, "ext": audio_format}
        audio_start_time = _number(payload, "audio_start_time", 0.0, MAX_DURATION, float, 0.0)
        if audio_start_time >= audio_info["duration"]:
            raise ApiError("audio_start_time must be before the end of the audio")
    elif spec["requires_audio"]:
        raise ApiError(f"{model} requires an inline audio WAV/FLAC data URI")

    generated_keyframes = payload.get("generated_keyframes")
    if generated_keyframes is not None:
        if not spec["supports_generated_keyframes"]:
            raise ApiError(f"{model} does not accept generated_keyframes")
        generated_keyframes = _integer(payload, "generated_keyframes", 0, min(8, num_frames - 2))

    temporal_upscalings = _integer(payload, "temporal_upscalings", 0, 2, 0)
    spatial_upscalings = payload.get("spatial_upscalings")
    if payload.get("temporal_upscalings") is not None or spatial_upscalings is not None:
        if not spec["supports_temporal_upscalings"]:
            raise ApiError(f"{model} does not accept temporal_upscalings/spatial_upscalings")
    spatial_upscalings = _integer(payload, "spatial_upscalings", 1, 2, 1)

    if spatial_upscalings == 2 and (width % 128 or height % 128):
        raise ApiError("two spatial upscalings require width and height divisible by 128")

    offload = payload.get("offload", "none")
    if offload not in OFFLOAD_MODES:
        raise ApiError("offload must be one of " + ", ".join(OFFLOAD_MODES))
    quantization = payload.get("quantization")
    if quantization is not None and quantization not in QUANTIZATION_POLICIES:
        raise ApiError("quantization must be one of " + ", ".join(QUANTIZATION_POLICIES))
    max_batch_size = _integer(payload, "max_batch_size", 1, 8, 1)

    if video:
        width, height = video["width"], video["height"]
        num_frames, frame_rate = video["num_frames"], video["frame_rate"]

    # Pin one frame grid for duration, image guides, inference and metadata.
    # The A2V frame grid is pinned by --num-frames for every workflow; the
    # audio-driven duration path is not selected, so it stays False.
    use_audio_duration = False

    return {
        "model": model,
        "workflow": workflow,
        "spec": spec,
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "response_format": response_format or "b64_json",
        "width": width,
        "height": height,
        "num_frames": num_frames,
        "num_frames_source": num_frames_source,
        "frame_rate": frame_rate,
        "duration": duration,
        "seed": seed,
        "steps": steps,
        "guidance": guidance,
        "sampler": sampler,
        "images": images,
        "audio": audio,
        "audio_info": audio_info,
        "video": video,
        "start_time": start_time,
        "end_time": end_time,
        "audio_start_time": audio_start_time,
        "use_audio_duration": use_audio_duration,
        "generated_keyframes": generated_keyframes,
        "temporal_upscalings": temporal_upscalings,
        "spatial_upscalings": spatial_upscalings,
        "offload": offload,
        "quantization": quantization,
        "max_batch_size": max_batch_size,
    }


# (request field, upstream flag, low, high). Each of these is defined by
# ``default_1_stage_arg_parser`` in upstream args.py, which backs every guided
# pipeline (Dev, Dev-HQ, A2V, Keyframes). Distilled and DFR do not derive from
# that parser and so do not accept guidance at all -- the table marks them
# ``supports_guidance=False`` and no guidance flag is ever emitted for them.
_GUIDANCE_FLAGS = (
    ("guidance_scale", "video-cfg-guidance-scale", 0.0, 100.0),
    ("stg_scale", "video-stg-guidance-scale", 0.0, 100.0),
    ("rescale_scale", "video-rescale-scale", 0.0, 10.0),
    ("a2v_guidance_scale", "a2v-guidance-scale", 0.0, 100.0),
    ("video_skip_step", "video-skip-step", 0, 100),
    ("audio_guidance_scale", "audio-cfg-guidance-scale", 0.0, 100.0),
    ("audio_stg_scale", "audio-stg-guidance-scale", 0.0, 100.0),
    ("audio_rescale_scale", "audio-rescale-scale", 0.0, 10.0),
    ("v2a_guidance_scale", "v2a-guidance-scale", 0.0, 100.0),
    ("audio_skip_step", "audio-skip-step", 0, 100),
)

_ALLOWED_FIELDS = {
    "model", "workflow", "prompt", "negative_prompt", "image", "image_strength", "last_frame", "keyframes", "audio",
    "audio_start_time", "width", "height", "size", "duration", "num_frames", "frame_rate",
    "fps", "seed", "steps", "generated_keyframes", "temporal_upscalings", "spatial_upscalings",
    "offload", "quantization", "max_batch_size", "response_format", "video", "start_time", "end_time", "sampler",
} | {name for name, _, _, _ in _GUIDANCE_FLAGS}


def _parse_guidance(payload, spec):
    guidance = {}
    for field, flag, low, high in _GUIDANCE_FLAGS:
        if payload.get(field) is None:
            continue
        if not spec["supports_guidance"]:
            raise ApiError(f"{spec['title']} does not accept {field}")
        if spec["requires_audio"] and (field.startswith("audio_") or field.startswith("v2a_")):
            raise ApiError(f"{spec['title']} uses frozen audio and does not accept {field}")
        cast = int if isinstance(low, int) and isinstance(high, int) else float
        guidance[flag] = _number(payload, field, low, high, cast)
    return guidance


def media_path_for(entry, directory):
    """Where a decoded inline image/audio entry is written for the subprocess."""
    directory = Path(directory)
    if entry is None:
        return None
    suffix = {"png": ".png", "jpeg": ".jpg", "wav": ".wav", "flac": ".flac"}[entry["format"] if "format" in entry else entry["ext"]]
    return directory / (entry["field"].replace("[", "_").replace("]", "") + suffix)


def build_argv(generation, assets, media_paths, output_path, python=None):
    """Assemble the official CLI argv for one generation (argv list, never a shell).

    ``media_paths`` maps an image entry's ``field`` to the temp file written for
    it, plus ``audio`` for the decoded driving file on A2V.
    """
    spec = generation["spec"]
    if spec["accepts_video"]:
        argv = [python or sys.executable, "-m", spec["module"]]
        for key in (spec["transformer"], "text_encoder", "video_vae", "audio_vae"):
            flag = "transformer-path" if key == spec["transformer"] else key.replace("_", "-") + "-path"
            argv += ["--" + flag, str(assets[key])]
        argv += ["--video-path", str(media_paths["video"]), "--start-time", str(generation["start_time"]), "--end-time", str(generation["end_time"]), "--prompt", generation["prompt"], "--output-path", str(output_path), "--seed", str(generation["seed"]), "--offload", generation["offload"], "--max-batch-size", str(generation["max_batch_size"])]
        if generation["quantization"]:
            argv += ["--quantization", generation["quantization"]]
        return argv
    argv = [
        python or sys.executable, "-m", spec["module"],
        "--transformer-path", str(assets[spec["transformer"]]),
        "--text-encoder-path", str(assets["text_encoder"]),
        "--video-vae-path", str(assets["video_vae"]),
        "--audio-vae-path", str(assets["audio_vae"]),
        "--spatial-upsampler-path", str(assets["spatial_upsampler"]),
        "--prompt", generation["prompt"],
        "--output-path", str(output_path),
        "--seed", str(generation["seed"]),
        "--width", str(generation["width"]),
        "--height", str(generation["height"]),
        "--frame-rate", str(generation["frame_rate"]),
    ]
    if generation.get("sampler") is not None:
        argv += ["--sampler", generation["sampler"]]
    for key in spec["assets"]:
        argv += ["--" + key.replace("_", "-"), str(assets[key])]

    if generation["negative_prompt"] is not None:
        argv += ["--negative-prompt", generation["negative_prompt"]]

    if generation["use_audio_duration"]:
        # A2V with no endpoint conditioning: the clip length comes from the
        # driving audio, so --num-frames must not also be passed.
        argv += ["--audio-max-duration", str(generation["duration"])]
    else:
        argv += ["--num-frames", str(generation["num_frames"])]

    for flag, value in generation["guidance"].items():
        argv += ["--" + flag, str(value)]

    if generation["steps"] is not None:
        argv += ["--num-inference-steps", str(generation["steps"])]

    for image in generation["images"]:
        # First frame is frame 0; the final frame is num_frames - 1. For an
        # audio-driven A2V run the frame grid is pinned by --num-frames above,
        # so these indices are exact.
        argv += ["--image", media_paths[image["field"]], str(image["frame_idx"]),
                 str(image["strength"])]

    if generation["generated_keyframes"] is not None:
        argv += ["--num-generated-keyframes", str(generation["generated_keyframes"])]

    if spec["supports_temporal_upscalings"]:
        argv += ["--temporal-upscalings", str(generation["temporal_upscalings"]),
                 "--spatial-upscalings", str(generation["spatial_upscalings"])]
        if generation["temporal_upscalings"] > 0:
            argv += ["--temporal-upsampler-path", str(assets["temporal_upsampler"])]

    if generation["audio"] is not None:
        argv += ["--audio-path", media_paths["audio"],
                 "--audio-start-time", str(generation["audio_start_time"])]

    argv += ["--offload", generation["offload"]]
    if generation["quantization"] is not None:
        argv += ["--quantization", generation["quantization"]]
    if generation["max_batch_size"] != 1:
        argv += ["--max-batch-size", str(generation["max_batch_size"])]
    return argv


def describe():
    """Machine-readable model/workflow table for the node test and operators.

    Each entry is one public model ID with its ``default_workflow`` and a
    ``workflows`` object mapping each supported workflow name to its
    per-workflow module, capabilities, defaults and required assets.
    """
    return [
        {
            "id": model,
            "default_workflow": DEFAULT_WORKFLOW,
            "workflows": {
                workflow: {
                    "module": spec["module"],
                    "title": spec["title"],
                    "required_assets": list(MODEL_FILES[key] for key in required_assets(spec)),
                    "capabilities": {
                        "negative_prompt": spec["supports_negative_prompt"],
                        "guidance": spec["supports_guidance"],
                        "steps": spec["supports_steps"],
                        "sampler": ["euler", "euler_ancestral"] if spec["requires_audio"] else False,
                        "generated_keyframes": spec["supports_generated_keyframes"],
                        "audio": spec["accepts_audio"],
                        "video": spec["accepts_video"],
                        "image_strength": not spec["accepts_video"],
                        "structured_prompt": True,
                        "temporal_upscalings": spec["supports_temporal_upscalings"],
                    },
                    "defaults": {
                        "width": spec["default_width"],
                        "height": spec["default_height"],
                        "num_frames": spec["default_num_frames"],
                        "frame_rate": spec["default_frame_rate"],
                        "steps": spec.get("default_steps"),
                        **({"sampler": "euler_ancestral", "image_strength": 0.7,
                            "guidance_scale": 3.0, "stg_scale": 0.0, "rescale_scale": 0.0,
                            "a2v_guidance_scale": 1.0} if spec["requires_audio"] else {}),
                    },
                }
                for workflow, spec in PIPELINES[model].items()
            },
        }
        for model in PIPELINES
    ]


def main(argv=None):
    parser = argparse.ArgumentParser(description="LTX-2.5 pipeline table")
    parser.add_argument("--list", action="store_true", help="print the pipeline table as JSON")
    parser.add_argument("--describe", metavar="MODEL_ID", help="print one model/workflow entry as JSON")
    parser.add_argument("--workflow", metavar="NAME", help="restrict --describe to one workflow")
    parser.add_argument("--model-files", action="store_true", help="print component filenames as JSON")
    args = parser.parse_args(argv)
    if args.model_files:
        print(json.dumps({"required": MODEL_FILES, "optional": OPTIONAL_FILES}, indent=2))
    elif args.describe:
        entry = next((item for item in describe() if item["id"] == args.describe), None)
        if entry is None:
            parser.error("unknown model id: " + args.describe)
        if args.workflow:
            workflow = entry["workflows"].get(args.workflow)
            if workflow is None:
                parser.error(
                    "unknown workflow for " + args.describe + ": " + args.workflow
                )
            print(json.dumps({"id": entry["id"], "workflow": args.workflow, **workflow}, indent=2))
            return
        print(json.dumps(entry, indent=2))
    else:
        print(json.dumps(describe(), indent=2))


if __name__ == "__main__":
    main()
