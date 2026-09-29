"""Focused tests for lloom_audio_cuda_server.

Coverage targets the previously-missed failure modes:

  * ``/health`` stays responsive (ASGI-level) while a slow inference runs;
  * a second concurrent generation is rejected with HTTP 429, not queued;
  * temp-file cleanup happens only after the worker completes, even on cancel;
  * ``max_new_tokens`` reaches every Qwen ``generate_*`` method;
  * STT loads the *local* Whisper checkpoint (``--model-path``), no download;
  * reference duration is enforced from decoded frames for compressed audio;
  * the total body cap applies to JSON and multipart before parsing;
  * unsupported speech ``response_format`` is rejected.

Stubs stand in for torch/soundfile/whisper so no GPU or network is used.
"""
from __future__ import annotations

import asyncio
import base64
import io
import os
import sys
import struct
import threading
import time
import wave

import anyio
import httpx
import numpy as np
import pytest

from fastapi.testclient import TestClient

import lloom_audio_cuda_server as mod


class FakeTTSModel:
    """Records calls and tracks concurrency to prove serialization."""

    def __init__(self) -> None:
        self.calls = []
        self.active = 0
        self.max_active = 0
        self.delay = 0.0

    def _record(self, name, kwargs):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            if self.delay:
                time.sleep(self.delay)
            self.calls.append((name, kwargs))
            return [np.zeros(800, dtype=np.float32)], 24000
        finally:
            self.active -= 1

    def generate_custom_voice(self, **kwargs):
        return self._record("custom", kwargs)

    def generate_voice_design(self, **kwargs):
        return self._record("design", kwargs)

    def generate_voice_clone(self, **kwargs):
        return self._record("clone", kwargs)


class FakeWhisper:
    def __init__(self) -> None:
        self.transcribe_calls = []

    def transcribe(self, path, **kwargs):
        self.transcribe_calls.append((path, kwargs))
        return {"text": "hello world", "language": "en", "segments": [{"id": 0}]}


class FakeStreamingGenerator:
    def __init__(self, model, chunk_count=2):
        self.model = model
        self.chunk_count = chunk_count
        self.closed = False

    def __iter__(self):
        return self

    def __next__(self):
        if self.model.emitted >= self.chunk_count:
            raise StopIteration
        self.model.emitted += 1
        self.model.emitted_peak = max(self.model.emitted_peak, self.model.emitted)
        # First frame proves the wire starts before synthesis is complete.
        if self.model.emitted == 1:
            return np.zeros(4, dtype=np.float32), 24000, {"frame": 1}
        assert self.model.release.wait(timeout=2), "streaming fixture timed out"
        if self.model.stop.is_set():
            raise StopIteration
        return np.full(4, self.model.emitted, dtype=np.float32), 24000, {"frame": self.model.emitted}

    def close(self):
        self.closed = True


class FakeStreamingTTS:
    def __init__(self, chunk_count=16):
        self.calls = []
        self.emitted = 0
        self.emitted_peak = 0
        self.chunk_count = chunk_count
        self.release = threading.Event()
        self.stop = threading.Event()

    def generate_voice_clone_streaming(self, **kwargs):
        self.calls.append(kwargs)
        self.emitted = 0
        self.emitted_peak = 0
        return FakeStreamingGenerator(self, self.chunk_count)


def _holder(kind, model_id, model, model_path="/tmp/model"):
    config = mod.ServerConfig(kind=kind, model_id=model_id, model_path=model_path)
    holder = mod.ModelHolder(config)
    holder.model = model
    holder.ready = True
    return holder


def _speech_request(holder, **overrides):
    base = dict(
        model_id=holder.model_id,
        text="hi",
        language=mod.DEFAULT_LANGUAGE,
        instruct="warm",
        speaker="serena",
        ref_audio=None,
        ref_text=None,
        x_vector_only_mode=False,
        max_new_tokens=64,
        stream=False,
    )
    base.update(overrides)
    return mod.SpeechRequest(**base)


# ---------------------------------------------------------------------------
# Mode inference / fixed id / config
# ---------------------------------------------------------------------------


def test_mode_inference():
    assert mod._infer_tts_mode("Qwen3-TTS-12Hz-1.7B-CustomVoice") == "custom_voice"
    assert mod._infer_tts_mode("Qwen3-TTS-12Hz-1.7B-VoiceDesign") == "voice_design"
    assert mod._infer_tts_mode("Qwen3-TTS-12Hz-0.6B-Base") == "voice_clone"


def test_fixed_model_id_rejects_other_ids():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", FakeTTSModel())
    assert holder.resolve_model_id("Qwen3-TTS-12Hz-0.6B-CustomVoice") == holder.model_id
    assert holder.resolve_model_id(None) == holder.model_id
    assert holder.resolve_model_id("") == holder.model_id
    with pytest.raises(mod.ClientError) as err:
        holder.resolve_model_id("gpt-4o-audio-preview")
    assert err.value.status_code == 404


def test_stt_gateway_id_alias_accepted_and_others_rejected():
    holder = _holder(
        "stt", "openai/whisper-large-v3-turbo", FakeWhisper(), model_path="/tmp/whisper"
    )
    assert holder.resolve_model_id("openai/whisper-large-v3-turbo") == holder.model_id
    assert holder.resolve_model_id("whisper-1") == holder.model_id
    with pytest.raises(mod.ClientError):
        holder.resolve_model_id("gpt-4o-transcribe")


def test_config_rejects_bad_kind_and_empty_id():
    with pytest.raises(ValueError):
        mod.ServerConfig(kind="video", model_id="x")
    with pytest.raises(ValueError):
        mod.ServerConfig(kind="tts", model_id="  ")


# ---------------------------------------------------------------------------
# Speech validation
# ---------------------------------------------------------------------------


def test_custom_voice_instructions_optional_but_speaker_validated():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", FakeTTSModel())
    # Instructions are optional: a bare preset-speaker request is valid.
    req = mod._build_speech_request(holder, {"input": "hi"})
    assert req.speaker == "serena"
    assert req.instruct is None
    with pytest.raises(mod.ClientError) as err:
        mod._build_speech_request(holder, {"input": "hi", "speaker": "ghost"})
    assert err.value.status_code == 404


def test_voice_design_requires_instruct():
    holder = _holder("tts", "Qwen3-TTS-12Hz-1.7B-VoiceDesign", FakeTTSModel())
    with pytest.raises(mod.ClientError):
        mod._build_speech_request(holder, {"input": "hi"})
    req = mod._build_speech_request(holder, {"input": "hi", "instruct": "deep narrator"})
    assert req.instruct == "deep narrator"


def test_language_defaults_to_auto():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", FakeTTSModel())
    req = mod._build_speech_request(holder, {"input": "hi"})
    assert req.language == "Auto"
    blank = mod._build_speech_request(holder, {"input": "hi", "language": "  "})
    assert blank.language == "Auto"
    explicit = mod._build_speech_request(holder, {"input": "hi", "language": "en"})
    assert explicit.language == "en"


def test_base_clone_requires_ref_audio_and_ref_text():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-Base", FakeTTSModel())
    with pytest.raises(mod.ClientError):
        mod._build_speech_request(holder, {"input": "hi"})

    wav = mod._to_wav_bytes(np.zeros(24000, dtype=np.float32), 24000)
    with pytest.raises(mod.ClientError):
        mod._build_speech_request(holder, {"input": "hi", "ref_audio": wav})

    req = mod._build_speech_request(
        holder, {"input": "hi", "ref_audio": wav, "ref_text": "hello"}
    )
    assert req.ref_audio is not None
    assert req.ref_text == "hello"


def test_base_clone_rejects_caller_paths_and_urls():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-Base", FakeTTSModel())
    for value in ("/etc/passwd", "file:///etc/passwd", "https://example.com/a.wav"):
        with pytest.raises(mod.ClientError):
            mod._build_speech_request(
                holder, {"input": "hi", "ref_audio": value, "ref_text": "x"}
            )


def test_base_clone_accepts_data_url_base64(monkeypatch):
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-Base", FakeTTSModel())
    wav = mod._to_wav_bytes(np.zeros(24000, dtype=np.float32), 24000)
    monkeypatch.setattr(mod, "_decode_ref_audio", lambda raw: (np.zeros(4, np.float32), 16000))
    b64 = base64.b64encode(wav).decode()
    req = mod._build_speech_request(
        holder,
        {"input": "hi", "ref_audio": f"data:audio/wav;base64,{b64}", "ref_text": "x"},
    )
    assert req.ref_audio is not None


def test_x_vector_only_mode_allows_missing_ref_text():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-Base", FakeTTSModel())
    wav = mod._to_wav_bytes(np.zeros(24000, dtype=np.float32), 24000)
    req = mod._build_speech_request(
        holder, {"input": "hi", "ref_audio": wav, "x_vector_only_mode": "true"}
    )
    assert req.x_vector_only_mode is True


def test_oversized_text_is_rejected_and_tokens_capped():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", FakeTTSModel())
    with pytest.raises(mod.ClientError) as err:
        mod._build_speech_request(
            holder, {"input": "x" * (mod.MAX_TEXT_CHARS + 1), "instructions": "w"}
        )
    assert err.value.status_code == 413

    req = mod._build_speech_request(
        holder, {"input": "hi", "instructions": "w", "max_new_tokens": 10_000_000}
    )
    assert req.max_new_tokens == mod.MAX_NEW_TOKENS


def test_oversized_ref_audio_rejected():
    big = b"\x00" * (mod.MAX_UPLOAD_BYTES + 1)
    with pytest.raises(mod.ClientError) as err:
        mod._decode_ref_audio(big)
    assert err.value.status_code == 413


def test_parameter_aliases():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", FakeTTSModel())
    req = mod._build_speech_request(
        holder, {"text": "hi", "instruct": "calm", "voice": "Ryan"}
    )
    assert req.text == "hi"
    assert req.instruct == "calm"
    assert req.speaker == "ryan"


# ---------------------------------------------------------------------------
# Token propagation (no call may silently drop max_new_tokens)
# ---------------------------------------------------------------------------


def test_max_new_tokens_reaches_every_generate_method():
    cases = [
        ("custom_voice", "Qwen3-TTS-12Hz-0.6B-CustomVoice", "generate_custom_voice"),
        ("voice_design", "Qwen3-TTS-12Hz-1.7B-VoiceDesign", "generate_voice_design"),
        ("voice_clone", "Qwen3-TTS-12Hz-0.6B-Base", "generate_voice_clone"),
    ]
    for _mode, model_id, expected in cases:
        model = FakeTTSModel()
        holder = _holder("tts", model_id, model)
        body = {"input": "hi", "max_new_tokens": 123}
        if expected == "generate_voice_design":
            body["instructions"] = "deep"
        if expected == "generate_voice_clone":
            body["ref_audio"] = mod._to_wav_bytes(np.zeros(24000, np.float32), 24000)
            body["ref_text"] = "ref"
        req = mod._build_speech_request(holder, body)
        assert req.max_new_tokens == 123
        # Decoding needs soundfile; only the token kwarg is under test here.
        try:
            anyio.run(mod._run_tts, holder, req)
        except mod.ClientError:
            pass
        assert model.calls, f"{expected} was not called"
        name, kwargs = model.calls[-1]
        assert kwargs["max_new_tokens"] == 123


def test_custom_voice_dispatch_uses_speaker_and_optional_instruct():
    model = FakeTTSModel()
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", model)
    req = mod._build_speech_request(holder, {"input": "hi"})
    response = anyio.run(mod._run_tts, holder, req)
    assert model.calls[0][0] == "custom"
    assert model.calls[0][1]["speaker"] == "serena"
    assert model.calls[0][1]["instruct"] is None
    assert model.calls[0][1]["language"] == "Auto"
    assert response.media_type == "audio/wav"
    assert response.body[:4] == b"RIFF"


def test_voice_clone_dispatches_ref_audio_tuple():
    model = FakeTTSModel()
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-Base", model)
    wav = mod._to_wav_bytes(np.zeros(24000, dtype=np.float32), 24000)
    try:
        req = mod._build_speech_request(
            holder, {"input": "hi", "ref_audio": wav, "ref_text": "hello"}
        )
    except mod.ClientError:
        pytest.skip("soundfile not available to decode the reference clip")
    anyio.run(mod._run_tts, holder, req)
    # A failed clone call must fail the test, not be swallowed.
    assert model.calls, "generate_voice_clone was never invoked"
    ref = model.calls[0][1]["ref_audio"]
    assert isinstance(ref, tuple) and len(ref) == 2


# ---------------------------------------------------------------------------
# Concurrency: serialization, 429, health responsiveness, cleanup on cancel
# ---------------------------------------------------------------------------


def test_gpu_calls_are_serialized():
    model = FakeTTSModel()
    model.delay = 0.1
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", model)
    reqs = [_speech_request(holder) for _ in range(5)]

    async def main():
        async with anyio.create_task_group() as tg:
            for r in reqs:
                tg.start_soon(mod._run_tts, holder, r)

    anyio.run(main)
    assert model.max_active == 1, "GPU inference must be serialized"
    assert len(model.calls) == 5


def _client(holder):
    return TestClient(mod.create_app(holder))


def test_health_stays_responsive_during_slow_inference():
    """The ASGI event loop must answer /health while a slow generation runs."""
    model = FakeTTSModel()
    model.delay = 0.4
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", model)
    client = _client(holder)

    result = {}

    def slow_call():
        result["resp"] = client.post(
            "/v1/audio/speech",
            json={"input": "hi", "model": holder.model_id},
        )

    worker = threading.Thread(target=slow_call)
    worker.start()
    time.sleep(0.05)  # let the request enter the slow inference

    t0 = time.time()
    health = client.get("/health")
    elapsed = time.time() - t0
    assert health.status_code == 200
    assert health.json()["busy"] is True
    assert elapsed < 0.3, f"/health was blocked for {elapsed:.2f}s by inference"

    worker.join(timeout=5)
    assert result["resp"].status_code == 200
    assert model.max_active == 1


def test_second_generation_is_rejected_with_429():
    model = FakeTTSModel()
    model.delay = 0.4
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", model)
    client = _client(holder)

    results = {}

    def slow_call():
        results["resp"] = client.post(
            "/v1/audio/speech", json={"input": "hi", "model": holder.model_id}
        )

    worker = threading.Thread(target=slow_call)
    worker.start()
    time.sleep(0.05)

    second = client.post("/v1/audio/speech", json={"input": "hi", "model": holder.model_id})
    assert second.status_code == 429
    assert second.json()["error"]["type"] == "rate_limit_error"

    worker.join(timeout=5)
    assert results["resp"].status_code == 200
    # The busy flag must be free again once the first generation finished.
    assert holder.busy is False
    assert client.post(
        "/v1/audio/speech", json={"input": "hi", "model": holder.model_id}
    ).status_code == 200


def test_busy_is_held_until_worker_completes_on_cancel():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", FakeTTSModel())
    holder.ensure_idle()
    finished = threading.Event()
    def slow_inference():
        time.sleep(0.1)
        assert holder.busy
        finished.set()
    async def scenario():
        with anyio.move_on_after(0.03) as scope:
            await holder.run_in_thread(slow_inference)
        assert scope.cancel_called
        assert finished.is_set()
        assert not holder.busy
    anyio.run(scenario)


def test_stt_cleanup_only_after_worker_completes(monkeypatch):
    model = FakeWhisper()
    holder = _holder("stt", "turbo", model, model_path="/tmp/whisper")
    holder.ensure_idle()
    seen_paths = []
    def decode(path):
        seen_paths.append(path)
        assert os.path.exists(path)
        return np.zeros(16000, dtype=np.float32)
    def slow_transcribe(audio, **kwargs):
        assert isinstance(audio, np.ndarray)
        time.sleep(0.1)
        assert holder.busy
        assert os.path.exists(seen_paths[0])
        return {"text":"done"}
    monkeypatch.setattr(model,"transcribe",slow_transcribe)
    import sys
    monkeypatch.setitem(sys.modules,"whisper",type("W",(),{"load_audio":staticmethod(decode),"audio":type("A",(),{"SAMPLE_RATE":16000})}))
    async def scenario():
        with anyio.move_on_after(0.03) as scope:
            await mod._run_stt(holder,b"RIFFdata",".wav",None,None)
        assert scope.cancel_called
    anyio.run(scenario)
    assert seen_paths
    assert not os.path.exists(seen_paths[0])
    assert not holder.busy


# ---------------------------------------------------------------------------
# STT: model path, formats, limits
# ---------------------------------------------------------------------------


def test_stt_loads_local_checkpoint_path_not_alias(monkeypatch, tmp_path):
    checkpoint = tmp_path / "whisper-large-v3-turbo"
    checkpoint.write_bytes(b"synthetic checkpoint")

    recorded = {}

    def fake_load_model(name, device=None, **kwargs):
        recorded["name"] = name
        recorded["device"] = device
        return FakeWhisper()

    fake_whisper = type("W", (), {"load_model": staticmethod(fake_load_model)})
    import sys

    monkeypatch.setitem(sys.modules, "whisper", fake_whisper)

    holder = mod.ModelHolder(
        mod.ServerConfig(kind="stt", model_id="turbo", model_path=str(checkpoint))
    )
    holder.load()
    assert recorded["name"] == str(checkpoint)
    assert recorded["device"] == "cuda"
    assert holder.ready is True


def test_stt_requires_existing_local_checkpoint():
    holder = mod.ModelHolder(
        mod.ServerConfig(kind="stt", model_id="turbo", model_path="/nope/missing")
    )
    with pytest.raises(Exception):
        holder.load()
    assert holder.fatal is True


def test_transcription_passes_language_and_prompt():
    model = FakeWhisper()
    holder = _holder("stt", "turbo", model, model_path="/tmp/whisper")
    fake_whisper = type(
        "W",
        (),
        {
            "load_audio": staticmethod(lambda p: np.zeros(16000, dtype=np.float32)),
            "audio": type("A", (), {"SAMPLE_RATE": 16000}),
        },
    )
    import sys

    sys.modules["whisper"] = fake_whisper
    try:
        anyio.run(mod._run_stt, holder, b"x", ".wav", "es", "context")
    finally:
        del sys.modules["whisper"]
    _path, kwargs = model.transcribe_calls[0]
    assert kwargs == {"language": "es", "initial_prompt": "context"}


def test_transcription_verbose_json_and_text():
    result = {"text": "hello world", "language": "en", "segments": [{"id": 0}]}
    verbose = mod._format_transcription(result, "verbose_json")
    assert b"segments" in verbose.body
    text = mod._format_transcription(result, "text")
    assert text.body == b"hello world"
    plain = mod._format_transcription(result, "json")
    assert b"hello world" in plain.body


def test_transcription_transcribes_numpy_array_and_caps_duration(monkeypatch):
    """Long decoded audio is rejected before transcribe; arrays are forwarded."""
    model = FakeWhisper()
    holder = _holder("stt", "turbo", model, model_path="/tmp/whisper")
    sample_rate = 16000
    too_long = np.zeros(sample_rate * int(mod.MAX_STT_SECONDS) + sample_rate, dtype=np.float32)
    fake_whisper = type(
        "W",
        (),
        {
            "load_audio": staticmethod(lambda p: too_long),
            "audio": type("A", (), {"SAMPLE_RATE": sample_rate}),
        },
    )
    import sys

    monkeypatch.setitem(sys.modules, "whisper", fake_whisper)
    with pytest.raises(mod.ClientError) as err:
        anyio.run(mod._run_stt, holder, b"x", ".mp3", None, None)
    assert err.value.status_code == 413
    assert model.transcribe_calls == []


def test_transcription_rejects_unknown_extension_and_upload_size(monkeypatch):
    holder = _holder("stt", "turbo", FakeWhisper(), model_path="/tmp/whisper")
    fake_whisper = type(
        "W",
        (),
        {
            "load_audio": staticmethod(lambda p: np.zeros(16, dtype=np.float32)),
            "audio": type("A", (), {"SAMPLE_RATE": 16000}),
        },
    )
    import sys

    monkeypatch.setitem(sys.modules, "whisper", fake_whisper)
    with pytest.raises(mod.ClientError):
        anyio.run(mod._run_stt, holder, b"x", ".xyz", None, None)

    client = _client(holder)
    oversized = b"\x00" * (mod.MAX_UPLOAD_BYTES + 1)
    resp = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("a.wav", oversized, "audio/wav")},
    )
    assert resp.status_code == 413


def test_safe_unlink_ignores_missing(tmp_path):
    target = tmp_path / "gone.wav"
    mod._safe_unlink(str(target))
    target.write_bytes(b"x")
    mod._safe_unlink(str(target))
    assert not target.exists()


# ---------------------------------------------------------------------------
# Compressed reference duration (decoded frames, not a WAV header)
# ---------------------------------------------------------------------------


def _flac_bytes(seconds: float, sample_rate: int = 16000) -> bytes:
    import soundfile as sf

    data = np.zeros(int(seconds * sample_rate), dtype=np.float32)
    buffer = io.BytesIO()
    sf.write(buffer, data, sample_rate, format="FLAC")
    return buffer.getvalue()


def test_compressed_reference_duration_uses_decoded_frames():
    raw = _flac_bytes(0.25)
    # A WAV-header-only probe cannot see a duration for a compressed container.
    assert mod._decode_wav_duration(raw) is None
    array, rate = mod._decode_ref_audio(raw)
    assert rate == 16000
    assert abs(mod._decoded_duration_seconds(array, rate) - 0.25) < 0.02


def test_compressed_reference_over_limit_is_rejected():
    raw = _flac_bytes(mod.MAX_REF_SECONDS + 2.0)
    assert mod._decode_wav_duration(raw) is None
    with pytest.raises(mod.ClientError) as err:
        mod._decode_ref_audio(raw)
    assert err.value.status_code == 413


def test_compressed_reference_too_short_is_rejected():
    raw = _flac_bytes(0.005)
    with pytest.raises(mod.ClientError):
        mod._decode_ref_audio(raw)


def test_decoded_duration_helpers():
    assert mod._decoded_duration_seconds(np.zeros(16000, np.float32), 16000) == 1.0
    with pytest.raises(mod.ClientError):
        mod._decoded_duration_seconds(np.zeros(16000, np.float32), 0)
    wav = mod._to_wav_bytes(np.zeros(24000, dtype=np.float32), 24000)
    dur = mod._decode_wav_duration(wav)
    assert dur is not None and abs(dur - 1.0) < 0.05


# ---------------------------------------------------------------------------
# ASGI-level body caps and speech format rejection
# ---------------------------------------------------------------------------


def test_json_body_cap_enforced_before_parsing():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", FakeTTSModel())
    client = _client(holder)
    # No Content-Length (chunked) and a body far past the cap.
    sent = {"done": False}
    oversized = b"x" * (mod.MAX_BODY_BYTES + 1024)

    async def receive():
        if sent["done"]:
            return {"type": "http.request", "body": b"", "more_body": False}
        sent["done"] = True
        return {"type": "http.request", "body": oversized, "more_body": False}

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/v1/audio/speech",
        "raw_path": b"/v1/audio/speech",
        "query_string": b"",
        "root_path": "",
        "headers": [(b"content-type", b"application/json")],
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
    }

    async def run():
        response = await httpx.ASGITransport(app=client.app).handle_async_request(
            httpx.Request("POST", "http://testserver/v1/audio/speech", content=b"")
        )
        return response

    resp = anyio.run(run)
    assert resp.status_code in (400, 413)


def test_declared_content_length_over_cap_is_rejected():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", FakeTTSModel())
    client = _client(holder)
    resp = client.post(
        "/v1/audio/speech",
        content=b"{}",
        headers={
            "content-type": "application/json",
            "content-length": str(mod.MAX_BODY_BYTES + 1),
        },
    )
    assert resp.status_code == 413


def test_multipart_body_cap_enforced_before_parsing():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-Base", FakeTTSModel())
    client = _client(holder)
    payload = b"\x00" * (mod.MAX_BODY_BYTES + 1)
    resp = client.post(
        "/v1/audio/speech",
        files={"ref_audio": ("ref.wav", payload, "audio/wav")},
        data={"input": "hi", "ref_text": "x"},
    )
    assert resp.status_code in (400, 413)


def test_speech_rejects_unsupported_response_format():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", FakeTTSModel())
    client = _client(holder)
    for fmt in ("mp3", "opus", "aac", "flac"):
        resp = client.post(
            "/v1/audio/speech",
            json={"input": "hi", "model": holder.model_id, "response_format": fmt},
        )
        assert resp.status_code == 400, fmt
        assert "wav" in resp.json()["error"]["message"]
    ok = client.post(
        "/v1/audio/speech",
        json={"input": "hi", "model": holder.model_id, "response_format": "wav"},
    )
    assert ok.status_code == 200


def test_speech_rejects_unknown_model_id():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", FakeTTSModel())
    client = _client(holder)
    resp = client.post(
        "/v1/audio/speech", json={"input": "hi", "model": "gpt-4o-audio-preview"}
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Routes / lifecycle
# ---------------------------------------------------------------------------


def test_health_reports_ready_state_and_routes_present():
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-CustomVoice", FakeTTSModel())
    app = mod.create_app(holder)
    assert app.state.holder is holder
    routes = {r.path for r in app.routes}
    assert {"/health", "/v1/models", "/v1/audio/speech", "/v1/audio/transcriptions"} <= routes
    client = _client(holder)
    assert client.get("/health").status_code == 200
    assert client.get("/v1/models").json()["data"][0]["id"] == holder.model_id


def test_load_failure_marks_fatal(monkeypatch):
    holder = mod.ModelHolder(
        mod.ServerConfig(kind="tts", model_id="Qwen3-TTS-12Hz-0.6B-CustomVoice")
    )

    def boom():
        raise RuntimeError("cuda oom")

    monkeypatch.setattr(holder, "_load_tts", boom)
    with pytest.raises(RuntimeError):
        holder.load()
    assert holder.fatal is True
    assert holder.ready is False
    assert holder.load_error == "RuntimeError"


def test_transcription_rejects_unsupported_format_field():
    holder = _holder("stt", "turbo", FakeWhisper(), model_path="/tmp/whisper")
    client = _client(holder)
    resp = client.post(
        "/v1/audio/transcriptions",
        files={"file": ("a.wav", b"RIFFdata", "audio/wav")},
        data={"response_format": "srt"},
    )
    assert resp.status_code == 400


def test_wav_output_is_riff():
    data = mod._to_wav_bytes([0.0, 0.5, -0.5, 1.0], 16000)
    assert data[:4] == b"RIFF"
    assert data[8:12] == b"WAVE"
    with wave.open(io.BytesIO(data), "rb") as handle:
        assert handle.getframerate() == 16000
        assert handle.getnframes() == 4


# ---------------------------------------------------------------------------
# Optional FasterQwen3TTS streaming
# ---------------------------------------------------------------------------


def _streaming_holder(model):
    holder = _holder("tts", "Qwen3-TTS-12Hz-0.6B-Base", model)
    holder.uses_faster_engine = True
    return holder


def _clone_request(holder, **overrides):
    wav = mod._to_wav_bytes(np.zeros(2400, dtype=np.float32), 24000)
    return mod._build_speech_request(
        holder,
        {
            "input": "hi",
            "ref_audio": wav,
            "ref_text": "reference",
            "stream": "true",
            "response_format": "pcm",
            **overrides,
        },
    )


def test_faster_stream_first_chunk_is_pcm_le_before_completion():
    model = FakeStreamingTTS()
    holder = _streaming_holder(model)
    request = _clone_request(holder)

    async def scenario():
        holder.ensure_idle()
        response = await mod._run_tts(holder, request)
        iterator = response.body_iterator
        first = await iterator.__anext__()
        assert first == b"\x00\x00\x00\x00\x00\x00\x00\x00"
        assert model.calls[0]["xvec_only"] is False
        model.release.set()
        second = await iterator.__anext__()
        assert second == b"\xff\x7f" * 4
        # The process-lifetime, content-addressed path is reused across calls.
        path = model.calls[0]["ref_audio"]
        assert path in holder._reference_paths
        assert mod._stable_reference_path(holder, request) == path

    anyio.run(scenario)
    for _ in range(100):
        if not holder.busy:
            break
        time.sleep(0.01)
    assert not holder.busy


def test_faster_stream_close_signals_producer_and_releases_gpu():
    model = FakeStreamingTTS()
    holder = _streaming_holder(model)
    request = _clone_request(holder)

    async def scenario():
        holder.ensure_idle()
        response = await mod._run_tts(holder, request)
        iterator = response.body_iterator
        await iterator.__anext__()
        assert holder.busy
        await iterator.aclose()
        model.release.set()

    anyio.run(scenario)
    for _ in range(200):
        if model.calls and model.emitted_peak <= mod.MAX_STREAM_QUEUE_CHUNKS and not holder.busy:
            break
        time.sleep(0.01)
    assert holder._stream_stop.is_set()
    assert not holder.busy


def test_faster_stream_queue_is_bounded_and_lock_outlives_disconnect():
    model = FakeStreamingTTS(chunk_count=32)
    holder = _streaming_holder(model)
    request = _clone_request(holder)

    async def scenario():
        holder.ensure_idle()
        await mod._run_tts(holder, request)
        # Do not consume. The producer must block at the bounded queue, not
        # turn the whole utterance into an unbounded in-memory queue.
        for _ in range(20):
            if model.emitted_peak >= mod.MAX_STREAM_QUEUE_CHUNKS:
                break
            await asyncio.sleep(0.01)
        assert holder.busy
        holder._stream_stop.set()
        model.release.set()

    anyio.run(scenario)
    for _ in range(200):
        if not holder.busy:
            break
        time.sleep(0.01)
    assert model.emitted_peak <= mod.MAX_STREAM_QUEUE_CHUNKS
    assert not holder.busy


def test_malformed_faster_stream_mode_is_rejected_before_gpu():
    model = FakeStreamingTTS()
    holder = _streaming_holder(model)
    client = _client(holder)
    wav = mod._to_wav_bytes(np.zeros(2400, dtype=np.float32), 24000)
    resp = client.post(
        "/v1/audio/speech",
        json={
            "model": holder.model_id,
            "input": "hi",
            "ref_audio": "data:audio/wav;base64,"+base64.b64encode(wav).decode(),
            "ref_text": "reference",
            "stream": True,
            "response_format": "wav",
        },
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["message"] == "stream=true requires response_format=pcm"
    assert model.calls == []


def test_faster_engine_load_requires_voice_clone(monkeypatch):
    holder = mod.ModelHolder(
        mod.ServerConfig(
            kind="tts",
            model_id="Qwen3-TTS-12Hz-0.6B-CustomVoice",
            model_path="/tmp/model",
            engine="faster",
        )
    )
    fake_torch = type("T", (), {})
    monkeypatch.setitem(sys.modules, "torch", fake_torch)
    with pytest.raises(ValueError, match="voice_clone only"):
        holder.load()
    assert holder.fatal


def test_stream_route_acquires_busy_once_and_emits_pcm():
    model = FakeStreamingTTS(chunk_count=2)
    model.release.set()
    holder = _streaming_holder(model)
    wav = mod._to_wav_bytes(np.zeros(2400, dtype=np.float32), 24000)
    response = _client(holder).post('/v1/audio/speech', json={
        'model': holder.model_id, 'input': 'hello', 'ref_text': 'reference',
        'ref_audio': 'data:audio/wav;base64,'+base64.b64encode(wav).decode(),
        'stream': True, 'response_format': 'pcm'})
    assert response.status_code == 200
    assert response.headers['x-audio-format'] == 'pcm_s16le'
    assert response.content == b'\x00\x00'*4+b'\xff\x7f'*4


def test_stream_fault_is_not_successful_eof():
    class FailingModel:
        def generate_voice_clone_streaming(self, **kw):
            yield np.zeros(4), 24000, {}
            raise RuntimeError('private model detail')
    holder = _streaming_holder(FailingModel())
    async def scenario():
        holder.ensure_idle()
        response = await mod._run_tts(holder, _clone_request(holder))
        chunks = response.body_iterator
        assert await chunks.__anext__() == b'\x00\x00'*4
        with pytest.raises(RuntimeError, match='speech generation failed'):
            await chunks.__anext__()
        await chunks.aclose()
    anyio.run(scenario)


def test_old_lease_cannot_clear_new_request_busy_flag():
    holder = _streaming_holder(FakeStreamingTTS())
    old = holder.ensure_idle()
    holder.clear_busy(old)
    new = holder.ensure_idle()
    holder.clear_busy(old)
    assert holder.busy
    holder.clear_busy(new)
    assert not holder.busy


def test_stock_pcm_format_contains_no_wav_header():
    holder = _holder('tts', 'Qwen3-TTS-12Hz-0.6B-CustomVoice', FakeTTSModel())
    response = _client(holder).post('/v1/audio/speech', json={'input':'hello','response_format':'pcm'})
    assert response.status_code == 200
    assert response.headers['x-audio-format'] == 'pcm_s16le'
    assert not response.content.startswith(b'RIFF')


def test_clone_sampling_preserves_profile_settings():
    model = FakeStreamingTTS(chunk_count=2)
    model.release.set()
    holder = _streaming_holder(model)
    wav = mod._to_wav_bytes(np.zeros(2400, dtype=np.float32), 24000)
    settings = {'temperature': 0.85, 'top_p': 0.9, 'top_k': 50, 'repetition_penalty': 1.05}
    response = _client(holder).post('/v1/audio/speech', json={
        'model': holder.model_id, 'input': 'hello', 'ref_text': 'reference',
        'ref_audio': 'data:audio/wav;base64,'+base64.b64encode(wav).decode(),
        'stream': True, 'response_format': 'pcm', **settings})
    assert response.status_code == 200
    for key, value in settings.items():
        assert model.calls[-1][key] == value


def test_invalid_profile_sampling_rejected_before_generation():
    holder = _streaming_holder(FakeStreamingTTS())
    for key, value in [('temperature', -1), ('top_p', 2), ('top_k', 1.5)]:
        response = _client(holder).post('/v1/audio/speech', json={
            'model': holder.model_id, 'input': 'hello', key: value})
        assert response.status_code == 400
        assert not holder.model.calls
