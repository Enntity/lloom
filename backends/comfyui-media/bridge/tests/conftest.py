"""Shared fixtures for the bridge test suite.

Everything is offline: the ComfyUI side is either an in-process fake driven
through ``httpx.MockTransport`` or a bare ``httpx.AsyncClient`` carrying that
transport. No network, no GPU, no real ComfyUI.
"""

from __future__ import annotations

import asyncio
import base64
import io
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from comfy_client import ComfyClient  # noqa: E402
from fake_comfy import FakeComfy  # noqa: E402


def png_data_uri(width: int = 8, height: int = 8) -> str:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (width, height), (10, 20, 30)).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


@pytest.fixture
def fake() -> FakeComfy:
    return FakeComfy()


def make_bridge(fake: FakeComfy, build_graph, *, start_backend: bool = False, **kwargs):
    """Build an app whose ComfyClient is wired to the fake transport."""
    from server import create_app

    client = httpx.AsyncClient(base_url="http://127.0.0.1:8188", transport=fake.transport())
    comfy = ComfyClient("http://127.0.0.1:8188", client=client, poll_interval=0.01, poll_timeout=5.0)
    app = create_app(
        comfy=comfy,
        models=kwargs.pop("models", {"video-model": "video", "audio-model": "audio"}),
        build_graph=build_graph,
        start_backend=start_backend,
    )
    return app, comfy


def asgi_client(app) -> httpx.AsyncClient:
    """A client that drives the FastAPI app in-process."""
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://bridge.test")


__all__ = ["png_data_uri", "make_bridge", "asgi_client", "FakeComfy", "asyncio"]


def pytest_collection_modifyitems(config, items):
    """Provide asyncio_mode=auto-like behaviour without pytest-asyncio."""
    return None
