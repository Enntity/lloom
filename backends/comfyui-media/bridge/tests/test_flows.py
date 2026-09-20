"""Happy paths and API-shape checks across all modalities."""

from __future__ import annotations

import asyncio
import base64

import httpx

from conftest import asgi_client, make_bridge, png_data_uri
from fake_comfy import audio_graph_builder


def video_builder(model_id, payload, image_filename=None, prefix="lloom"):
    video_builder.upload_seen = image_filename
    return {"9": {"class_type": "SaveVideo", "inputs": {"fps": payload.get("fps", 24)}}}, "9", "video"


async def _drain(app, fake):
    """Let the background feed loop finish before we look at the history."""

    async def finish_soon():
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        await asyncio.sleep(0.02)
        fake.finish()

    task = asyncio.ensure_future(finish_soon())
    return task


async def test_health_ok_and_models():
    fake = None
    from fake_comfy import FakeComfy

    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.get("/health")
        assert resp.status_code == 200, resp.text
        assert resp.json()["backend_ready"] is True
        assert resp.json()["busy"] is False

        models = await client.get("/v1/models")
        assert models.status_code == 200
        ids = {entry["id"] for entry in models.json()["data"]}
        assert ids == {"video-model", "audio-model"}
        assert models.json()["object"] == "list"
        await comfy.aclose()


async def test_health_degraded_when_backend_down():
    from fake_comfy import FakeComfy

    fake = FakeComfy(ready=False)
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.get("/health")
        assert resp.status_code == 503
        assert resp.json()["backend_ready"] is False
        await comfy.aclose()


async def test_video_generation_happy_path():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=b"\x00\x00\x00\x18ftypmp42-video")
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = await _drain(app, fake)
        resp = await client.post(
            "/v1/videos/generations",
            json={"model": "video-model", "prompt": "a fox", "duration": 4, "seed": 11},
        )
        await finisher
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert "created" in body
        assert len(body["data"]) == 1
        item = body["data"][0]
        assert item["mime_type"] == "video/mp4"
        assert base64.b64decode(item["b64_json"]) == fake.artifact
        assert fake.view_requests and fake.view_requests[0]["filename"] == "lloom_00001.mp4"
        assert "subfolder" in fake.view_requests[0] and "type" in fake.view_requests[0]
        assert app.state.bridge["runner"].busy is False
        await comfy.aclose()


async def test_audio_speech_returns_wav_and_passes_fields():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=b"RIFF....WAVE")
    seen = {}

    def builder(model_id, payload, image_filename=None, prefix="lloom"):
        seen["payload"] = payload
        seen["model"] = model_id
        return {"9": {"class_type": "SaveAudio", "inputs": {}}}, "9", "audio"

    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = await _drain(app, fake)
        resp = await client.post(
            "/v1/audio/generations",
            json={
                "model": "audio-model",
                "input": "la la la",
                "instructions": "warm female vocal",
                "duration": 12,
                "seed": 7,
            },
        )
        await finisher
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("audio/wav")
        assert resp.content == fake.artifact
        assert seen["payload"]["duration"] == 12 and seen["payload"]["seed"] == 7
        assert seen["model"] == "audio-model"
        await comfy.aclose()


async def test_audio_generations_alias_returns_wav():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=b"RIFFxxxxWAVE")
    app, comfy = make_bridge(fake, audio_graph_builder("audio"))
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = await _drain(app, fake)
        resp = await client.post("/v1/audio/generations", json={"model": "audio-model", "input": "hey"})
        await finisher
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("audio/wav")
        assert resp.content == fake.artifact
        await comfy.aclose()


async def test_video_with_inline_png_is_uploaded():
    from fake_comfy import FakeComfy

    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = await _drain(app, fake)
        resp = await client.post(
            "/v1/videos/generations",
            json={"model": "video-model", "prompt": "animate", "image": png_data_uri(12, 12)},
        )
        await finisher
        assert resp.status_code == 200, resp.text
        assert fake.uploaded, "image was never uploaded to Comfy"
        name, payload, ctype = fake.uploaded[0]
        assert name.startswith("lloom-") and name.endswith(".png")
        assert ctype.startswith("multipart/form-data")
        assert len(payload) > 0
        # build_graph received the Comfy-relative name, not a local path.
        assert video_builder.upload_seen == name
        await comfy.aclose()
