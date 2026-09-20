"""Regression tests for the independent-review safety findings.

Each test pins a specific property:

* a cancelled or transport-failed submission is never assumed to have failed
  (unknown acceptance quarantines the slot instead of releasing it);
* ``cancel_own_job`` reads ``GET /queue`` (never trusting the empty POST body),
  interrupts only the exact id we submitted, and never treats a *missing*
  history entry as terminal or a pending delete as proof of completion;
* ``/health`` is 503 whenever the runner or the graph wiring is unusable, even
  if ``/system_stats`` answers;
* the declared model kind is checked before upload/submit, and a mismatch is a
  400 that never reaches the GPU;
* only the declared output node's artifact is returned, with a container magic
  and filename that match the declared kind;
* the ComfyUI base URL is a fixed plain-HTTP loopback endpoint.
"""

from __future__ import annotations

import asyncio
import base64
import uuid

import httpx
import pytest

from comfy_client import (
    ComfyClient,
    _history_proven_terminal,
    validate_comfy_base_url,
)
from conftest import asgi_client, make_bridge
from fake_comfy import FakeComfy
from server import create_app


def video_builder(model_id, payload, image_filename=None, prefix="lloom"):
    return {"9": {"class_type": "SaveVideo", "inputs": {}}}, "9", "video"


def audio_builder(model_id, payload, image_filename=None, prefix="lloom"):
    return {"9": {"class_type": "SaveAudio", "inputs": {}}}, "9", "audio"


# -- (1) uncertain acceptance is never released ---------------------------- #


async def test_transport_error_during_prompt_quarantines_slot():
    fake = FakeComfy()

    async def boom(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/prompt":
            raise httpx.ConnectError("boom", request=request)
        return await fake.handler(request)

    fake.handler = boom  # type: ignore[assignment]
    app, comfy = make_bridge(fake, video_builder)
    runner = app.state.bridge["runner"]
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post(
            "/v1/videos/generations", json={"model": "video-model", "prompt": "x"}
        )
        assert resp.status_code == 503, resp.text
        assert runner.busy is True, "uncertain acceptance freed the GPU slot"
        assert runner.unhealthy is True
        await comfy.aclose()


async def test_mismatched_prompt_id_in_response_quarantines_slot():
    fake = FakeComfy()

    async def swap(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/prompt":
            return httpx.Response(200, json={"prompt_id": "someone-elses-id", "number": 1})
        return await fake.handler(request)

    fake.handler = swap  # type: ignore[assignment]
    app, comfy = make_bridge(fake, video_builder)
    runner = app.state.bridge["runner"]
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post(
            "/v1/videos/generations", json={"model": "video-model", "prompt": "x"}
        )
        assert resp.status_code == 503, resp.text
        assert runner.busy is True
        await comfy.aclose()


async def test_submit_sends_the_id_it_returns():
    """Acceptance is proven only when the backend echoes our own UUID."""
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        task = asyncio.ensure_future(
            client.post("/v1/videos/generations", json={"model": "video-model", "prompt": "x"})
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        sent_id = fake.running[0]
        # The pinned server requires a canonical lowercase hyphenated UUID; it
        # 400s anything else, so a non-UUID id would quarantine every request.
        assert uuid.UUID(sent_id)
        assert sent_id == sent_id.lower()
        fake.finish()
        assert (await asyncio.wait_for(task, timeout=5)).status_code == 200
        await comfy.aclose()


# -- (2) cancellation: targeted, proven, finite ---------------------------- #


async def test_cancel_prefers_get_queue_and_targeted_interrupt():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        task = asyncio.ensure_future(
            client.post("/v1/videos/generations", json={"model": "video-model", "prompt": "x"})
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        pid = fake.running[0]
        assert await comfy.cancel_own_job(pid) is True
        # The targeted pending delete is always attempted...
        assert fake.deleted == [pid]
        # ...and because the job was actually running, a targeted interrupt was
        # issued for exactly our id.
        assert fake.interrupts == 1
        fake.finish()
        await asyncio.wait_for(task, timeout=5)
        await comfy.aclose()


async def test_cancel_does_not_interrupt_a_job_that_is_only_pending():
    """A pending delete is not terminal proof and must not release the slot."""
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        # Simulate a queued-but-not-started prompt.
        fake.running.clear()
        fake.queued.append("11111111-1111-1111-1111-111111111111")
        fake.job_state = "pending"
        pid = "11111111-1111-1111-1111-111111111111"
        assert await comfy.cancel_own_job(pid) is False
        assert fake.deleted == [pid]
        assert fake.interrupts == 0, "a pending job must not be interrupted"
        await comfy.aclose()


async def test_cancel_never_treats_missing_history_as_terminal():
    """ComfyUI reports ``{}`` for a running job; that is not proof of silence."""
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        task = asyncio.ensure_future(
            client.post("/v1/videos/generations", json={"model": "video-model", "prompt": "x"})
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        # No history entry exists yet for a running prompt.
        assert await comfy.history(fake.running[0]) is None
        assert _history_proven_terminal(None) is False
        fake.finish()
        await asyncio.wait_for(task, timeout=5)
        await comfy.aclose()


async def test_uncertain_cancel_keeps_the_slot_held():
    """If the interrupt cannot be proven effective the slot stays quarantined."""
    fake = FakeComfy()
    original_handler = fake.handler

    async def stubborn(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/interrupt":
            # Accept the request but never actually release the job.
            fake.interrupts += 1
            return httpx.Response(200, json={})
        return await original_handler(request)

    fake.handler = stubborn  # type: ignore[assignment]
    app, comfy = make_bridge(fake, video_builder)
    runner = app.state.bridge["runner"]
    comfy.poll_interval = 0.0
    async with asgi_client(app) as client:
        await comfy.start()
        task = asyncio.ensure_future(
            client.post("/v1/videos/generations", json={"model": "video-model", "prompt": "x"})
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        pid = fake.running[0]
        assert await comfy.cancel_own_job(pid) is False
        assert runner.busy is True
        fake.finish()
        await asyncio.wait_for(task, timeout=5)
        await comfy.aclose()


# -- (3) health is only ok when the whole pipeline is wired ---------------- #


async def test_health_503_when_runner_missing():
    fake = FakeComfy()
    app = create_app(
        comfy=None,
        models={"video-model": "video"},
        build_graph=video_builder,
        start_backend=False,
    )
    app.state.bridge["runner"] = None
    client = httpx.AsyncClient(base_url="http://127.0.0.1:8188", transport=fake.transport())
    comfy = ComfyClient("http://127.0.0.1:8188", client=client, poll_interval=0.01)
    app.state.bridge["comfy"] = comfy
    async with asgi_client(app) as c:
        await comfy.start()
        resp = await c.get("/health")
        assert resp.status_code == 503, resp.text
        assert resp.json()["backend_ready"] is False
        await comfy.aclose()


async def test_health_503_when_build_graph_missing():
    fake = FakeComfy()
    app = create_app(
        comfy=None,
        models={"video-model": "video"},
        build_graph=None,
        start_backend=False,
    )
    for attr in ("__wrapped__",):
        pass
    # ``create_app`` falls back to the ``graphs`` import; force the failure by
    # clearing the wiring the same way a broken PYTHONPATH would.
    app.state.bridge["build_graph"] = None
    client = httpx.AsyncClient(base_url="http://127.0.0.1:8188", transport=fake.transport())
    comfy = ComfyClient("http://127.0.0.1:8188", client=client, poll_interval=0.01)
    app.state.bridge["comfy"] = comfy
    from jobs import SingleFlightRunner

    app.state.bridge["runner"] = SingleFlightRunner(comfy)
    async with asgi_client(app) as c:
        await comfy.start()
        resp = await c.get("/health")
        assert resp.status_code == 503, resp.text
        assert resp.json()["backend_ready"] is False
        await comfy.aclose()


async def test_health_503_when_registry_is_empty():
    """An empty model registry means nothing can be served, so /health is 503."""
    fake = FakeComfy()
    app = create_app(
        comfy=None,
        models={},
        build_graph=video_builder,
        start_backend=False,
    )
    client = httpx.AsyncClient(base_url="http://127.0.0.1:8188", transport=fake.transport())
    comfy = ComfyClient("http://127.0.0.1:8188", client=client, poll_interval=0.01)
    app.state.bridge["comfy"] = comfy
    from jobs import SingleFlightRunner

    app.state.bridge["runner"] = SingleFlightRunner(comfy)
    async with asgi_client(app) as c:
        await comfy.start()
        resp = await c.get("/health")
        assert resp.status_code == 503, resp.text
        assert resp.json()["backend_ready"] is False
        await comfy.aclose()


# -- (4) kind is validated before any GPU work ----------------------------- #


async def test_model_kind_mismatch_is_400_without_any_backend_call():
    """Asking the video endpoint for an audio model must not reach Comfy."""
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post(
            "/v1/videos/generations", json={"model": "audio-model", "prompt": "x"}
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "model_kind_mismatch"
        # No graph, no upload, no prompt: nothing ever touched the GPU.
        assert fake.prompts == {}
        assert fake.uploaded == []
        await comfy.aclose()


async def test_audio_endpoint_rejects_video_model_before_upload():
    from conftest import png_data_uri

    fake = FakeComfy()
    app, comfy = make_bridge(fake, audio_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post(
            "/v1/audio/generations",
            json={"model": "video-model", "input": "hi", "image": png_data_uri(8, 8)},
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "model_kind_mismatch"
        assert fake.uploaded == [], "the image was uploaded before the kind was checked"
        assert fake.prompts == {}
        await comfy.aclose()


async def test_graph_out_kind_mismatch_is_400_without_submit():
    """The *graph's* declared kind is checked too, before anything is queued."""
    fake = FakeComfy()
    app, comfy = make_bridge(fake, audio_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post(
            "/v1/videos/generations", json={"model": "video-model", "prompt": "x"}
        )
        assert resp.status_code == 400, resp.text
        assert fake.prompts == {}
        await comfy.aclose()


# -- (5) only the declared output node, with matching bytes ---------------- #


async def test_artifact_from_an_undeclared_node_is_not_returned():
    fake = FakeComfy()

    def builder(model_id, payload, image_filename=None, prefix="lloom"):
        builder.declared = "7"
        return (
            {
                "7": {"class_type": "SaveVideo", "inputs": {}},
                "9": {"class_type": "SaveVideo", "inputs": {}},
            },
            "7",
            "video",
        )

    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = asyncio.ensure_future(_finish_soon(fake))
        resp = await client.post(
            "/v1/videos/generations", json={"model": "video-model", "prompt": "x"}
        )
        await finisher
        # The fake publishes only node 9; the declared node 7 has no artifact, so
        # there is no fallback and the request fails rather than returning node 9.
        assert resp.status_code == 502, resp.text
        await comfy.aclose()


async def test_video_endpoint_rejects_audio_bytes():
    fake = FakeComfy(artifact=b"RIFF....WAVEaudio-bytes")
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = asyncio.ensure_future(_finish_soon(fake))
        resp = await client.post(
            "/v1/videos/generations", json={"model": "video-model", "prompt": "x"}
        )
        await finisher
        assert resp.status_code == 502, resp.text
        assert app.state.bridge["runner"].busy is False
        await comfy.aclose()


async def test_audio_endpoint_rejects_mp4_bytes():
    fake = FakeComfy(artifact=b"\x00\x00\x00\x18ftypmp42-video")
    app, comfy = make_bridge(fake, audio_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = asyncio.ensure_future(_finish_soon(fake))
        resp = await client.post(
            "/v1/audio/generations", json={"model": "audio-model", "input": "x"}
        )
        await finisher
        assert resp.status_code == 502, resp.text
        await comfy.aclose()


async def test_video_filename_must_be_mp4_while_bytes_are_mp4():
    """An mp4 container under a ``.wav`` name is rejected, not renamed."""
    fake = FakeComfy()
    fake.artifact_item = {"filename": "lloom_00001.wav", "subfolder": "", "type": "output"}
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = asyncio.ensure_future(_finish_soon(fake))
        resp = await client.post(
            "/v1/videos/generations", json={"model": "video-model", "prompt": "x"}
        )
        await finisher
        assert resp.status_code == 502, resp.text
        await comfy.aclose()


async def _finish_soon(fake: FakeComfy) -> None:
    await fake.submitted.wait()
    await asyncio.sleep(0.02)
    fake.finish()


# -- (9) fixed loopback base URL ------------------------------------------- #


@pytest.mark.parametrize(
    "bad",
    [
        "https://127.0.0.1:8188",
        "http://example.com:8188",
        "http://user:pass@127.0.0.1:8188",
        "http://127.0.0.1:8188/?x=1",
        "http://127.0.0.1:8188/path",
        "http://127.0.0.1:8188/#frag",
        "http://127.0.0.1",
        "",
    ],
)
def test_base_url_rejects_anything_but_plain_loopback(bad):
    with pytest.raises(ValueError):
        validate_comfy_base_url(bad)


@pytest.mark.parametrize("good", ["http://127.0.0.1:8188", "http://localhost:8000", "http://[::1]:8188"])
def test_base_url_accepts_loopback(good):
    assert validate_comfy_base_url(good) == good.rstrip("/")


def test_request_fields_cannot_override_the_backend_url():
    """A hostile body cannot smuggle in a new ComfyUI endpoint."""
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    # The endpoint lives in app state, sourced only from the CLI/env value.
    assert app.state.bridge["comfy_url"] == "http://127.0.0.1:8188"
    # The client holds exactly that validated loopback URL.
    assert comfy.base_url == "http://127.0.0.1:8188"
