"""CPU tests for the ACE-Step backend contract.

The regression these guard: ComfyUI pinned bpm=100, keyscale="C major" and
timesignature="4" for every request. This backend must leave them unset so the
checkpoint infers them from the prompt.
"""
import io
import sys
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import (ApiError, SFT_STEPS, TURBO_STEPS, create_app,  # noqa: E402
                    parse_generation)


def wav_bytes(frames=480, channels=2, rate=48000):
    out = io.BytesIO()
    with wave.open(out, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * channels * frames)
    return out.getvalue()


class StubRunner:
    """Records the params it was handed so tests can assert the musical surface."""

    def __init__(self, is_turbo=False):
        self.is_turbo = is_turbo
        self.model_id = "ACE-Step/ACE-Step-1.5-XL-SFT"
        self.calls = []

    def generate(self, params, cancel):
        self.calls.append(params)
        return wav_bytes()


def client(is_turbo=False):
    runner = StubRunner(is_turbo)
    app = create_app(runner_factory=lambda: runner)
    return TestClient(app), runner


def test_musical_parameters_default_to_unset():
    params = parse_generation({"instructions": "solo piano, unhurried"}, SFT_STEPS)
    assert params["bpm"] is None
    assert params["keyscale"] is None
    assert params["timesignature"] is None


def test_lyrics_default_empty_for_instrumental():
    params = parse_generation({"instructions": "solo piano"}, SFT_STEPS)
    assert params["lyrics"] == ""


def test_accepts_prompt_alias_and_explicit_music_parameters():
    params = parse_generation({
        "prompt": "slow desert ambient",
        "bpm": 62,
        "keyscale": "E minor",
        "timesignature": "4",
        "duration": 90,
        "guidance_scale": 7.0,
        "shift": 3.0,
        "steps": 50,
        "seed": 7,
    }, SFT_STEPS)
    assert (params["bpm"], params["keyscale"], params["duration"]) == (62, "E minor", 90.0)
    assert params["guidance_scale"] == 7.0 and params["shift"] == 3.0


@pytest.mark.parametrize("payload", [
    {"instructions": "x", "bpm": 5},
    {"instructions": "x", "bpm": "fast"},
    {"instructions": "x", "keyscale": "H minor"},
    {"instructions": "x", "timesignature": "5"},
    {"instructions": "x", "duration": 0},
    {"instructions": "x", "duration": 10_000},
    {"instructions": "x", "steps": 0},
    {"instructions": "x", "seed": -1},
    {"instructions": "x", "language": "klingon"},
    {"instructions": "x", "response_format": "mp3"},
    {"instructions": "x", "surprise": 1},
    {"instructions": ""},
    {"lyrics": "no caption"},
])
def test_rejects_invalid_requests(payload):
    with pytest.raises(ApiError):
        parse_generation(payload, SFT_STEPS)


def test_duration_and_max_duration_must_agree():
    with pytest.raises(ApiError):
        parse_generation({"instructions": "x", "duration": 30, "max_duration": 60}, SFT_STEPS)
    params = parse_generation({"instructions": "x", "duration": 30, "max_duration": 30}, SFT_STEPS)
    assert params["duration"] == 30.0


def test_steps_default_follows_checkpoint_variant():
    assert parse_generation({"instructions": "x"}, SFT_STEPS)["steps"] == 50
    assert parse_generation({"instructions": "x"}, TURBO_STEPS)["steps"] == 8


def test_endpoint_returns_wav_and_forwards_parameters():
    api, runner = client()
    with api:
        response = api.post("/v1/audio/generations", json={
            "instructions": "solo piano, unhurried", "duration": 20, "seed": 3, "bpm": 58})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content[:4] == b"RIFF"
    assert runner.calls[-1]["bpm"] == 58
    assert runner.calls[-1]["keyscale"] is None


def test_health_and_models_report_readiness():
    api, _ = client()
    with api:
        assert api.get("/health").status_code == 200
        body = api.get("/v1/models").json()
        assert body["data"][0]["id"] == "ACE-Step/ACE-Step-1.5-XL-SFT"


def test_unready_backend_reports_503():
    app = create_app(runner_factory=lambda: StubRunner())
    api = TestClient(app)  # no context manager => lifespan never runs
    assert api.post("/v1/audio/generations", json={"instructions": "x"}).status_code == 503
