"""Input validation: body cap, inline image bounds, model and format checks.

Every rejection here must happen *before* any ComfyUI interaction.
"""

from __future__ import annotations

import pytest

from conftest import asgi_client, make_bridge, png_data_uri
from fake_comfy import FakeComfy
from errors import BridgeError
from requests_in import MAX_BODY_BYTES, read_json_body


def builder(model_id, payload, image_filename=None, prefix="lloom"):
    return {"9": {"class_type": "SaveVideo", "inputs": {}}}, "9", "video"


async def _post(client, path, payload):
    return await client.post(path, json=payload)


async def test_unsupported_model_is_400_and_no_backend_call():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await _post(client, "/v1/videos/generations", {"model": "nope", "prompt": "x"})
        assert resp.status_code == 400, resp.text
        err = resp.json()["error"]
        assert err["code"] == "unsupported_model"
        assert "video-model" in err["message"]
        assert fake.prompts == {}
        await comfy.aclose()


async def test_missing_model_is_400():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await _post(client, "/v1/videos/generations", {"prompt": "x"})
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "missing_model"
        await comfy.aclose()


async def test_unsupported_response_format_is_400():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await _post(
            client,
            "/v1/videos/generations",
            {"model": "video-model", "prompt": "x", "response_format": "url"},
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "unsupported_response_format"
        assert fake.prompts == {}
        await comfy.aclose()


async def test_invalid_json_is_400():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post(
            "/v1/videos/generations",
            content=b"{not json",
            headers={"content-type": "application/json"},
        )
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "invalid_json"
        await comfy.aclose()


async def test_body_over_cap_is_rejected():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        # Valid JSON, but well past the 16 MiB streaming body cap.
        filler = "a" * (MAX_BODY_BYTES + 4096)
        resp = await client.post(
            "/v1/videos/generations",
            content=('{"model":"video-model","prompt":"' + filler + '"}').encode(),
            headers={"content-type": "application/json"},
        )
        assert resp.status_code == 400, resp.status_code
        assert resp.json()["error"]["code"] == "body_too_large"
        assert fake.prompts == {}
        await comfy.aclose()


async def test_body_cap_is_checked_before_consuming_an_oversize_chunk():
    """A giant stream chunk must be rejected before bytearray.extend()."""

    class OversizeChunk:
        def __len__(self):
            return MAX_BODY_BYTES + 1

        def __iter__(self):
            raise AssertionError("oversize chunk was consumed before the cap check")

    class Request:
        async def stream(self):
            yield OversizeChunk()

    with pytest.raises(BridgeError) as exc_info:
        await read_json_body(Request())
    assert exc_info.value.status_code == 400
    assert exc_info.value.code == "body_too_large"


async def test_image_url_is_rejected():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        for bad in (
            "https://example.com/a.png",
            "file:///etc/passwd",
            "/etc/passwd",
            "../../secrets.png",
            "data:text/plain;base64,aGk=",
        ):
            resp = await _post(
                client, "/v1/videos/generations", {"model": "video-model", "image": bad}
            )
            assert resp.status_code == 400, (bad, resp.text)
            assert resp.json()["error"]["code"] == "invalid_image"
        assert fake.prompts == {}
        assert fake.uploaded == []
        await comfy.aclose()


async def test_oversized_image_dimensions_rejected():
    from PIL import Image
    import base64
    import io

    # Header-only check: a 5000x2 PNG is over the 4096 axis cap and cheap to build.
    buf = io.BytesIO()
    Image.new("L", (5000, 2), 0).save(buf, format="PNG")
    uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

    fake = FakeComfy()
    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await _post(client, "/v1/videos/generations", {"model": "video-model", "image": uri})
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "image_too_large"
        assert fake.uploaded == []
        await comfy.aclose()


async def test_oversized_image_area_rejected():
    from PIL import Image
    import base64
    import io

    # 4200x4200 = 17.6 MPix: inside the axis cap, over the area cap. Stored as a
    # 1-bit image so the encoded bytes stay small.
    buf = io.BytesIO()
    Image.new("1", (4200, 4200), 0).save(buf, format="PNG")
    uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

    fake = FakeComfy()
    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await _post(client, "/v1/videos/generations", {"model": "video-model", "image": uri})
        assert resp.status_code == 400, resp.text
        assert resp.json()["error"]["code"] == "image_too_large"
        await comfy.aclose()


async def test_non_image_data_uri_is_rejected():
    fake = FakeComfy()
    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        # Valid PNG magic, but the bytes are truncated mid-stream.
        resp = await _post(
            client,
            "/v1/videos/generations",
            {"model": "video-model", "image": "data:image/png;base64,iVBORw0KGgo="},
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "invalid_image"
        assert fake.uploaded == []
        await comfy.aclose()


async def test_errors_never_leak_paths_or_endpoints():
    fake = FakeComfy(ready=False)
    app, comfy = make_bridge(fake, builder)
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post("/v1/videos/generations", json={"model": "nope"})
        text = resp.text
        for leak in ("/Users/", "/tmp/", "127.0.0.1", "8188", "http://"):
            assert leak not in text, (leak, text)
