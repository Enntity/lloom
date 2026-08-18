"""OpenAI-compatible Chatterbox TTS server for LLooM.

Supports:
  - English clone (ResembleAI/chatterbox)
  - Multilingual clone (ResembleAI/chatterbox-multilingual)
  - Turbo clone (ResembleAI/chatterbox-turbo; exaggeration/CFG ignored)
  - Named LLooM voices via ref_audio / audio_prompt_path
  - exaggeration, cfg_weight, temperature, top_p, min_p, repetition_penalty
  - language / language_id for the multilingual checkpoint
  - JSON and multipart /v1/audio/speech
  - Discovery: /v1/audio/voices, /v1/audio/speech/schema, /health

ResembleAI's upstream Perth implicit watermarking remains enabled.
"""
from __future__ import annotations

import argparse
import base64
import io
import os
import re
import tempfile
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

app = FastAPI(title="LLooM Chatterbox TTS", version="1.0.0")

_tts_models: Dict[str, Any] = {}

SPEECH_RESPONSE_FORMATS = ["wav", "mp3", "flac", "opus", "aac", "pcm"]

MULTILINGUAL_LANGUAGES = {
    "ar": "Arabic",
    "da": "Danish",
    "de": "German",
    "el": "Greek",
    "en": "English",
    "es": "Spanish",
    "fi": "Finnish",
    "fr": "French",
    "he": "Hebrew",
    "hi": "Hindi",
    "it": "Italian",
    "ja": "Japanese",
    "ko": "Korean",
    "ms": "Malay",
    "nl": "Dutch",
    "no": "Norwegian",
    "pl": "Polish",
    "pt": "Portuguese",
    "ru": "Russian",
    "sv": "Swedish",
    "sw": "Swahili",
    "tr": "Turkish",
    "zh": "Chinese",
}

ENGLISH_FILES = (
    "ve.safetensors",
    "t3_cfg.safetensors",
    "s3gen.safetensors",
    "tokenizer.json",
)
MULTILINGUAL_FILES = (
    "ve.pt",
    "t3_mtl23ls_v2.safetensors",
    "s3gen.pt",
    "grapheme_mtl_merged_expanded_v1.json",
)


def _model_text(model_id: str) -> str:
    return str(model_id or "").lower().replace("_", "-")


def infer_variant(model_id: str) -> str:
    text = _model_text(model_id)
    if "turbo" in text:
        return "turbo"
    if "multilingual" in text or "mtl" in text:
        return "multilingual"
    return "english"


def select_device() -> str:
    requested = (os.environ.get("LLOOM_CHATTERBOX_DEVICE") or "").strip().lower()
    if requested in {"cpu", "mps", "cuda"}:
        return requested
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def _dir_has(path: Optional[str], names: tuple[str, ...]) -> bool:
    if not path:
        return False
    root = Path(path)
    return root.is_dir() and all((root / name).exists() for name in names)


def ckpt_dir_for(variant: str) -> Optional[str]:
    if variant == "turbo":
        candidates = [
            os.environ.get("LLOOM_CHATTERBOX_TURBO_CKPT_DIR"),
            os.environ.get("LLOOM_CHATTERBOX_CKPT_DIR"),
        ]
        for candidate in candidates:
            if candidate and Path(candidate).is_dir():
                return candidate
        return None
    primary = os.environ.get("LLOOM_CHATTERBOX_CKPT_DIR")
    required = MULTILINGUAL_FILES if variant == "multilingual" else ENGLISH_FILES
    if _dir_has(primary, required):
        return primary
    if primary and Path(primary).is_dir() and variant != "multilingual":
        return primary
    return None


def _load_tts(model_id: str):
    if model_id in _tts_models:
        return _tts_models[model_id]
    variant = infer_variant(model_id)
    device = select_device()
    ckpt = ckpt_dir_for(variant)
    print(f"loading chatterbox variant={variant} device={device} ckpt={ckpt or 'huggingface'}", flush=True)

    if variant == "turbo":
        from chatterbox.tts_turbo import ChatterboxTurboTTS

        model = (
            ChatterboxTurboTTS.from_local(ckpt, device)
            if ckpt
            else ChatterboxTurboTTS.from_pretrained(device)
        )
    elif variant == "multilingual":
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS

        model = (
            ChatterboxMultilingualTTS.from_local(ckpt, device)
            if ckpt
            else ChatterboxMultilingualTTS.from_pretrained(device)
        )
    else:
        from chatterbox.tts import ChatterboxTTS

        model = ChatterboxTTS.from_local(ckpt, device) if ckpt else ChatterboxTTS.from_pretrained(device)

    _tts_models[model_id] = model
    return model


def _audio_to_wav_bytes(audio, sample_rate: int) -> bytes:
    import soundfile as sf

    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.reshape(-1)
    arr = np.clip(arr, -1.0, 1.0)
    buf = io.BytesIO()
    sf.write(buf, arr, int(sample_rate), format="WAV", subtype="PCM_16")
    return buf.getvalue()


def _maybe_data_url_to_path(value: Optional[str], suffix: str = ".wav") -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    match = re.match(r"^data:([^;,]+)?(;base64)?,(.*)$", text, re.DOTALL)
    if not match:
        return text if os.path.exists(text) or not text.startswith("data:") else None
    data = base64.b64decode(match.group(3))
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


def _num(value, cast=float):
    if value is None or value == "":
        return None
    try:
        return cast(value)
    except (TypeError, ValueError):
        return None


def _speech_schema(model_id: str) -> Dict[str, Any]:
    variant = infer_variant(model_id)
    languages = sorted(MULTILINGUAL_LANGUAGES) if variant == "multilingual" else ["en"]
    params: Dict[str, Any] = {
        "input": {"type": "string", "required": True, "description": "Text to synthesize.", "maxLength": 4096},
        "voice": {
            "type": "string",
            "required": False,
            "description": "Named LLooM voice profile, or omit and pass ref_audio.",
        },
        "ref_audio": {
            "type": "audio",
            "required": False,
            "aliases": ["audio_prompt_path"],
            "description": "Reference clip for zero-shot clone. JSON path/data URL or multipart field ref_audio.",
            "contentTypes": ["audio/wav", "audio/mpeg", "audio/flac", "audio/ogg"],
        },
        "ref_text": {
            "type": "string",
            "required": False,
            "description": "Optional transcript of the reference clip. Chatterbox does not require it.",
        },
        "exaggeration": {
            "type": "number",
            "required": False,
            "minimum": 0,
            "maximum": 2,
            "default": 0.5 if variant != "turbo" else 0,
            "description": "Emotion / intensity. The main acting knob. Ignored by turbo.",
        },
        "cfg_weight": {
            "type": "number",
            "required": False,
            "aliases": ["cfgWeight"],
            "minimum": 0,
            "maximum": 1,
            "default": 0.5 if variant != "turbo" else 0,
            "description": "Classifier-free guidance. Lower stays closer to the reference. Ignored by turbo.",
        },
        "temperature": {"type": "number", "required": False, "minimum": 0.05, "maximum": 2, "default": 0.8},
        "top_p": {"type": "number", "required": False, "minimum": 0, "maximum": 1, "default": 1 if variant != "turbo" else 0.95},
        "min_p": {"type": "number", "required": False, "minimum": 0, "maximum": 1, "default": 0.05 if variant != "turbo" else 0},
        "repetition_penalty": {"type": "number", "required": False, "minimum": 1, "maximum": 3, "default": 1.2},
        "language": {
            "type": "string",
            "required": variant == "multilingual",
            "aliases": ["language_id", "lang_code"],
            "enum": languages,
            "default": "en",
            "description": "Spoken language id. Required for the multilingual checkpoint.",
        },
        "speed": {"type": "number", "required": False, "minimum": 0.5, "maximum": 2, "default": 1},
        "response_format": {
            "type": "string",
            "required": False,
            "enum": SPEECH_RESPONSE_FORMATS,
            "default": "wav",
        },
    }
    if variant == "turbo":
        params["top_k"] = {"type": "integer", "required": False, "minimum": 1, "default": 1000}
    return {
        "object": "speech.schema",
        "model": model_id,
        "endpoint": "POST /v1/audio/speech",
        "family": "chatterbox",
        "mode": "voice_clone",
        "modes": ["voice_clone"],
        "variant": variant,
        "sampleRate": 24000,
        "responseFormats": list(SPEECH_RESPONSE_FORMATS),
        "voices": [],
        "defaultVoice": None,
        "voiceAliases": {},
        "languages": languages,
        "acceptsMultipart": True,
        "params": params,
    }


async def _parse_speech_request(request: Request) -> Dict[str, Any]:
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
    ref = body.get("ref_audio") or body.get("audio_prompt_path")
    if isinstance(ref, str) and ref.startswith("data:"):
        path = _maybe_data_url_to_path(ref)
        if path:
            temps.append(path)
            body["ref_audio"] = path
            body["_temp_paths"] = temps
    return body


def _generate_speech(body: Dict[str, Any]) -> Response:
    model_id = body.get("model") or os.environ.get("LLOOM_TTS_MODEL") or "ResembleAI/chatterbox"
    text = body.get("input") or body.get("text")
    if not text:
        return JSONResponse({"error": "input required", "code": "missing_input"}, status_code=400)

    variant = infer_variant(model_id)
    ref_audio = body.get("ref_audio") or body.get("audio_prompt_path")
    if isinstance(ref_audio, str) and ref_audio and not os.path.exists(ref_audio):
        return JSONResponse(
            {"error": f"ref_audio not found: {ref_audio}", "code": "ref_audio_missing"},
            status_code=400,
        )

    language = body.get("language_id") or body.get("language") or body.get("lang_code")
    if variant == "multilingual":
        language = (language or "en").lower()
        if language not in MULTILINGUAL_LANGUAGES:
            return JSONResponse(
                {
                    "error": f"Unsupported language_id '{language}'.",
                    "code": "unsupported_language",
                    "supported": sorted(MULTILINGUAL_LANGUAGES),
                },
                status_code=400,
            )

    model = _load_tts(model_id)
    if not ref_audio and getattr(model, "conds", None) is None:
        return JSONResponse(
            {
                "error": "Voice clone requires ref_audio (or a named LLooM voice profile).",
                "code": "missing_clone_refs",
            },
            status_code=400,
        )

    exaggeration = _num(body.get("exaggeration"), float)
    cfg_weight = _num(body.get("cfg_weight") if body.get("cfg_weight") is not None else body.get("cfgWeight"), float)
    temperature = _num(body.get("temperature"), float)
    top_p = _num(body.get("top_p"), float)
    min_p = _num(body.get("min_p"), float)
    repetition_penalty = _num(body.get("repetition_penalty"), float)
    top_k = _num(body.get("top_k"), int)

    gen_kwargs: Dict[str, Any] = {}
    if ref_audio:
        gen_kwargs["audio_prompt_path"] = ref_audio
    if exaggeration is not None:
        gen_kwargs["exaggeration"] = exaggeration
    if cfg_weight is not None:
        gen_kwargs["cfg_weight"] = cfg_weight
    if temperature is not None:
        gen_kwargs["temperature"] = temperature
    if top_p is not None:
        gen_kwargs["top_p"] = top_p
    if min_p is not None:
        gen_kwargs["min_p"] = min_p
    if repetition_penalty is not None:
        gen_kwargs["repetition_penalty"] = repetition_penalty
    if variant == "multilingual":
        gen_kwargs["language_id"] = language
    if variant == "turbo" and top_k is not None:
        gen_kwargs["top_k"] = top_k

    wav = model.generate(text, **gen_kwargs)
    if hasattr(wav, "detach"):
        wav = wav.detach().cpu().numpy()
    sample_rate = int(getattr(model, "sr", 24000) or 24000)
    data = _audio_to_wav_bytes(wav, sample_rate)
    return Response(
        content=data,
        media_type="audio/wav",
        headers={"Content-Disposition": 'attachment; filename="speech.wav"'},
    )


@app.get("/")
@app.get("/health")
def health():
    return {
        "ok": True,
        "name": "lloom-chatterbox",
        "version": "1.0.0",
        "device": select_device(),
        "tts_loaded": list(_tts_models),
        "endpoints": {
            "speech": "/v1/audio/speech",
            "voices": "/v1/audio/voices",
            "speechSchema": "/v1/audio/speech/schema",
        },
    }


@app.get("/v1/models")
def list_models():
    advertised = [
        os.environ.get("LLOOM_TTS_MODEL") or "ResembleAI/chatterbox",
        "ResembleAI/chatterbox",
        "ResembleAI/chatterbox-multilingual",
        "ResembleAI/chatterbox-turbo",
        *_tts_models.keys(),
    ]
    ids = sorted(set(advertised))
    return {"object": "list", "data": [{"id": model_id, "object": "model"} for model_id in ids]}


@app.get("/v1/audio/voices")
def tts_voices(model: Optional[str] = None):
    model_id = model or os.environ.get("LLOOM_TTS_MODEL") or "ResembleAI/chatterbox"
    return {
        "object": "list",
        "model": model_id,
        "mode": "voice_clone",
        "family": "chatterbox",
        "variant": infer_variant(model_id),
        "defaultVoice": None,
        "voiceAliases": {},
        "data": [],
    }


@app.get("/v1/audio/speech/schema")
def speech_schema(model: Optional[str] = None):
    model_id = model or os.environ.get("LLOOM_TTS_MODEL") or "ResembleAI/chatterbox"
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


def main():
    parser = argparse.ArgumentParser(description="LLooM Chatterbox TTS server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8221)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", workers=1)


if __name__ == "__main__":
    main()
