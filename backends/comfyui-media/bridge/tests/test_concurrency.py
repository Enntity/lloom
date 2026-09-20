"""One GPU slot for every modality; immediate 429 on overlap."""

from __future__ import annotations

import asyncio

from conftest import asgi_client, make_bridge
from fake_comfy import FakeComfy


def builder(model_id, payload, image_filename=None, prefix="lloom"):
    kind = "audio" if "audio" in model_id else "video"
    return {"9": {"class_type": "Save", "inputs": {}}}, "9", kind


async def test_second_request_is_429_while_first_runs():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        first = asyncio.ensure_future(
            client.post("/v1/videos/generations", json={"model": "video-model", "prompt": "one"})
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=2)
        assert app.state.bridge["runner"].busy is True

        second = await client.post("/v1/audio/generations", json={"model": "audio-model", "input": "two"})
        assert second.status_code == 429, second.text
        assert second.json()["error"]["type"] == "rate_limit_error"

        fake.finish()
        resp = await asyncio.wait_for(first, timeout=5)
        assert resp.status_code == 200, resp.text
        assert app.state.bridge["runner"].busy is False
        await comfy.aclose()


async def test_slot_released_after_failure_allows_retry():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()

        first = asyncio.ensure_future(
            client.post("/v1/videos/generations", json={"model": "video-model", "prompt": "one"})
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=2)
        fake.finish(error=True)
        resp = await asyncio.wait_for(first, timeout=5)
        assert resp.status_code == 502, resp.text
        assert app.state.bridge["runner"].busy is False

        # Slot must be usable again.
        fake.job_state = "running"
        fake.submitted.clear()
        fake.histories.clear()
        second = asyncio.ensure_future(
            client.post("/v1/videos/generations", json={"model": "video-model", "prompt": "two"})
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=2)
        fake.finish()
        resp2 = await asyncio.wait_for(second, timeout=5)
        assert resp2.status_code == 200, resp2.text
        await comfy.aclose()
