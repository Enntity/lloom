"""Single-model serving mode (``LLOOM_MEDIA_MODEL``).

A dedicated per-model runtime must advertise and serve exactly one registry
entry, and an explicitly set value that is empty or unknown must refuse
startup instead of falling back to the full bundled registry. An absent
variable preserves the previous multi-model behaviour.
"""

from __future__ import annotations

import pytest

from conftest import asgi_client, make_bridge
from fake_comfy import FakeComfy

REGISTRY = {"video-model": "video", "audio-model": "audio"}


def video_builder(model_id, payload, image_filename=None, prefix="lloom"):
    return {"9": {"class_type": "SaveVideo", "inputs": {}}}, "9", "video"


async def test_selected_model_is_the_only_advertised_and_served_model():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder, models=REGISTRY, media_model="video-model")
    assert app.state.bridge["media_model"] == "video-model"
    async with asgi_client(app) as client:
        await comfy.start()
        listed = {m["id"] for m in (await client.get("/v1/models")).json()["data"]}
        assert listed == {"video-model"}
        health = await client.get("/health")
        assert health.status_code == 200, health.text
        assert health.json()["backend_ready"] is True
        await comfy.aclose()


async def test_other_registered_model_is_rejected_before_any_graph_or_submission():
    fake = FakeComfy()
    calls: list[str] = []

    def builder(model_id, payload, image_filename=None, prefix="lloom"):
        calls.append(model_id)
        return {"9": {"class_type": "SaveVideo", "inputs": {}}}, "9", "video"

    app, comfy = make_bridge(fake, builder, models=REGISTRY, media_model="video-model")
    async with asgi_client(app) as client:
        await comfy.start()
        # ``audio-model`` exists in the injected registry but not in this
        # runtime, so it must be an unsupported-model 400 that never reaches
        # the video graph builder or ComfyUI's /prompt.
        resp = await client.post(
            "/v1/videos/generations", json={"model": "audio-model", "prompt": "x"}
        )
        assert resp.status_code == 400, resp.text
        err = resp.json()["error"]
        assert err["code"] == "unsupported_model"
        assert "video-model" in err["message"]
        assert calls == []
        assert fake.prompts == {}
        assert fake.uploaded == []
        await comfy.aclose()


@pytest.mark.parametrize("value", ["", "   "])
def test_explicitly_empty_selection_fails_closed(value, monkeypatch):
    from server import create_app

    monkeypatch.setenv("LLOOM_MEDIA_MODEL", value)
    with pytest.raises(ValueError):
        create_app(build_graph=video_builder, models=dict(REGISTRY), start_backend=False)


def test_unknown_selection_fails_closed_even_with_injected_registry(monkeypatch):
    from server import create_app

    monkeypatch.setenv("LLOOM_MEDIA_MODEL", "not-in-registry")
    with pytest.raises(ValueError) as excinfo:
        # Injected models still go through the selector, so a model the graphs
        # module supports cannot be smuggled in by an explicit registry.
        create_app(build_graph=video_builder, models=dict(REGISTRY), start_backend=False)
    assert "not-in-registry" in str(excinfo.value)


def test_unknown_selection_is_not_silently_ignored(monkeypatch):
    monkeypatch.setenv("LLOOM_MEDIA_MODEL", "missing-model")
    import importlib

    import server as server_mod

    # The module-level ``app = create_app()`` runs on import; a bad selector
    # would make an import-time startup fail rather than expose all models.
    with pytest.raises(ValueError):
        importlib.reload(server_mod)
    monkeypatch.delenv("LLOOM_MEDIA_MODEL")
    importlib.reload(server_mod)


async def test_absent_selection_keeps_full_registry(monkeypatch):
    monkeypatch.delenv("LLOOM_MEDIA_MODEL", raising=False)
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder, models=REGISTRY)
    assert app.state.bridge["media_model"] is None
    async with asgi_client(app) as client:
        await comfy.start()
        listed = {m["id"] for m in (await client.get("/v1/models")).json()["data"]}
        assert listed == set(REGISTRY)
        await comfy.aclose()


async def test_selection_via_environment_is_honoured(monkeypatch):
    monkeypatch.setenv("LLOOM_MEDIA_MODEL", "audio-model")
    fake = FakeComfy()
    app, comfy = make_bridge(fake, video_builder, models=REGISTRY)
    async with asgi_client(app) as client:
        await comfy.start()
        listed = {m["id"] for m in (await client.get("/v1/models")).json()["data"]}
        assert listed == {"audio-model"}
        await comfy.aclose()
