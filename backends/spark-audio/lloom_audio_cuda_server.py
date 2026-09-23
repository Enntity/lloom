"""Standalone local FastAPI CUDA audio adapter for LLooM.

One process serves exactly one pre-selected model:

  * ``--kind tts --model <ID> --model-path <local-dir>`` loads a local
    Qwen3-TTS checkpoint via ``Qwen3TTSModel.from_pretrained`` on ``cuda:0``.
  * ``--kind stt --model <ID> --model-path <local-whisper-checkpoint>`` loads a
    local Whisper checkpoint via ``whisper.load_model(path, device="cuda")``.

``--model-path`` is a *required* local directory for both kinds: the STT path is
the actual Whisper checkpoint directory, so the process never performs an
implicit HuggingFace/OpenAI download at request time.

The model id is *fixed at startup*.  Requests may echo that exact id; any other
id (or a request that tries to pick a different model) is rejected.  The server
never reads a caller-supplied filesystem path and never fetches a caller-supplied
URL: the only audio accepted for Base/clone is inline multipart upload or a
``data:`` base64 payload.  Requests are bounded (body, text length, upload size,
reference duration, ``max_new_tokens``) and GPU work is offloaded to a worker
thread.

Concurrency model
-----------------
Every async route hands the *entire* inference to
``anyio.to_thread.run_sync(..., abandon_on_cancel=False)`` so the event loop is
never blocked and cancellations/disconnects cannot abandon GPU work halfway.
Only one generation may run at a time; a second concurrent request is rejected
with HTTP 429 instead of queueing unboundedly.  The "busy" flag is held until the
worker thread *actually* completes, even if the client disconnects.

Region of the OpenAI speech/transcriptions API implemented (WAV or PCM):

  POST /v1/audio/speech            (JSON or multipart)
  POST /v1/audio/transcriptions    (multipart)
  GET  /health
  GET  /v1/models
"""
from __future__ import annotations

import argparse
import base64
import binascii
import asyncio
import hashlib
import io
import json
import logging
import math
import os
import queue
import sys
import tempfile
import threading
import wave
from dataclasses import dataclass, field
from concurrent.futures import ThreadPoolExecutor
from typing import Any, AsyncIterator, Dict, Optional, Sequence, Tuple

import anyio
import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

LOG = logging.getLogger("lloom-audio-cuda")

# ---------------------------------------------------------------------------
# Limits / constants
# ---------------------------------------------------------------------------

MAX_BODY_BYTES = 25 * 1024 * 1024          # hard cap on a whole request body
MAX_UPLOAD_BYTES = 16 * 1024 * 1024        # per uploaded reference clip / STT file
MAX_TEXT_CHARS = 4000                      # synthesis text length
MAX_REF_TEXT_CHARS = 4000                  # reference transcript length
MAX_NEW_TOKENS = 2048                      # capping generated audio tokens
MAX_STREAM_QUEUE_CHUNKS = 4                # bounded queue provides backpressure
PCM_SAMPLE_RATE = 24000
PCM_CHANNELS = 1
MIN_REF_SECONDS = 0.05                     # reject empty / degenerate clips
MAX_REF_SECONDS = 30.0                     # reject oversized reference audio
MAX_STT_SECONDS = 600.0                    # whisper transcribe cap (10 minutes)
DEFAULT_LANGUAGE = "Auto"                  # Qwen3-TTS language when unset

# Preset Qwen3-TTS CustomVoice speakers.  These are the only speaker ids the
# CustomVoice mode will forward; anything else is rejected (no ad-hoc profiles).
CUSTOM_VOICE_SPEAKERS: Tuple[str, ...] = (
    "serena",
    "vivian",
    "uncle_fu",
    "ryan",
    "aiden",
    "ono_anna",
    "sohee",
    "eric",
    "dylan",
)

TTS_MODES: Tuple[str, ...] = ("custom_voice", "voice_design", "voice_clone")

# The gateway/OpenAI model ids this adapter is willing to serve.  These are only
# cosmetic aliases for the fixed local checkpoint.
KNOWN_STT_GATEWAY_IDS: Tuple[str, ...] = (
    "openai/whisper-large-v3-turbo",
    "whisper-large-v3-turbo",
    "whisper-1",
)
SUPPORTED_AUDIO_SUFFIXES: Tuple[str, ...] = (
    ".wav",
    ".mp3",
    ".flac",
    ".ogg",
    ".opus",
    ".m4a",
    ".aac",
    ".webm",
)


class ClientError(Exception):
    """A request-level fault that maps to an HTTP status (never leaks details)."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class BusyError(Exception):
    """Raised when a second concurrent generation is attempted."""


class BodyTooLarge(Exception):
    """Raised internally when a streamed request body exceeds the hard cap."""


def _infer_tts_mode(model_id: str) -> str:
    """Infer the Qwen3-TTS operating mode from the (fixed) model id."""
    text = (model_id or "").lower()
    if "voicedesign" in text or "voice-design" in text or "voice_design" in text:
        return "voice_design"
    if "customvoice" in text or "custom-voice" in text or "custom_voice" in text:
        return "custom_voice"
    if "base" in text or "clone" in text:
        return "voice_clone"
    return "voice_clone"


# ---------------------------------------------------------------------------
# Bounded body handling
# ---------------------------------------------------------------------------


async def _bounded_receive_body(receive, limit: int = MAX_BODY_BYTES) -> bytes:
    """Read a full request body using the ASGI ``receive`` channel, bounded.

    Content-Length is only a hint (and may be absent for chunked bodies), so the
    running total is capped while streaming.  This enforces the total request cap
    for *both* JSON and multipart before any parsing happens, with no unbounded
    buffering.
    """
    if receive is None:
        raise ClientError("request body is unavailable", status_code=400)

    chunks = []
    total = 0
    while True:
        message = await receive()
        message_type = message.get("type")
        if message_type == "http.disconnect":
            raise ClientError("client disconnected", status_code=499)
        if message_type != "http.request":
            if message.get("more_body"):
                continue
            break
        chunk = message.get("body", b"") or b""
        total += len(chunk)
        if total > limit:
            raise BodyTooLarge("request body too large")
        if chunk:
            chunks.append(chunk)
        if not message.get("more_body", False):
            break
    return b"".join(chunks)


async def _read_bounded_body(request) -> bytes:
    """Enforce the total body cap before any parsing (peek + replay)."""
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared = int(content_length)
        except ValueError:
            raise ClientError("invalid Content-Length")
        if declared > MAX_BODY_BYTES:
            raise ClientError("request body too large", status_code=413)

    try:
        raw = await _bounded_receive_body(request.receive, MAX_BODY_BYTES)
    except BodyTooLarge:
        raise ClientError("request body too large", status_code=413)

    # Replay the bounded buffer to downstream parsers (request.body / form()).
    state = {"done": False}

    async def _replay():
        if state["done"]:
            return {"type": "http.request", "body": b"", "more_body": False}
        state["done"] = True
        return {"type": "http.request", "body": raw, "more_body": False}

    request._receive = _replay
    return raw


# ---------------------------------------------------------------------------
# Duration helpers (decoded frames / real sample rate, never a header only)
# ---------------------------------------------------------------------------


def _decode_wav_duration(raw: bytes) -> Optional[float]:
    """Exact duration from a RIFF/WAVE container using its own frame count."""
    if len(raw) < 44 or raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE":
        return None
    pos = 12
    sample_rate = None
    block_align = None
    data_size = None
    while pos + 8 <= len(raw):
        chunk_id = raw[pos : pos + 4]
        chunk_size = int.from_bytes(raw[pos + 4 : pos + 8], "little")
        body = pos + 8
        if chunk_id == b"fmt " and chunk_size >= 16 and body + 16 <= len(raw):
            channels = int.from_bytes(raw[body + 2 : body + 4], "little")
            sample_rate = int.from_bytes(raw[body + 4 : body + 8], "little")
            block_align = int.from_bytes(raw[body + 12 : body + 14], "little")
            if not block_align:
                bits = int.from_bytes(raw[body + 14 : body + 16], "little")
                block_align = max(1, channels) * max(1, bits // 8)
        elif chunk_id == b"data":
            data_size = min(chunk_size, max(0, len(raw) - body))
        if chunk_size <= 0:
            break
        pos = body + chunk_size + (chunk_size & 1)
    if not sample_rate or data_size is None:
        return None
    frame_count = data_size // max(1, block_align or 1)
    return frame_count / float(sample_rate)


def _decoded_duration_seconds(audio: Any, sample_rate: int) -> float:
    """Duration from the *actual* decoded frames and the true sample rate.

    Codec-agnostic: compressed references (FLAC/OGG/MP3/M4A) report their real
    duration here instead of the ``None`` a WAV-header probe would return.
    """
    sample_rate = int(sample_rate or 0)
    if sample_rate <= 0:
        raise ClientError("reference audio has an invalid sample rate")
    arr = np.asarray(audio)
    frames = int(arr.shape[0]) if arr.ndim else int(arr.size)
    return frames / float(sample_rate)


def _decode_ref_audio(raw: bytes) -> Tuple[np.ndarray, int]:
    """Decode uploaded reference bytes into ``(mono float32 array, sample rate)``."""
    if not raw:
        raise ClientError("reference audio is empty")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ClientError("reference audio exceeds the upload limit", status_code=413)

    try:  # imported lazily so unit tests can stub out decoding
        import soundfile as sf

        audio, sample_rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
    except ClientError:
        raise
    except Exception as exc:  # pragma: no cover - depends on installed codecs
        raise ClientError("reference audio could not be decoded") from exc

    array = np.asarray(audio, dtype=np.float32)
    if array.ndim > 1:
        array = array.mean(axis=1)
    if array.size == 0:
        raise ClientError("reference audio is empty")

    # Enforce the duration window on real decoded frames, not a WAV header.
    duration = _decoded_duration_seconds(array, sample_rate)
    if duration < MIN_REF_SECONDS:
        raise ClientError("reference audio is too short")
    if duration > MAX_REF_SECONDS:
        raise ClientError("reference audio is too long", status_code=413)
    return np.ascontiguousarray(array, dtype=np.float32), int(sample_rate)


def _decode_base64_audio(value: str) -> Tuple[np.ndarray, int]:
    payload = value.split(",", 1)[1] if value.startswith("data:") else value
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ClientError("reference audio base64 could not be decoded") from exc
    return _decode_ref_audio(raw)


def _to_wav_bytes(audio: Any, sample_rate: int) -> bytes:
    """Serialise a float waveform to a 16-bit PCM WAV container."""
    array = np.asarray(audio, dtype=np.float32)
    if array.ndim > 1:
        array = array.reshape(-1)
    array = np.clip(np.nan_to_num(array, nan=0.0, posinf=1.0, neginf=-1.0), -1.0, 1.0)
    pcm = (array * 32767.0).astype("<i2").tobytes()

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm)
    return buffer.getvalue()


def _to_pcm16_le(audio: Any) -> bytes:
    """Serialise a float waveform to raw PCM16 little-endian mono bytes."""
    array = np.asarray(audio, dtype=np.float32)
    if array.ndim > 1:
        array = array.reshape(-1)
    array = np.clip(np.nan_to_num(array, nan=0.0, posinf=1.0, neginf=-1.0), -1.0, 1.0)
    return (array * 32767.0).astype("<i2").tobytes()


def _pcm_response_headers(sample_rate: int) -> Dict[str, str]:
    """Describe raw PCM explicitly instead of relying on network L16 byte order."""
    return {
        "x-audio-sample-rate": str(sample_rate),
        "x-audio-channels": str(PCM_CHANNELS),
        "x-audio-format": "pcm_s16le",
    }


# ---------------------------------------------------------------------------
# Server configuration + fixed model holder
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ServerConfig:
    kind: str
    model_id: str
    model_path: Optional[str] = None
    host: str = "127.0.0.1"
    port: int = 8220
    hf_home: Optional[str] = None
    engine: Optional[str] = None

    def __post_init__(self) -> None:
        kind = (self.kind or "").strip().lower()
        if kind not in ("tts", "stt"):
            raise ValueError("kind must be 'tts' or 'stt'")
        if not self.model_id or not str(self.model_id).strip():
            raise ValueError("a model id is required")


class ModelHolder:
    """Owns the single configured model, its load state and the inference lock."""

    def __init__(self, config: ServerConfig) -> None:
        self.config = config
        self.kind = config.kind
        self.model_id = config.model_id
        self.mode = _infer_tts_mode(config.model_id) if config.kind == "tts" else None
        self.model: Any = None
        engine = (config.engine or os.getenv("LLOOM_TTS_ENGINE", "stock")).lower()
        self.engine = engine
        self.uses_faster_engine = engine in ("faster", "faster-qwen3-tts", "fasterqwen3tts")
        self.ready = False
        self.fatal = False
        self.load_error: Optional[str] = None
        self.gpu_lock = threading.Lock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="audio-gpu")
        # Guards model access and tracks whether a generation is in flight.
        self._busy_lock = threading.Lock()
        self._busy = False
        self._busy_generation = 0
        self._reference_lock = threading.Lock()
        # Process-lifetime staging for FasterQwen3TTS. Stable content-addressed
        # paths let its in-memory voice-prompt cache be reused; this is not a
        # persistent configuration/model cache and is removed with the holder.
        self._reference_tmp = tempfile.TemporaryDirectory(prefix="lloom-qwen-tts-ref-")
        self._reference_paths = set()
        self._stream_queue: queue.Queue = queue.Queue(maxsize=MAX_STREAM_QUEUE_CHUNKS)
        self._stream_stop = threading.Event()

    # -- id validation ----------------------------------------------------
    def resolve_model_id(self, requested: Optional[str]) -> str:
        """Return the fixed id, rejecting any attempt to select another model."""
        if requested is None:
            return self.model_id
        requested = str(requested).strip()
        if not requested:
            return self.model_id
        if requested == self.model_id:
            return self.model_id
        # For STT, accept canonical gateway aliases for this same checkpoint.
        if self.kind == "stt":
            fixed = self.model_id.strip().lower()
            if requested.lower() in KNOWN_STT_GATEWAY_IDS and fixed in KNOWN_STT_GATEWAY_IDS:
                return self.model_id
        raise ClientError("unknown model", status_code=404)

    # -- lifecycle --------------------------------------------------------
    def load(self) -> None:
        """Warm-load the fixed model.  Called at startup; errors are fatal."""
        try:
            if self.kind == "tts":
                self.model = self._load_tts()
            else:
                self.model = self._load_stt()
        except Exception as exc:  # keep only the type name; never leak details
            self.fatal = True
            self.ready = False
            self.load_error = type(exc).__name__
            LOG.error("model load failed (%s)", self.load_error)
            raise
        self.ready = True
        self.fatal = False

    def _load_tts(self) -> Any:
        import torch

        if self.uses_faster_engine:
            if self.mode != "voice_clone":
                raise ValueError("the optional faster engine is available for voice_clone only")
            from faster_qwen3_tts import FasterQwen3TTS

            if not self.config.model_path or not os.path.isdir(self.config.model_path):
                raise ValueError("TTS requires an existing local model directory")
            # A local path prevents model download. The faster wrapper loads the
            # same local checkpoint through Qwen3TTSModel.
            return FasterQwen3TTS.from_pretrained(
                self.config.model_path,
                device="cuda:0",
                dtype=torch.bfloat16,
                attn_implementation="sdpa",
            )

        from qwen_tts import Qwen3TTSModel

        if not self.config.model_path or not os.path.isdir(self.config.model_path):
            raise ValueError("TTS requires an existing local model directory")
        return Qwen3TTSModel.from_pretrained(
            self.config.model_path,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
            local_files_only=True,
        )

    def _load_stt(self) -> Any:
        import whisper

        # ``--model-path`` is the actual local Whisper checkpoint.  Passing it as
        # the model name means whisper loads the local checkpoint file directly and
        # never performs an implicit download (a bare alias such as "turbo"
        # would trigger one), so a real path is required here.
        path = self.config.model_path
        if not path:
            raise ValueError("STT requires --model-path pointing at a local checkpoint")
        if not os.path.isfile(path):
            raise ValueError("STT --model-path must be a checkpoint file")
        return whisper.load_model(path, device="cuda")

    # -- busy gate --------------------------------------------------------
    def ensure_idle(self) -> None:
        """Raise 429 when another generation is already in flight."""
        with self._busy_lock:
            if self._busy:
                raise BusyError("another generation is already running")
            self._busy = True
            self._busy_generation += 1
            return self._busy_generation

    def clear_busy(self, generation=None) -> None:
        with self._busy_lock:
            if generation is None or generation == self._busy_generation:
                self._busy = False

    @property
    def busy(self) -> bool:
        with self._busy_lock:
            return self._busy

    # -- execution --------------------------------------------------------
    def run(self, fn, *args, **kwargs):
        """Run a blocking callable on the calling thread with the lock held."""
        with self.gpu_lock:
            return fn(*args, **kwargs)

    async def run_in_thread(self, fn, *args, **kwargs):
        """Offload blocking inference to a worker thread.

        ``abandon_on_cancel=False`` keeps the worker running to completion even
        when the awaiting task is cancelled (e.g. the client disconnects), so the
        busy flag / GPU lock are only released once inference has actually
        finished.
        """
        lease = self._busy_generation
        future = self.executor.submit(lambda: self.run(fn, *args, **kwargs))
        future.add_done_callback(lambda _: self.clear_busy(lease))
        with anyio.CancelScope(shield=True):
            return await anyio.to_thread.run_sync(future.result, abandon_on_cancel=False)

    def start_stream_job(self, fn):
        """Consume the route's busy lease; each response owns its queue/event."""
        lease = self._busy_generation
        chunks = queue.Queue(maxsize=MAX_STREAM_QUEUE_CHUNKS)
        stopped = threading.Event()
        self._stream_queue, self._stream_stop = chunks, stopped

        def put(item):
            while not stopped.is_set():
                try:
                    chunks.put(item, timeout=0.05)
                    return True
                except queue.Full:
                    continue
            return False

        def job():
            with self.gpu_lock:
                try:
                    fn(put, stopped)
                except Exception as exc:
                    LOG.error("streaming generation failed (%s)", type(exc).__name__)
                    put(RuntimeError("speech generation failed"))
                finally:
                    put(None)

        try:
            future = self.executor.submit(job)
        except BaseException:
            self.clear_busy(lease)
            raise
        future.add_done_callback(lambda _: self.clear_busy(lease))
        return chunks, stopped



# ---------------------------------------------------------------------------
# Request parsing helpers
# ---------------------------------------------------------------------------


def _first_str(body: Dict[str, Any], *keys: str) -> Optional[str]:
    """Return the first non-empty value among ``keys`` (alias support)."""
    for key in keys:
        value = body.get(key)
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        return value
    return None


def _coerce_int(value: Any, default: Optional[int] = None) -> Optional[int]:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ClientError("a numeric parameter was not an integer")


def _as_bool(value: Any) -> bool:
    if value is None:
        return False
    return str(value).strip().lower() in ("1", "true", "yes", "on")


async def _read_json_body(request) -> Dict[str, Any]:
    raw = await _read_bounded_body(request)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ClientError("request body was not valid JSON") from exc
    if not isinstance(parsed, dict):
        raise ClientError("request body must be a JSON object")
    return parsed


@dataclass
class SpeechRequest:
    model_id: str
    text: str
    language: Optional[str]
    instruct: Optional[str]
    speaker: Optional[str]
    ref_audio: Optional[Tuple[np.ndarray, int]]
    ref_text: Optional[str]
    x_vector_only_mode: bool
    max_new_tokens: int
    stream: bool
    response_format: str = "wav"
    sampling: Dict[str, Any] = field(default_factory=dict)


def _build_speech_request(holder: ModelHolder, body: Dict[str, Any]) -> SpeechRequest:
    model_id = holder.resolve_model_id(_first_str(body, "model"))

    text = _first_str(body, "input", "text")
    if text is None:
        raise ClientError("'input' (or 'text') is required")
    text = str(text)
    if len(text) > MAX_TEXT_CHARS:
        raise ClientError("input text is too long", status_code=413)

    instruct = _first_str(body, "instructions", "instruct")
    if instruct is not None:
        instruct = str(instruct)
        if len(instruct) > MAX_TEXT_CHARS:
            raise ClientError("instructions are too long", status_code=413)

    language = _first_str(body, "language")
    if language is not None:
        language = str(language).strip()
    if not language:
        language = DEFAULT_LANGUAGE  # "Auto"

    speaker = _first_str(body, "speaker", "voice")
    ref_text = _first_str(body, "ref_text")
    if ref_text is not None:
        ref_text = str(ref_text)
        if len(ref_text) > MAX_REF_TEXT_CHARS:
            raise ClientError("ref_text is too long", status_code=413)

    max_new_tokens = _coerce_int(_first_str(body, "max_new_tokens"), default=MAX_NEW_TOKENS)
    if max_new_tokens is None or max_new_tokens <= 0:
        max_new_tokens = MAX_NEW_TOKENS
    max_new_tokens = min(max_new_tokens, MAX_NEW_TOKENS)

    x_vector_only_mode = _as_bool(body.get("x_vector_only_mode"))
    stream = _as_bool(body.get("stream"))

    sampling = {}
    for key, low, high in [("temperature", 0.01, 2.0), ("top_p", 0.01, 1.0),
                           ("top_k", 1, 1000), ("repetition_penalty", 0.1, 3.0)]:
        if body.get(key) is None:
            continue
        try:
            value = float(body[key])
        except (ValueError, TypeError):
            raise ClientError("invalid " + key)
        if not math.isfinite(value) or not low <= value <= high:
            raise ClientError("invalid " + key)
        if key == "top_k" and value != int(value):
            raise ClientError("top_k must be an integer")
        sampling[key] = int(value) if key == "top_k" else value

    mode = holder.mode
    ref_audio: Optional[Tuple[np.ndarray, int]] = None

    if mode == "custom_voice":
        # Instructions are OPTIONAL for CustomVoice: a preset speaker alone is a
        # valid request, and the preset default speaker is used when none is set.
        selected = speaker if speaker is not None else CUSTOM_VOICE_SPEAKERS[0]
        selected = str(selected).strip().lower()
        if selected not in CUSTOM_VOICE_SPEAKERS:
            raise ClientError("unknown speaker for CustomVoice", status_code=404)
        speaker = selected
        if body.get("ref_audio") is not None:
            raise ClientError("CustomVoice does not accept reference audio")
    elif mode == "voice_design":
        # VoiceDesign *requires* an instruction.
        if instruct is None:
            raise ClientError("VoiceDesign requires 'instructions'")
        speaker = None
    elif mode == "voice_clone":
        supplied = body.get("ref_audio")
        if supplied is None:
            raise ClientError("Base/clone requires reference audio")
        if isinstance(supplied, str):
            if supplied.startswith("data:") or ";base64," in supplied:
                ref_audio = _decode_base64_audio(supplied)
            else:
                # Never read caller-specified paths or fetch caller URLs.
                raise ClientError("ref_audio must be uploaded or base64-encoded, not a path")
        elif isinstance(supplied, (bytes, bytearray, memoryview)):
            ref_audio = _decode_ref_audio(bytes(supplied))
        else:
            raise ClientError("ref_audio must be uploaded or base64-encoded")
        if not x_vector_only_mode and not ref_text:
            raise ClientError("Base/clone requires ref_text unless x_vector_only_mode")
        speaker = None
    else:  # pragma: no cover - guarded by config validation
        raise ClientError("unsupported model mode", status_code=500)

    return SpeechRequest(
        model_id=model_id,
        text=text,
        language=language,
        instruct=instruct,
        speaker=speaker,
        ref_audio=ref_audio,
        ref_text=ref_text,
        x_vector_only_mode=x_vector_only_mode,
        max_new_tokens=max_new_tokens,
        stream=stream,
        sampling=sampling,
        response_format=str(body.get("response_format") or "wav").lower(),
    )


def _reject_unsupported_speech_format(body: Dict[str, Any]) -> None:
    """Speech synthesis supports WAV and little-endian PCM16."""
    requested = _first_str(body, "response_format", "format")
    if requested is None:
        return
    fmt = str(requested).strip().lower()
    if fmt in ("wav", "audio/wav", "pcm"):
        return
    raise ClientError("only 'wav' or 'pcm' response_format is supported")


def _reject_malformed_stream_mode(body: Dict[str, Any]) -> None:
    requested = _first_str(body, "response_format", "format")
    if _as_bool(body.get("stream")) and str(requested or "").strip().lower() != "pcm":
        raise ClientError("stream=true requires response_format=pcm")


def _stable_reference_path(holder: ModelHolder, request: SpeechRequest) -> str:
    """Stage one reference by content hash so faster's prompt cache can be reused."""
    if request.ref_audio is None:
        raise ClientError("reference audio is required", status_code=400)
    waveform, sample_rate = request.ref_audio
    payload = _to_wav_bytes(waveform, int(sample_rate))
    digest = hashlib.sha256(payload).hexdigest()
    path = os.path.join(holder._reference_tmp.name, f"{digest}.wav")
    with holder._reference_lock:
        if path not in holder._reference_paths or not os.path.exists(path):
            if len(holder._reference_paths) >= 16:
                for old in holder._reference_paths:
                    _safe_unlink(old)
                holder._reference_paths.clear()
                cache = getattr(holder.model, "_voice_prompt_cache", None)
                if isinstance(cache, dict):
                    cache.clear()
            with open(path, "wb") as handle:
                handle.write(payload)
            holder._reference_paths.add(path)
    return path


def _run_faster_tts_streaming(holder: ModelHolder, request: SpeechRequest) -> Response:
    """Start FasterQwen3TTS clone streaming and return a bounded PCM consumer."""
    model = holder.model
    if model is None:
        raise ClientError("model is not loaded", status_code=503)
    reference_path = _stable_reference_path(holder, request)

    def _produce(put, stopped) -> None:
        generator = None
        try:
            cache = getattr(model, "_voice_prompt_cache", None)
            if isinstance(cache, dict) and len(cache) >= 16:
                cache.clear()
            generator = model.generate_voice_clone_streaming(
                text=request.text,
                language=request.language,
                ref_audio=reference_path,
                ref_text=request.ref_text or "",
                max_new_tokens=request.max_new_tokens,
            **request.sampling,
                xvec_only=request.x_vector_only_mode,
                instruct=request.instruct,
                chunk_size=4,
            )
            for audio_chunk, _sample_rate, _timing in generator:
                if stopped.is_set():
                    break
                if int(_sample_rate) != PCM_SAMPLE_RATE:
                    raise RuntimeError("unexpected model sample rate")
                pcm = _to_pcm16_le(audio_chunk)
                if not pcm:
                    continue
                # PCM_SAMPLE_RATE is the adapter contract; the bounded queue
                # applies backpressure before more GPU work is converted.
                if not put(pcm):
                    break
        finally:
            close = getattr(generator, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    LOG.error("streaming generator cleanup failed")

    chunks, stopped = holder.start_stream_job(_produce)

    async def _consume() -> AsyncIterator[bytes]:
        try:
            while True:
                try:
                    item = chunks.get_nowait()
                except queue.Empty:
                    await asyncio.sleep(0.01)
                    continue
                if item is None:
                    return
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            stopped.set()

    return StreamingResponse(
        _consume(),
        media_type="audio/pcm; rate=24000; channels=1",
        headers=_pcm_response_headers(PCM_SAMPLE_RATE),
    )


async def _run_tts(holder: ModelHolder, request: SpeechRequest) -> Response:
    model = holder.model
    if model is None:
        raise ClientError("model is not loaded", status_code=503)

    mode = holder.mode
    if mode == "voice_clone" and holder.uses_faster_engine and request.stream:
        return _run_faster_tts_streaming(holder, request)
    if mode == "custom_voice":
        wavs, sample_rate = await holder.run_in_thread(
            model.generate_custom_voice,
            text=request.text,
            language=request.language,
            speaker=request.speaker,
            instruct=request.instruct,
            max_new_tokens=request.max_new_tokens,
            **request.sampling,
        )
    elif mode == "voice_design":
        wavs, sample_rate = await holder.run_in_thread(
            model.generate_voice_design,
            text=request.text,
            language=request.language,
            instruct=request.instruct,
            max_new_tokens=request.max_new_tokens,
            **request.sampling,
        )
    elif holder.uses_faster_engine:
        cache = getattr(model, "_voice_prompt_cache", None)
        if isinstance(cache, dict) and len(cache) >= 16:
            cache.clear()
        reference_path = _stable_reference_path(holder, request)
        wavs, sample_rate = await holder.run_in_thread(
            model.generate_voice_clone,
            text=request.text, language=request.language,
            ref_audio=reference_path, ref_text=request.ref_text or "",
            xvec_only=request.x_vector_only_mode,
            max_new_tokens=request.max_new_tokens,
            **request.sampling,
        )
    else:
        wavs, sample_rate = await holder.run_in_thread(
            model.generate_voice_clone,
            text=request.text,
            language=request.language,
            ref_audio=request.ref_audio,
            ref_text=request.ref_text,
            x_vector_only_mode=request.x_vector_only_mode,
            max_new_tokens=request.max_new_tokens,
            **request.sampling,
        )

    waveform = wavs[0] if isinstance(wavs, (list, tuple)) and len(wavs) else wavs
    if waveform is None:
        raise ClientError("model returned no audio", status_code=500)
    if request.response_format == "pcm":
        return Response(content=_to_pcm16_le(waveform), media_type="audio/pcm",
                        headers=_pcm_response_headers(int(sample_rate)))
    payload = _to_wav_bytes(waveform, int(sample_rate or 24000))
    return Response(
        content=payload,
        media_type="audio/wav",
        headers={"Content-Disposition": 'attachment; filename="speech.wav"'},
    )


async def _run_stt(
    holder: ModelHolder,
    raw: bytes,
    suffix: str,
    language: Optional[str],
    prompt: Optional[str],
) -> Any:
    """Decode + transcribe on the worker thread, cleaning up the temp file last.

    ``whisper.load_audio`` decodes any ffmpeg-supported container to a 16 kHz
    mono numpy array; a bad decode surfaces as a client error.  The ``finally``
    runs on the worker thread, so cleanup can only happen after the worker
    completes -- even if the awaiting caller was cancelled or disconnected.
    """
    model = holder.model
    if model is None:
        raise ClientError("model is not loaded", status_code=503)
    if suffix not in SUPPORTED_AUDIO_SUFFIXES:
        # Reject a request that would need an opaque temp path.
        raise ClientError("uploaded audio must have a recognised file extension")

    def _job() -> Any:
        import whisper

        tmp_path: Optional[str] = None
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
                handle.write(raw)
                tmp_path = handle.name
            try:
                audio = whisper.load_audio(tmp_path)
            except ClientError:
                raise
            except Exception as exc:
                raise ClientError("uploaded audio could not be decoded") from exc
            array = np.asarray(audio, dtype=np.float32).reshape(-1)
            if array.size == 0:
                raise ClientError("uploaded audio is empty")
            sample_rate = getattr(getattr(whisper, "audio", None), "SAMPLE_RATE", 16000)
            duration = array.size / float(sample_rate)
            if duration > MAX_STT_SECONDS:
                raise ClientError("uploaded audio is too long", status_code=413)
            kwargs: Dict[str, Any] = {}
            if language:
                kwargs["language"] = language
            if prompt:
                kwargs["initial_prompt"] = prompt
            return model.transcribe(array, **kwargs)
        finally:
            if tmp_path:
                _safe_unlink(tmp_path)

    return await holder.run_in_thread(_job)


def _format_transcription(result: Any, fmt: str) -> Response:
    if isinstance(result, dict):
        text = str(result.get("text") or "").strip()
        segments = result.get("segments")
        language = result.get("language")
    else:
        text = str(getattr(result, "text", "") or "").strip()
        segments = getattr(result, "segments", None)
        language = getattr(result, "language", None)
    if fmt == "text":
        return Response(content=text, media_type="text/plain")
    payload: Dict[str, Any] = {"text": text}
    if fmt == "verbose_json":
        if segments is not None:
            payload["segments"] = segments
        if language is not None:
            payload["language"] = language
    return JSONResponse(payload)


def _error_response(exc: ClientError) -> JSONResponse:
    error_type = "rate_limit_error" if exc.status_code == 429 else "invalid_request_error"
    return JSONResponse(
        {"error": {"message": exc.message, "type": error_type}},
        status_code=exc.status_code,
    )


def _safe_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------


def create_app(holder: ModelHolder) -> FastAPI:
    app = FastAPI(title="LLooM Audio CUDA Adapter", version="1.2.0")
    app.state.holder = holder

    @app.get("/health")
    async def health() -> JSONResponse:
        state = "ready" if holder.ready else ("fatal" if holder.fatal else "loading")
        payload = {
            "ok": holder.ready,
            "status": state,
            "loaded": holder.ready,
            "kind": holder.kind,
            "mode": holder.mode,
            "model": holder.model_id,
            "busy": holder.busy,
        }
        status_code = 200 if holder.ready else 503
        return JSONResponse(payload, status_code=status_code)

    @app.get("/v1/models")
    async def list_models() -> JSONResponse:
        data = [{"id": holder.model_id, "object": "model", "owned_by": "lloom-local"}]
        return JSONResponse({"object": "list", "data": data})

    @app.post("/v1/audio/speech")
    async def speech(request: Request) -> Response:
        if holder.fatal:
            return JSONResponse(
                {"error": {"message": "model failed to load", "type": "server_error"}},
                status_code=503,
            )
        if holder.kind != "tts" or not holder.ready:
            return JSONResponse(
                {"error": {"message": "speech is unavailable", "type": "invalid_request_error"}},
                status_code=400,
            )

        try:
            # Cap the whole body *before* parsing (JSON or multipart).
            await _read_bounded_body(request)
            content_type = (request.headers.get("content-type") or "").lower()
            if "multipart/form-data" in content_type:
                body = await _parse_speech_multipart(request)
            else:
                body = await _read_json_body(request)
            speech_request = _build_speech_request(holder, body)
            _reject_unsupported_speech_format(body)
            _reject_malformed_stream_mode(body)
        except ClientError as exc:
            return _error_response(exc)

        try:
            lease = holder.ensure_idle()
        except BusyError as exc:
            return _error_response(ClientError(str(exc), status_code=429))

        try:
            return await _run_tts(holder, speech_request)
        except ClientError as exc:
            holder.clear_busy(lease)
            return _error_response(exc)
        except Exception as exc:  # never leak internals
            holder.clear_busy(lease)
            LOG.error("speech failed (%s)", type(exc).__name__)
            return JSONResponse(
                {"error": {"message": "internal error", "type": "server_error"}},
                status_code=500,
            )

    @app.post("/v1/audio/transcriptions")
    async def transcriptions(request: Request) -> Response:
        if holder.fatal:
            return JSONResponse(
                {"error": {"message": "model failed to load", "type": "server_error"}},
                status_code=503,
            )
        if holder.kind != "stt" or not holder.ready:
            return JSONResponse(
                {
                    "error": {
                        "message": "transcriptions are unavailable",
                        "type": "invalid_request_error",
                    }
                },
                status_code=400,
            )

        try:
            # Cap the whole multipart body before the form parser runs.
            await _read_bounded_body(request)
            form = await request.form(max_files=1, max_fields=16)
            upload = form.get("file")
            model = form.get("model")
            language = form.get("language")
            prompt = form.get("prompt")
            response_format = form.get("response_format") or "json"

            if not hasattr(upload, "read"):
                raise ClientError("form field 'file' must be an uploaded file")
            if model is not None:
                holder.resolve_model_id(str(model))
            fmt = str(response_format).strip().lower()
            if fmt not in ("json", "text", "verbose_json"):
                raise ClientError("unsupported response_format")
            raw = await upload.read(MAX_UPLOAD_BYTES + 1)
            if not raw:
                raise ClientError("uploaded audio is empty")
            if len(raw) > MAX_UPLOAD_BYTES:
                raise ClientError("uploaded audio is too large", status_code=413)

            suffix = os.path.splitext(upload.filename or "")[1].lower()
            if suffix not in SUPPORTED_AUDIO_SUFFIXES:
                raise ClientError("unsupported audio file extension")
            language = str(language).strip() if language else None
            if language and language.lower() == "auto":
                language = None

            holder.ensure_idle()
            result = await _run_stt(holder, raw, suffix, language, prompt)
        except BusyError as exc:
            return _error_response(ClientError(str(exc), status_code=429))
        except ClientError as exc:
            return _error_response(exc)
        except Exception as exc:  # never leak internals
            LOG.exception("transcription failed: %s", exc)
            return JSONResponse(
                {"error": {"message": "internal error", "type": "server_error"}},
                status_code=500,
            )
        return _format_transcription(result, fmt)

    return app


async def _parse_speech_multipart(request) -> Dict[str, Any]:
    form = await request.form(max_files=1, max_fields=16)
    body: Dict[str, Any] = {}
    for key, value in form.multi_items():
        if hasattr(value, "read"):
            raw = await value.read(MAX_UPLOAD_BYTES + 1)
            if len(raw) > MAX_UPLOAD_BYTES:
                raise ClientError("uploaded reference audio is too large", status_code=413)
            body[key] = raw
        else:
            body[key] = value
    return body


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="LLooM local CUDA audio adapter")
    parser.add_argument("--kind", required=True, choices=("tts", "stt"), help="model kind")
    parser.add_argument("--model", required=True, help="fixed model id served by this process")
    parser.add_argument(
        "--model-path",
        default=None,
        help="local model directory (TTS) or local Whisper checkpoint (STT)",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8220)
    parser.add_argument(
        "--hf-home", default=None, help="cache root override (kept for compatibility)"
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO)

    config = ServerConfig(
        kind=args.kind,
        model_id=args.model,
        model_path=args.model_path,
        host=args.host,
        port=args.port,
        hf_home=args.hf_home,
    )
    holder = ModelHolder(config)

    try:
        holder.load()
    except Exception:
        # Fatal: refuse to serve a half-initialised process.
        return 1

    app = create_app(holder)

    import uvicorn

    uvicorn.run(app, host=config.host, port=config.port, log_level="info", workers=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
