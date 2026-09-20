"""Backend failure translation: poll errors, failed jobs, timeouts, bad refs."""

from __future__ import annotations

import asyncio

import httpx

from conftest import asgi_client, make_bridge
from fake_comfy import FakeComfy


def video_builder(model_id, payload, image_filename=None, prefix="lloom"):
    return {"9": {"class_type": "SaveVideo", "inputs": {}}}, "9", "video"


async def _run(client, fake, *, finisher=None, timeout=8):
    task = asyncio.ensure_future(
        client.post("/v1/videos/generations", json={"model": "video-model", "prompt": "x"})
    )
    await asyncio.wait_for(fake.submitted.wait(), timeout=3)
    if finisher is not None:
        await finisher()
    return await asyncio.wait_for(task, timeout=timeout)


async def test_history_poll_error_marks_unhealthy_503():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()

        async def fail_polls():
            await asyncio.sleep(0.02)
            fake.history_failures = 1000

        resp = await _run(client, fake, finisher=fail_polls)
        assert resp.status_code == 503, resp.text
        assert app.state.bridge["runner"].unhealthy is True
        # Slot stays held so no second GPU job can start.
        assert app.state.bridge["runner"].busy is True

        blocked = await client.post(
            "/v1/videos/generations", json={"model": "video-model", "prompt": "again"}
        )
        assert blocked.status_code in (429, 503), blocked.text
        fake.history_failures = 0
        await asyncio.sleep(0.05)
        await comfy.aclose()


async def test_failed_job_is_502_and_slot_freed():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()

        async def fail_job():
            await asyncio.sleep(0.02)
            fake.finish(error=True)

        resp = await _run(client, fake, finisher=fail_job)
        assert resp.status_code == 502, resp.text
        assert "error" in resp.json()
        assert app.state.bridge["runner"].busy is False
        await comfy.aclose()


async def test_prompt_rejected_by_backend_is_502_without_leaking_body():
    fake = FakeComfy()

    async def reject(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/prompt":
            return httpx.Response(400, json={"error": {"message": "/srv/comfy/secret.py line 9"}})
        return await fake.handler(request)

    fake.handler_original = fake.handler
    fake.handler = reject
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post(
            "/v1/videos/generations", json={"model": "video-model", "prompt": "x"}
        )
        assert resp.status_code == 502, resp.text
        assert "/srv/comfy" not in resp.text
        assert app.state.bridge["runner"].busy is False
        await comfy.aclose()


async def test_traversal_filename_in_history_is_rejected():
    fake = FakeComfy()
    fake.artifact_item = {"filename": "../../../../etc/passwd", "subfolder": "", "type": "output"}
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()

        async def finish():
            await asyncio.sleep(0.02)
            fake.finish()

        resp = await _run(client, fake, finisher=finish)
        assert resp.status_code == 502, resp.text
        assert app.state.bridge["runner"].busy is False
        await comfy.aclose()


async def test_input_artifact_reference_is_rejected_before_fetch():
    """History results cannot redirect /view into Comfy's input directory."""
    fake = FakeComfy()
    fake.artifact_item = {"filename": "preexisting.mp4", "subfolder": "", "type": "input"}
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()

        async def finish():
            await asyncio.sleep(0.02)
            fake.finish()

        resp = await _run(client, fake, finisher=finish)
        assert resp.status_code == 502, resp.text
        assert fake.view_requests == []
        assert app.state.bridge["runner"].busy is False
        await comfy.aclose()


async def test_view_404_is_502():
    fake = FakeComfy()
    fake.view_path = "/nonexistent"
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()

        async def finish():
            await asyncio.sleep(0.02)
            fake.finish()

        resp = await _run(client, fake, finisher=finish)
        assert resp.status_code == 502, resp.text
        assert app.state.bridge["runner"].busy is False
        await comfy.aclose()


async def test_oversized_artifact_is_rejected():
    import comfy_client

    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    original = comfy_client.MAX_ARTIFACT_BYTES
    comfy_client.MAX_ARTIFACT_BYTES = 4
    try:
        async with asgi_client(app) as client:
            await comfy.start()

            async def finish():
                await asyncio.sleep(0.02)
                fake.finish()

            resp = await _run(client, fake, finisher=finish)
            assert resp.status_code == 502, resp.text
            assert app.state.bridge["runner"].busy is False
            await comfy.aclose()
    finally:
        comfy_client.MAX_ARTIFACT_BYTES = original


async def test_timeout_path_cancels_own_job_pending_then_frees_slot():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    comfy.poll_timeout = 0.15
    async with asgi_client(app) as client:
        await comfy.start()
        # Never finish: the fake keeps reporting an empty history, so the poll
        # loop hits the deadline. /queue delete is targeted at our own prompt.
        resp = await _run(client, fake, finisher=None, timeout=10)
        assert resp.status_code in (502, 503), resp.text
        assert fake.deleted, "no targeted /queue delete was issued"
        await asyncio.sleep(0.5)
        assert app.state.bridge["runner"].busy is False or app.state.bridge["runner"].unhealthy
        await comfy.aclose()
