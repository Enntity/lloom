"""OpenAI-compatible TTS+STT server for LLooM with Qwen3-TTS discovery.

Supports:
  - CustomVoice (preset speakers + style instruct)
  - VoiceDesign (natural-language voice description via instruct)
  - Base voice clone (ref_audio + ref_text, JSON path or multipart upload)
  - Whisper / generic STT transcriptions
  - Discovery: /v1/audio/voices, /v1/audio/speech/schema, /health
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import tempfile
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, Response

app = FastAPI(title="LLooM Audio Server", version="1.1.0")

_tts_models: Dict[str, Any] = {}
_stt_models: Dict[str, Any] = {}

# Built-in Qwen3-TTS CustomVoice speakers (0.6B / 1.7B CustomVoice).
QWEN_CUSTOM_VOICES = [
    {"id": "serena", "name": "Serena", "gender": "female"},
    {"id": "vivian", "name": "Vivian", "gender": "female"},
    {"id": "uncle_fu", "name": "Uncle Fu", "gender": "male"},
    {"id": "ryan", "name": "Ryan", "gender": "male"},
    {"id": "aiden", "name": "Aiden", "gender": "male"},
    {"id": "ono_anna", "name": "Ono Anna", "gender": "female"},
    {"id": "sohee", "name": "Sohee", "gender": "female"},
    {"id": "eric", "name": "Eric", "gender": "male"},
    {"id": "dylan", "name": "Dylan", "gender": "male"},
]

VOICE_ALIASES = {
    "alloy": "serena",
    "echo": "aiden",
    "fable": "ryan",
    "onyx": "uncle_fu",
    "nova": "vivian",
    "shimmer": "sohee",
    "coral": "serena",
    "verse": "ryan",
    "ballad": "vivian",
    "ash": "aiden",
    "sage": "eric",
    "marin": "sohee",
    "cedar": "dylan",
    "chelsie": "serena",
    "ethan": "ryan",
    "default": "serena",
}


def _model_text(model_id: str) -> str:
    return str(model_id or "").lower()


def infer_tts_mode(model_id: str) -> str:
    text = _model_text(model_id)
    if "voicedesign" in text or "voice-design" in text or "voice_design" in text:
        return "voice_design"
    if "customvoice" in text or "custom-voice" in text or "custom_voice" in text:
        return "custom_voice"
    if "qwen3-tts" in text or "qwen3_tts" in text:
        if "base" in text or "clone" in text:
            return "voice_clone"
        # bare qwen3-tts without custom/design → base/clone family
        if "custom" not in text and "design" not in text:
            return "voice_clone"
    return "custom_voice"


def _load_tts(model_id: str):
    if model_id not in _tts_models:
        from mlx_audio.tts.utils import load_model

        _tts_models[model_id] = load_model(model_id)
    return _tts_models[model_id]


def _load_stt(model_id: str):
    if model_id not in _stt_models:
        from mlx_audio.stt.utils import load

        _stt_models[model_id] = load(model_id)
    return _stt_models[model_id]


def _resolve_voice(voice: Optional[str], mode: str) -> Optional[str]:
    if not voice:
        if mode == "custom_voice":
            return os.environ.get("LLOOM_TTS_VOICE", "serena")
        return None
    key = str(voice).strip().lower()
    return VOICE_ALIASES.get(key, voice)


def _audio_to_wav_bytes(audio, sample_rate: int) -> bytes:
    import soundfile as sf

    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.reshape(-1)
    arr = np.clip(arr, -1.0, 1.0)
    buf = io.BytesIO()
    sf.write(buf, arr, int(sample_rate), format="WAV")
    return buf.getvalue()


def _maybe_data_url_to_path(value: Optional[str], suffix: str = ".wav") -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    match = re.match(r"^data:([^;,]+)?(;base64)?,(.*)$", text, re.DOTALL)
    if not match:
        return text if os.path.exists(text) or not text.startswith("data:") else None
    raw_b64 = match.group(3)
    data = base64.b64decode(raw_b64)
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.write(data)
    tmp.close()
    return tmp.name


def _cleanup_paths(paths: List[str]) -> None:
    for path in paths:
        try:
            if path and path.startswith(tempfile.gettempdir()):
                os.unlink(path)
        except OSError:
            pass


def _speakers_for_model(model_id: str, model=None) -> List[Dict[str, Any]]:
    mode = infer_tts_mode(model_id)
    if mode != "custom_voice":
        return []
    if model is not None and hasattr(model, "get_supported_speakers"):
        try:
            names = list(model.get_supported_speakers() or [])
            if names:
                return [{"id": n, "name": n.replace("_", " ").title()} for n in names]
        except Exception:
            pass
    return list(QWEN_CUSTOM_VOICES)


def _speech_schema(model_id: str) -> Dict[str, Any]:
    mode = infer_tts_mode(model_id)
    voices = _speakers_for_model(model_id)
    base = {
        "object": "speech.schema",
        "model": model_id,
        "endpoint": "POST /v1/audio/speech",
        "family": "qwen3-tts" if "qwen" in _model_text(model_id) else "generic",
        "mode": mode,
        "modes": [mode],
        "sampleRate": 24000,
        "responseFormats": ["wav", "mp3", "flac", "opus", "aac", "pcm"],
        "voices": voices,
        "defaultVoice": voices[0]["id"] if voices else None,
        "voiceAliases": dict(VOICE_ALIASES) if mode == "custom_voice" else {},
    }
    if mode == "custom_voice":
        base["params"] = {
            "input": {"type": "string", "required": True},
            "voice": {
                "type": "string",
                "required": True,
                "enum": [v["id"] for v in voices],
                "default": base["defaultVoice"],
            },
            "instructions": {
                "type": "string",
                "required": False,
                "aliases": ["instruct"],
                "role": "style",
            },
            "language": {"type": "string", "required": False, "aliases": ["lang_code"]},
            "speed": {"type": "number", "required": False, "default": 1.0},
            "response_format": {"type": "string", "required": False, "default": "wav"},
        }
        base["acceptsMultipart"] = False
    elif mode == "voice_design":
        base["params"] = {
            "input": {"type": "string", "required": True},
            "instructions": {
                "type": "string",
                "required": True,
                "aliases": ["instruct"],
                "role": "voice_description",
            },
            "language": {"type": "string", "required": False, "aliases": ["lang_code"]},
            "response_format": {"type": "string", "required": False, "default": "wav"},
        }
        base["acceptsMultipart"] = False
    else:  # voice_clone
        base["params"] = {
            "input": {"type": "string", "required": True},
            "ref_audio": {
                "type": "audio",
                "required": True,
                "description": "Reference clip path, data URL, or multipart file field ref_audio.",
            },
            "ref_text": {
                "type": "string",
                "required": True,
                "description": "Transcript of the reference audio.",
            },
            "language": {"type": "string", "required": False, "aliases": ["lang_code"]},
            "response_format": {"type": "string", "required": False, "default": "wav"},
        }
        base["acceptsMultipart"] = True
    return base


async def _parse_speech_request(request: Request) -> Dict[str, Any]:
    """Return a normalized speech request dict; may include temporary ref_audio path."""
    content_type = request.headers.get("content-type", "")
    temps: List[str] = []

    if "multipart/form-data" in content_type:
        form = await request.form()
        body: Dict[str, Any] = {}
        for key, value in form.multi_items():
            if hasattr(value, "read"):
                raw = await value.read()
                suffix = Path(getattr(value, "filename", "") or "audio.wav").suffix or ".wav"
                tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
                tmp.write(raw)
                tmp.close()
                temps.append(tmp.name)
                body[key] = tmp.name
            else:
                body[key] = value
        body["_temp_paths"] = temps
        return body

    body = await request.json()
    if not isinstance(body, dict):
        raise ValueError("JSON body must be an object")
    body = dict(body)
    # data URL → temp file for ref_audio
    if isinstance(body.get("ref_audio"), str) and body["ref_audio"].startswith("data:"):
        path = _maybe_data_url_to_path(body["ref_audio"])
        if path:
            temps.append(path)
            body["ref_audio"] = path
            body["_temp_paths"] = temps
    return body


def _generate_speech(body: Dict[str, Any]) -> Response:
    model_id = body.get("model") or os.environ.get("LLOOM_TTS_MODEL")
    text = body.get("input") or body.get("text")
    if not model_id or not text:
        return JSONResponse({"error": "model and input required"}, status_code=400)

    mode = infer_tts_mode(model_id)
    instruct = body.get("instruct") if body.get("instruct") is not None else body.get("instructions")
    voice = _resolve_voice(body.get("voice"), mode)
    lang = body.get("language") or body.get("lang_code")
    ref_audio = body.get("ref_audio")
    ref_text = body.get("ref_text")
    speed = body.get("speed")
    response_format = (body.get("response_format") or "wav").lower()

    if mode == "voice_design" and not instruct:
        return JSONResponse(
            {
                "error": "VoiceDesign models require instructions (natural-language voice description).",
                "code": "missing_instructions",
            },
            status_code=400,
        )
    if mode == "voice_clone":
        if not ref_audio or not ref_text:
            return JSONResponse(
                {
                    "error": "Voice clone requires both ref_audio and ref_text.",
                    "code": "missing_clone_refs",
                },
                status_code=400,
            )
        if isinstance(ref_audio, str) and not os.path.exists(ref_audio):
            return JSONResponse(
                {"error": f"ref_audio not found: {ref_audio}", "code": "ref_audio_missing"},
                status_code=400,
            )

    model = _load_tts(model_id)
    gen_kwargs: Dict[str, Any] = {}
    if voice is not None and mode == "custom_voice":
        gen_kwargs["voice"] = voice
    if instruct is not None:
        gen_kwargs["instruct"] = instruct
    if lang is not None:
        gen_kwargs["lang_code"] = lang
    if speed is not None:
        gen_kwargs["speed"] = float(speed)
    if ref_audio is not None:
        gen_kwargs["ref_audio"] = ref_audio
    if ref_text is not None:
        gen_kwargs["ref_text"] = ref_text

    def _num(value, cast=float):
        if value is None or value == "":
            return None
        try:
            return cast(value)
        except (TypeError, ValueError):
            return None

    # Multipart form fields arrive as strings; coerce sampling knobs.
    temperature = _num(body.get("temperature"), float)
    top_p = _num(body.get("top_p"), float)
    top_k = _num(body.get("top_k"), int)
    repetition_penalty = _num(body.get("repetition_penalty"), float)
    max_tokens = _num(body.get("max_tokens"), int)
    if temperature is not None:
        gen_kwargs["temperature"] = temperature
    if top_p is not None:
        gen_kwargs["top_p"] = top_p
    if top_k is not None:
        gen_kwargs["top_k"] = top_k
    if repetition_penalty is not None:
        gen_kwargs["repetition_penalty"] = repetition_penalty
    if max_tokens is not None:
        gen_kwargs["max_tokens"] = max_tokens

    pieces = []
    sample_rate = 24000
    for result in model.generate(text, **gen_kwargs):
        pieces.append(np.asarray(result.audio))
        sample_rate = getattr(result, "sample_rate", sample_rate) or sample_rate
    audio = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.float32)
    data = _audio_to_wav_bytes(audio, sample_rate)
    # Always return WAV container for reliability; clients may request other formats later.
    media = "audio/wav" if response_format in ("wav", "wave", "pcm") else "audio/wav"
    return Response(
        content=data,
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="speech.wav"'},
    )


@app.get("/")
@app.get("/health")
def health():
    return {
        "ok": True,
        "name": "lloom-audio",
        "version": "1.1.0",
        "tts_loaded": list(_tts_models),
        "stt_loaded": list(_stt_models),
        "endpoints": {
            "speech": "/v1/audio/speech",
            "voices": "/v1/audio/voices",
            "speechSchema": "/v1/audio/speech/schema",
            "transcriptions": "/v1/audio/transcriptions",
        },
    }


@app.get("/v1/models")
def list_models():
    ids = sorted(set(list(_tts_models) + list(_stt_models)))
    return {"object": "list", "data": [{"id": m, "object": "model"} for m in ids]}


@app.get("/v1/audio/voices")
def tts_voices(model: Optional[str] = None):
    model_id = model or os.environ.get("LLOOM_TTS_MODEL")
    if not model_id:
        return JSONResponse({"error": "model query parameter required"}, status_code=400)
    mode = infer_tts_mode(model_id)
    loaded = _tts_models.get(model_id)
    voices = _speakers_for_model(model_id, loaded)
    return {
        "object": "list",
        "model": model_id,
        "mode": mode,
        "family": "qwen3-tts" if "qwen" in _model_text(model_id) else "generic",
        "defaultVoice": voices[0]["id"] if voices else None,
        "voiceAliases": dict(VOICE_ALIASES) if mode == "custom_voice" else {},
        "data": [{"object": "voice", **v} for v in voices],
    }


@app.get("/v1/audio/speech/schema")
def speech_schema(model: Optional[str] = None):
    model_id = model or os.environ.get("LLOOM_TTS_MODEL")
    if not model_id:
        return JSONResponse({"error": "model query parameter required"}, status_code=400)
    return _speech_schema(model_id)


@app.post("/v1/audio/speech")
async def speech(request: Request):
    temps: List[str] = []
    try:
        body = await _parse_speech_request(request)
        temps = list(body.pop("_temp_paths", []) or [])
        return _generate_speech(body)
    except Exception as exc:
        traceback.print_exc()
        return JSONResponse({"error": str(exc)}, status_code=500)
    finally:
        _cleanup_paths(temps)


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: Optional[str] = Form(None),
    language: Optional[str] = Form(None),
    response_format: Optional[str] = Form("json"),
    prompt: Optional[str] = Form(None),
):
    temps: List[str] = []
    try:
        model_id = model or os.environ.get("LLOOM_STT_MODEL")
        if not model_id:
            return JSONResponse({"error": "model required"}, status_code=400)
        stt = _load_stt(model_id)
        suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
        raw = await file.read()
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(raw)
            path = tmp.name
            temps.append(path)
        kwargs: Dict[str, Any] = {}
        if language:
            kwargs["language"] = language
        result = stt.generate(path, **kwargs)
        text = getattr(result, "text", None)
        if text is None and isinstance(result, dict):
            text = result.get("text", "")
        text = (text or "").strip()
        if (response_format or "json") == "text":
            return Response(content=text, media_type="text/plain")
        payload: Dict[str, Any] = {"text": text}
        if hasattr(result, "segments") and result.segments is not None:
            payload["segments"] = result.segments
        if hasattr(result, "language") and result.language is not None:
            payload["language"] = result.language
        return JSONResponse(payload)
    except Exception as exc:
        traceback.print_exc()
        return JSONResponse({"error": str(exc)}, status_code=500)
    finally:
        _cleanup_paths(temps)


def main():
    parser = argparse.ArgumentParser(description="LLooM audio (TTS/STT) server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8220)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", workers=1)


if __name__ == "__main__":
    main()
