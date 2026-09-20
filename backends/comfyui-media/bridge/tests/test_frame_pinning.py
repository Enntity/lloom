"""Bridge-level tests: last_frame plumbing and actionable rejection messages."""

from __future__ import annotations

import asyncio

from conftest import asgi_client, make_bridge, png_data_uri


async def _finish(fake):
    async def soon():
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        await asyncio.sleep(0.02)
        fake.finish()

    return asyncio.ensure_future(soon())


def _video_builder(seen):
    def build_graph(model_id, payload, image_filename=None, last_image_filename=None, prefix="lloom"):
        seen["image_filename"] = image_filename
        seen["last_image_filename"] = last_image_filename
        # Mirror the real graph builder's precondition, so this stub cannot
        # silently accept a request the production builder would reject.
        if last_image_filename is not None and image_filename is None:
            raise ValueError("last_frame requires a first_frame or image to anchor the clip")
        return {"9": {"class_type": "SaveVideo", "inputs": {}}}, "9", "video"

    return build_graph


async def test_last_frame_is_passed_to_the_graph_and_uploaded():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=b"\x00\x00\x00\x18ftypmp42-video")
    seen = {}
    app, comfy = make_bridge(fake, _video_builder(seen))
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = await _finish(fake)
        resp = await client.post(
            "/v1/videos/generations",
            json={
                "model": "video-model",
                "prompt": "a fox",
                "image": png_data_uri(),
                "last_frame": png_data_uri(),
            },
        )
        await finisher
        assert resp.status_code == 200, resp.text
        await comfy.aclose()
    assert seen["image_filename"]
    assert seen["last_image_filename"]
    # Both conditioning images must reach Comfy, not just the first.
    assert seen["image_filename"] != seen["last_image_filename"]
    assert len(fake.uploaded) == 2


async def test_first_frame_only_does_not_send_a_last_frame():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=b"\x00\x00\x00\x18ftypmp42-video")
    seen = {}
    app, comfy = make_bridge(fake, _video_builder(seen))
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = await _finish(fake)
        resp = await client.post(
            "/v1/videos/generations",
            json={"model": "video-model", "prompt": "a fox", "image": png_data_uri()},
        )
        await finisher
        assert resp.status_code == 200, resp.text
        await comfy.aclose()
    assert seen["image_filename"]
    assert seen["last_image_filename"] is None
    assert len(fake.uploaded) == 1


async def test_last_frame_without_first_frame_is_rejected_before_the_gpu():
    """Only a last frame has no anchor, so the graph refuses it up front.

    This rejection is decided before any GPU work: no upload, no submit. The
    client timeout is generous because a wrongly-handled rejection would stall
    on the fake backend rather than fail fast, and that is the bug being caught.
    """
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=b"\x00\x00\x00\x18ftypmp42-video")
    seen = {}
    app, comfy = make_bridge(fake, _video_builder(seen))
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post(
            "/v1/videos/generations",
            json={"model": "video-model", "prompt": "a fox", "last_frame": png_data_uri()},
            timeout=30,
        )
        assert resp.status_code == 400, resp.text
        assert "last_frame" in resp.json()["error"]["message"]
        await comfy.aclose()
    # The builder is asked for the graph and refuses it; nothing is uploaded and
    # nothing reaches the GPU.
    assert seen["last_image_filename"]
    assert seen["image_filename"] is None
    assert fake.uploaded == []
    assert not fake.submitted.is_set()


async def test_last_frame_is_validated_as_an_image():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=b"\x00\x00\x00\x18ftypmp42-video")
    seen = {}
    app, comfy = make_bridge(fake, _video_builder(seen))
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post(
            "/v1/videos/generations",
            json={"model": "video-model", "prompt": "a fox", "image": png_data_uri(),
                  "last_frame": "https://example.test/frame.png"},
        )
        assert resp.status_code in (400, 422), resp.text
        await comfy.aclose()
    assert fake.uploaded == []


async def test_rejection_names_the_field_and_its_range():
    """The message a client sees must identify the parameter, not just fail."""

    def strict_builder(model_id, payload, image_filename=None, last_image_filename=None, prefix="lloom"):
        raise ValueError("steps for MiniMax-H3 must be between 10 and 50")

    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=b"\x00\x00\x00\x18ftypmp42-video")
    app, comfy = make_bridge(fake, strict_builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post(
            "/v1/videos/generations",
            json={"model": "video-model", "prompt": "a fox", "steps": 8},
        )
        assert resp.status_code == 400, resp.text
        message = resp.json()["error"]["message"]
        assert "steps" in message and "10 and 50" in message
        await comfy.aclose()
    assert not fake.submitted.is_set()
