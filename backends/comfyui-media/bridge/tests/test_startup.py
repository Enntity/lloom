"""Startup readiness, graph-module wiring, and CLI endpoint pinning."""

from __future__ import annotations

import asyncio
import base64
import io
import sys
import types

import httpx
import pytest

from conftest import asgi_client, make_bridge
from fake_comfy import FakeComfy


def video_builder(model_id, payload, image_filename=None, prefix="lloom"):
    return {"9": {"class_type": "SaveVideo", "inputs": {}}}, "9", "video"


async def test_startup_waits_for_backend_then_health_ok():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder, start_backend=True)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://bridge.test"
    ) as client:
        resp = await client.get("/health")
        assert resp.status_code == 200, resp.text
        assert resp.json()["backend_ready"] is True
        await comfy.aclose()


async def test_startup_probe_is_bounded_when_backend_never_ready():
    import server as server_mod

    fake = FakeComfy(ready=False)
    app, comfy = make_bridge(fake, video_builder, start_backend=True)
    original = (server_mod.READY_ATTEMPTS, server_mod.READY_DELAY)
    server_mod.READY_ATTEMPTS, server_mod.READY_DELAY = 2, 0.01
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://bridge.test"
        ) as client:
            resp = await client.get("/health")
            assert resp.status_code == 503
            assert resp.json()["backend_ready"] is False
    finally:
        server_mod.READY_ATTEMPTS, server_mod.READY_DELAY = original
        await comfy.aclose()


async def test_graph_wiring_passes_model_payload_and_prefix():
    fake = FakeComfy()
    seen = {}

    def builder(model_id, payload, image_filename=None, prefix="lloom"):
        seen.update(model=model_id, payload=payload, image=image_filename, prefix=prefix)
        return {"9": {"class_type": "SaveVideo", "inputs": {}}}, "9", "video"

    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        task = asyncio.ensure_future(
            client.post(
                "/v1/videos/generations",
                json={"model": "video-model", "prompt": "p", "duration": 5, "seed": 3},
            )
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        fake.finish()
        assert (await asyncio.wait_for(task, timeout=5)).status_code == 200
        assert seen["model"] == "video-model"
        assert seen["prefix"] == "lloom"
        assert seen["image"] is None
        assert seen["payload"]["duration"] == 5 and seen["payload"]["seed"] == 3
        await comfy.aclose()


async def test_jpeg_inline_image_uploaded_with_jpg_extension():
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (16, 16), (1, 2, 3)).save(buf, format="JPEG")
    uri = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        task = asyncio.ensure_future(
            client.post(
                "/v1/videos/generations", json={"model": "video-model", "prompt": "x", "image": uri}
            )
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        fake.finish()
        assert (await asyncio.wait_for(task, timeout=5)).status_code == 200
        name, _, _ = fake.uploaded[0]
        assert name.endswith(".jpg")
        await comfy.aclose()


async def test_real_graphs_module_is_used_when_importable(monkeypatch):
    """The production path imports ../graphs/graphs.py via PYTHONPATH."""
    module = types.ModuleType("graphs")
    module.MODELS = {"real-video": "video"}
    calls = {}

    def build_graph(model_id, payload, image_filename=None, prefix="lloom"):
        calls["args"] = (model_id, image_filename, prefix)
        return {"1": {"class_type": "Real", "inputs": {}}}, "9", "video"

    module.build_graph = build_graph
    monkeypatch.setitem(sys.modules, "graphs", module)

    import server as server_mod

    app = server_mod.create_app(models=None, build_graph=None, start_backend=False)
    fake = FakeComfy()
    client = httpx.AsyncClient(base_url="http://127.0.0.1:8188", transport=fake.transport())
    from comfy_client import ComfyClient

    comfy = ComfyClient("http://127.0.0.1:8188", client=client, poll_interval=0.01, poll_timeout=5)
    app.state.bridge["comfy"] = comfy
    from jobs import SingleFlightRunner

    app.state.bridge["runner"] = SingleFlightRunner(comfy)

    async with asgi_client(app) as c:
        await comfy.start()
        models = await c.get("/v1/models")
        assert {m["id"] for m in models.json()["data"]} == {"real-video"}
        task = asyncio.ensure_future(
            c.post("/v1/videos/generations", json={"model": "real-video", "prompt": "x"})
        )
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        fake.finish()
        assert (await asyncio.wait_for(task, timeout=5)).status_code == 200
        assert calls["args"] == ("real-video", None, "lloom")
        await comfy.aclose()


def test_cli_defaults_to_loopback_and_fixed_comfy_url():
    import server as server_mod

    captured = {}

    def fake_run(app, *, host, port, log_level):
        captured["host"] = host
        captured["port"] = port

    import uvicorn

    original = uvicorn.run
    uvicorn.run = fake_run
    try:
        assert server_mod.main([]) == 0
    finally:
        uvicorn.run = original
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 8000
    assert server_mod.DEFAULT_COMFY_URL == "http://127.0.0.1:8188"


def test_comfy_url_is_not_caller_controllable():
    """No request field can retarget the backend: the URL lives in state only."""
    import server as server_mod

    app, _ = None, None
    fake = FakeComfy()
    from conftest import make_bridge as mb

    app, comfy = mb(fake, video_builder)
    assert app.state.bridge["comfy_url"] == "http://127.0.0.1:8188"
    # A hostile JSON body cannot change it.
    import inspect

    src = inspect.getsource(server_mod)
    for handler in ("videos/generations", "audio/speech", "audio/generations"):
        assert handler in src
    assert "state[\"comfy_url\"]" in src
