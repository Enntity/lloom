"""Cancellation must never free the GPU slot while Comfy is still running."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from conftest import asgi_client, make_bridge, png_data_uri
from fake_comfy import FakeComfy


def video_builder(model_id, payload, image_filename=None, prefix="lloom"):
    return {"9": {"class_type": "SaveVideo", "inputs": {}}}, "9", "video"


async def test_cancelled_request_keeps_slot_until_terminal():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    runner = app.state.bridge["runner"]
    async with asgi_client(app) as client:
        await comfy.start()

        task = asyncio.ensure_future(
            client.post("/v1/videos/generations", json={"model": "video-model", "prompt": "x"})
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        assert runner.busy is True

        # Simulate the client hanging up mid-generation.
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        # Comfy never reported a terminal state yet: the slot must stay held and
        # a second caller must not be able to enqueue another GPU job.
        assert runner.busy is True
        blocked = await client.post(
            "/v1/videos/generations", json={"model": "video-model", "prompt": "second"}
        )
        assert blocked.status_code in (429, 503), blocked.text
        assert len(fake.prompts) == 1, "a cancelled request queued a second GPU job"

        # Only once Comfy reports terminal does the slot free up.
        fake.finish()
        for _ in range(200):
            if not runner.busy:
                break
            await asyncio.sleep(0.02)
        assert runner.busy is False, "slot was never released after terminal state"

        # And the slot is genuinely reusable.
        fake.job_state = "running"
        fake.submitted.clear()
        fake.histories.clear()
        fake.deleted.clear()
        retry = asyncio.ensure_future(
            client.post("/v1/videos/generations", json={"model": "video-model", "prompt": "third"})
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        fake.finish()
        resp = await asyncio.wait_for(retry, timeout=5)
        assert resp.status_code == 200, resp.text
        await comfy.aclose()


async def test_cancelled_request_with_unresolvable_history_marks_unhealthy():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    runner = app.state.bridge["runner"]
    async with asgi_client(app) as client:
        await comfy.start()

        task = asyncio.ensure_future(
            client.post("/v1/videos/generations", json={"model": "video-model", "prompt": "x"})
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)

        # History goes permanently unavailable: the reaper can never prove the
        # job is terminal, so the slot must be retained and the runner flagged.
        fake.history_failures = 10**9
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        blocked = await client.post(
            "/v1/videos/generations", json={"model": "video-model", "prompt": "second"}
        )
        assert blocked.status_code in (429, 503), blocked.text
        assert len(fake.prompts) == 1
        await asyncio.sleep(0.1)
        # Still not released: we cannot prove the GPU job is done.
        assert runner.busy is True
        fake.history_failures = 0

        # Now history resolves: the slot may be released.
        fake.finish()
        for _ in range(200):
            if not runner.busy:
                break
            await asyncio.sleep(0.02)
        assert runner.busy is False
        await comfy.aclose()


async def test_cancelled_before_submit_releases_immediately():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    runner = app.state.bridge["runner"]

    started = asyncio.Event()

    async def slow_build(comfy_client):
        started.set()
        await asyncio.sleep(30)
        return {}, "9", "video"

    async with asgi_client(app) as client:
        await comfy.start()
        task = asyncio.ensure_future(runner.run(slow_build, kind="video"))
        await asyncio.wait_for(started.wait(), timeout=3)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        # Nothing was ever submitted, so the slot must come straight back.
        assert runner.busy is False
        assert fake.prompts == {}
        await comfy.aclose()


@pytest.mark.parametrize("status", [400, 500])
async def test_cancelled_submit_retains_and_consumes_submit_outcome(status):
    """A cancellation must not lose a settled submit task or free blindly."""
    fake = FakeComfy()
    original_handler = fake.handler
    prompt_started = asyncio.Event()
    release_prompt = asyncio.Event()
    submitted_prompt: dict[str, str] = {}

    async def delayed_prompt(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/prompt":
            import json

            body = json.loads(request.read())
            submitted_prompt["id"] = body["prompt_id"]
            prompt_started.set()
            await release_prompt.wait()
            if status == 400:
                return httpx.Response(status, json={"error": "rejected"})
            # Leave the prompt in a terminal history entry after returning an
            # uncertain 5xx so the test can prove the reaper eventually frees
            # it while retaining the slot until then.
            fake.histories[submitted_prompt["id"]] = fake._finish(submitted_prompt["id"])
            fake.job_state = "done"
            return httpx.Response(status, json={"error": "unavailable"})
        return await original_handler(request)

    fake.handler = delayed_prompt  # type: ignore[assignment]
    app, comfy = make_bridge(fake, video_builder)
    runner = app.state.bridge["runner"]
    async with asgi_client(app) as client:
        await comfy.start()
        request_task = asyncio.ensure_future(
            client.post("/v1/videos/generations", json={"model": "video-model", "prompt": "x"})
        )
        await asyncio.wait_for(prompt_started.wait(), timeout=3)
        request_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request_task

        # Cancellation itself is uncertain and must quarantine immediately;
        # the submit task is still retained for the reaper to consume.
        assert runner.busy is True
        assert runner.unhealthy is True
        release_prompt.set()

        for _ in range(200):
            if not runner.busy:
                break
            await asyncio.sleep(0.01)
        if status == 400:
            assert runner.busy is False, "proven rejection was not released after task consumption"
            assert runner.unhealthy is False
        else:
            assert runner.busy is False, "uncertain submit was released before terminal history"
        await comfy.aclose()


async def test_cancelled_reaper_cleans_uploaded_and_output_files(tmp_path, monkeypatch):
    """Terminal reaping carries the upload and declared output references."""
    root = tmp_path / "comfy-data"
    (root / "input").mkdir(parents=True)
    (root / "output" / "lloom").mkdir(parents=True)
    monkeypatch.setenv("LLOOM_MEDIA_DATA_ROOT", str(root))

    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    runner = app.state.bridge["runner"]
    assert runner.data_roots.root == str(root)
    async with asgi_client(app) as client:
        await comfy.start()
        request_task = asyncio.ensure_future(
            client.post(
                "/v1/videos/generations",
                json={"model": "video-model", "prompt": "x", "image": png_data_uri()},
            )
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        upload_name = fake.uploaded[0][0]
        upload_path = root / "input" / upload_name
        output_path = root / "output" / "lloom" / "lloom_00001.mp4"
        upload_path.write_bytes(b"input")
        output_path.write_bytes(b"output")

        request_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request_task
        fake.finish()

        for _ in range(200):
            if not runner.busy and not upload_path.exists() and not output_path.exists():
                break
            await asyncio.sleep(0.01)
        assert runner.busy is False
        assert not upload_path.exists()
        assert not output_path.exists()
        await comfy.aclose()
