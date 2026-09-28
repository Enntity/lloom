"""Multipart ``/v1/images/edits``: the native-shaped reference-image endpoint.

The route exists because Qwen-Image 2.1 advertises image editing while the only
editing surface used to be the JSON generation endpoint's inline data URI. These
tests drive the real app over the fake ComfyUI harness, so the request shape,
the rejections and the seed metadata are pinned without a GPU.
"""

from __future__ import annotations

import asyncio
import base64
import io
import os
import sys

import pytest

from conftest import asgi_client, make_bridge, png_data_uri

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "graphs"))

QWEN_21 = "Qwen/Qwen-Image-2.1"
QWEN_NVFP4 = "BennyDaBall/Qwen-Image-2.1-NVFP4"
QWEN_EDIT = "Qwen/Qwen-Image-Edit-2511"

MODELS = {
    QWEN_NVFP4: {"kind": "image", "family": "qwen-image-21"},
    "Qwen/Qwen-Image-2.1": {"kind": "image", "family": "qwen-image-21"},
    "Qwen/Qwen-Image-Edit-2511": {"kind": "image", "family": "qwen-image-edit"},
    "Comfy-Org/Krea-2-Turbo": {"kind": "image", "family": "krea2"},
}


def png_bytes(width: int = 8, height: int = 8) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (width, height), (10, 20, 30)).save(buf, format="PNG")
    return buf.getvalue()


PNG = png_bytes()


def png_fake():
    """A fake whose history publishes a ``.png`` artifact, like SaveImage."""
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=PNG)
    fake.artifact_item = {"filename": "lloom_00001.png", "subfolder": "", "type": "output"}
    return fake


def capturing_builder(kind, seen):
    def build_graph(model_id, payload, image_filename=None, prefix="lloom", **kwargs):
        seen.append({"model": model_id, "payload": payload, "image": image_filename,
                     "prefix": prefix, "kwargs": kwargs})
        return {"9": {"class_type": "SaveImage", "inputs": {}}}, "9", kind

    return build_graph


async def post_edit(fake, builder, *, data=None, files=None, expect_submit=True):
    """POST one edit, finishing the fake job when a generation is expected.

    A rejected request never reaches Comfy, so waiting for the submit event would
    hang; ``expect_submit`` says which of the two the test asserts.
    """
    app, comfy = make_bridge(fake, builder, models=MODELS)
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = None
        if expect_submit:

            async def finish_soon():
                await asyncio.wait_for(fake.submitted.wait(), timeout=3)
                await asyncio.sleep(0.02)
                fake.finish()

            finisher = asyncio.ensure_future(finish_soon())
        if isinstance(data, list):
            files = [(key, (None, value)) for key, value in data] + list(files or [])
            data = None
        resp = await client.post("/v1/images/edits", data=data, files=files)
        if finisher is not None:
            await finisher
        await comfy.aclose()
        return resp


def image_part(data: bytes = PNG, content_type: str = "image/png", name: str = "image",
               filename: str = "reference.png"):
    """One multipart upload part, in the shape httpx wants for ``files=``."""
    return [(name, (filename, data, content_type))]


def edit_form(**scalars) -> dict:
    """Native multipart sends every scalar as text, so the tests do too."""
    return {key: str(value) for key, value in scalars.items()}


async def post_generation(fake, builder, payload):
    app, comfy = make_bridge(fake, builder, models=MODELS)
    async with asgi_client(app) as client:
        await comfy.start()

        async def finish_soon():
            await asyncio.wait_for(fake.submitted.wait(), timeout=3)
            await asyncio.sleep(0.02)
            fake.finish()

        task = asyncio.ensure_future(finish_soon())
        resp = await client.post("/v1/images/generations", json=payload)
        await task
        await comfy.aclose()
        return resp


# ---------------------------------------------------------------- happy paths


@pytest.mark.parametrize("model", [QWEN_21, QWEN_NVFP4])
async def test_qwen_21_edit_succeeds_and_reports_the_graph_seed(model):
    fake = png_fake()
    seen = []
    resp = await post_edit(
        fake,
        capturing_builder("image", seen),
        data=edit_form(model=model, prompt="make it dusk", steps=30, cfg=1, resolution=1024, n=1),
        files=image_part(),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    item = body["data"][0]
    assert item["mime_type"] == "image/png"
    assert base64.b64decode(item["b64_json"]) == PNG
    # The reported seed is the one the graph was built with, so a caller can
    # reproduce the render instead of guessing the old fixed default.
    build = seen[0]
    assert build["payload"]["seed"] == body["seed"]
    assert body["seed_source"] == "random"
    assert 0 <= body["seed"] < 2**53
    assert build["model"] == model
    assert build["payload"]["steps"] == 30
    assert build["payload"]["cfg"] == 1
    assert build["payload"]["resolution"] == 1024
    assert build["payload"]["n"] == 1
    assert build["image"] is not None
    assert fake.uploaded and fake.uploaded[0][1] == PNG


@pytest.mark.parametrize("model", [QWEN_21, QWEN_NVFP4])
async def test_edit_accepts_the_image_bracket_upload_name(model):
    fake = png_fake()
    seen = []
    resp = await post_edit(
        fake,
        capturing_builder("image", seen),
        data=edit_form(model=model, prompt="make it dusk"),
        files=[("image[]", ("reference.png", PNG, "image/png"))],
    )
    assert resp.status_code == 200, resp.text
    assert seen[0]["payload"]["seed"] == resp.json()["seed"]


@pytest.mark.parametrize("model", [QWEN_21, QWEN_NVFP4])
async def test_explicit_seed_is_echoed_unchanged(model):
    fake = png_fake()
    seen = []
    resp = await post_edit(
        fake,
        capturing_builder("image", seen),
        data=edit_form(model=model, prompt="make it dusk", seed=1234),
        files=image_part(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["seed"] == 1234
    assert resp.json()["seed_source"] == "explicit"
    assert seen[0]["payload"]["seed"] == 1234


async def test_other_edit_lane_serves_but_reports_no_2_1_seed():
    """The other edit-capable lane keeps working, and keeps its fixed seed."""
    fake = png_fake()
    seen = []
    resp = await post_edit(
        fake,
        capturing_builder("image", seen),
        data=edit_form(model=QWEN_EDIT, prompt="make it dusk"),
        files=image_part(),
    )
    assert resp.status_code == 200, resp.text
    assert "seed" not in resp.json()
    assert seen[0]["model"] == QWEN_EDIT
    assert "seed" not in seen[0]["payload"]


@pytest.mark.parametrize("model", [QWEN_21, QWEN_NVFP4])
async def test_json_generation_keeps_working_and_reports_seed(model):
    """The JSON path keeps its inline data URI contract and gains seed metadata."""
    fake = png_fake()
    seen = []
    resp = await post_generation(
        fake, capturing_builder("image", seen), {"model": model, "prompt": "a heron"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["seed"] == seen[0]["payload"]["seed"]
    assert seen[0]["image"] is None


@pytest.mark.parametrize("model", [QWEN_21, QWEN_NVFP4])
async def test_json_generation_with_explicit_seed_is_unchanged(model):
    fake = png_fake()
    seen = []
    resp = await post_generation(
        fake, capturing_builder("image", seen), {"model": model, "prompt": "a heron", "seed": 7}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["seed"] == 7
    assert seen[0]["payload"]["seed"] == 7


async def test_json_generation_seed_metadata_is_not_added_for_other_models():
    fake = png_fake()
    resp = await post_generation(
        fake, capturing_builder("image", []), {"model": "Comfy-Org/Krea-2-Turbo", "prompt": "a barn"}
    )
    assert resp.status_code == 200, resp.text
    assert "seed" not in resp.json()


@pytest.mark.parametrize("model", [QWEN_21, QWEN_NVFP4])
async def test_json_generation_inline_edit_still_validates_the_image(model):
    fake = png_fake()
    seen = []
    resp = await post_generation(
        fake,
        capturing_builder("image", seen),
        {"model": model, "prompt": "make it dusk", "image": png_data_uri(12, 12)},
    )
    assert resp.status_code == 200, resp.text
    assert seen[0]["image"] is not None


# ------------------------------------------------------------------ rejections


async def test_generation_only_lane_is_refused():
    fake = png_fake()
    seen = []
    resp = await post_edit(
        fake,
        capturing_builder("image", seen),
        data=edit_form(model="Comfy-Org/Krea-2-Turbo", prompt="x"),
        files=image_part(),
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "model_kind_mismatch"
    assert seen == []
    assert fake.uploaded == []


async def test_unknown_model_is_refused():
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        data=edit_form(model="Qwen/Qwen-Image-9.9", prompt="x"),
        files=image_part(),
        expect_submit=False,
    )
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "unsupported_model"


async def test_two_reference_images_are_refused_with_the_native_bound():
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        data=edit_form(model=QWEN_21, prompt="x"),
        files=[("image[]", ("a.png", PNG, "image/png")), ("image[]", ("b.png", PNG, "image/png"))],
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    error = resp.json()["error"]
    assert error["code"] == "too_many_images"
    assert "10" in error["message"]
    assert "one reference image" in error["message"]


async def test_image_and_image_bracket_together_are_refused():
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        data=edit_form(model=QWEN_21, prompt="x"),
        files=list(image_part()) + [("image[]", ("b.png", PNG, "image/png"))],
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "duplicate_field"


async def test_duplicate_scalar_fields_are_refused():
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        data=[("model", QWEN_21), ("prompt", "a"), ("prompt", "b")],
        files=image_part(),
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "duplicate_field"


async def test_mask_upload_is_refused():
    fake = png_fake()
    files = list(image_part()) + [("mask", ("mask.png", PNG, "image/png"))]
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        data=edit_form(model=QWEN_21, prompt="x"),
        files=files,
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "invalid_field"
    assert "mask" in resp.json()["error"]["message"]


async def test_unknown_upload_name_is_refused():
    fake = png_fake()
    files = list(image_part()) + [("reference", ("x.png", PNG, "image/png"))]
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        data=edit_form(model=QWEN_21, prompt="x"),
        files=files,
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "invalid_field"


async def test_missing_image_is_refused():
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        data=edit_form(model=QWEN_21, prompt="x"),
        files=None,
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "invalid_content_type"


async def test_empty_multipart_image_field_is_refused():
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        data=edit_form(model=QWEN_21, prompt="x"),
        files={"image": (None, "")},
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "invalid_image"


async def test_empty_upload_bytes_are_refused():
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        data=edit_form(model=QWEN_21, prompt="x"),
        files=[("image", ("reference.png", b"", "image/png"))],
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "invalid_image"


async def test_wrong_mime_type_is_refused():
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        files=[("image", ("reference.gif", b"GIF89a" + b"\x00" * 32, "image/gif"))],
        data=edit_form(model=QWEN_21, prompt="x"),
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "invalid_image"


async def test_mislabelled_bytes_are_refused():
    """A PNG declared as JPEG is a contradiction, not something to relabel."""
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        files=[("image", ("reference.jpg", PNG, "image/jpeg"))],
        data=edit_form(model=QWEN_21, prompt="x"),
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "invalid_image"


async def test_undecodable_image_bytes_are_refused():
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        files=[("image", ("reference.png", b"not an image at all", "image/png"))],
        data=edit_form(model=QWEN_21, prompt="x"),
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "invalid_image"


async def test_oversize_upload_is_refused():
    from requests_in import MAX_IMAGE_BYTES

    oversized = PNG + b"\x00" * (MAX_IMAGE_BYTES + 1)
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        files=[("image", ("reference.png", oversized, "image/png"))],
        data=edit_form(model=QWEN_21, prompt="x"),
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "image_too_large"


async def test_overlong_image_axis_is_refused():
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        files=[("image", ("reference.png", png_bytes(5000, 8), "image/png"))],
        data=edit_form(model=QWEN_21, prompt="x"),
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "image_too_large"


@pytest.mark.parametrize("field,value", [
    ("steps", "many"),
    ("cfg", "high"),
    ("resolution", "1.5"),
    ("n", "1.5"),
    ("seed", "later"),
    ("steps", "true"),
    ("cfg", "nan"),
    ("seed", ""),
])
async def test_invalid_numeric_scalars_are_refused(field, value):
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        data=edit_form(model=QWEN_21, prompt="x", **{field: value}),
        files=image_part(),
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "invalid_field"


async def test_unknown_scalar_field_is_refused():
    fake = png_fake()
    resp = await post_edit(
        fake,
        capturing_builder("image", []),
        data=edit_form(model=QWEN_21, prompt="x", image_url="http://example.test/a.png"),
        files=image_part(),
        expect_submit=False,
    )
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "invalid_field"


async def test_out_of_range_resolution_is_refused_by_the_graph_contract():
    """The graph owns the numeric ranges; the bridge only normalizes the text."""
    from graphs import build_graph

    with pytest.raises(ValueError, match="pixel budget"):
        build_graph(QWEN_21, {"prompt": "x", "resolution": 4096}, image_filename="lloom-a.png")


async def test_oversize_body_is_refused_before_the_parser():
    from requests_in import MAX_BODY_BYTES

    fake = png_fake()
    app, comfy = make_bridge(fake, capturing_builder("image", []), models=MODELS)
    async with asgi_client(app) as client:
        await comfy.start()
        # Streamed in chunks rather than handed to httpx as one giant file, so
        # the check is on the bridge's own body cap and not on the client's.
        content = b"x" * (MAX_BODY_BYTES + 1)

        async def chunks():
            for offset in range(0, len(content), 1024 * 1024):
                yield content[offset:offset + 1024 * 1024]

        resp = await client.post(
            "/v1/images/edits",
            content=chunks(),
            headers={"content-type": "multipart/form-data; boundary=xyz"},
        )
        await comfy.aclose()
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "body_too_large"


@pytest.mark.parametrize("kind", ["animated", "truncated"])
async def test_rejects_corrupt_or_animated_reference_before_submit(kind):
    from PIL import Image
    if kind == "animated":
        output = io.BytesIO()
        Image.new("RGB", (64, 64), "red").save(output, format="PNG", save_all=True,
            append_images=[Image.new("RGB", (64, 64), "blue")], duration=100, loop=0)
        data = output.getvalue()
    else:
        data = png_bytes(64, 64)[:-30]
    fake = png_fake()
    response = await post_edit(fake, capturing_builder("image", []),
        data=edit_form(model=QWEN_21, prompt="recolor"), files=image_part(data), expect_submit=False)
    assert response.status_code == 400
    assert not fake.prompts


@pytest.mark.parametrize("field", ["quality", "resolution"])
async def test_2511_rejects_2_1_only_fields(field):
    fake = png_fake()
    response = await post_edit(fake, capturing_builder("image", []),
        data=edit_form(model=QWEN_EDIT, prompt="recolor", **{field: "high" if field == "quality" else 512}),
        files=image_part(), expect_submit=False)
    assert response.status_code == 400
    assert not fake.prompts
