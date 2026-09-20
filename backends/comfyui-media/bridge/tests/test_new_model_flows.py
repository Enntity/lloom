"""End-to-end flows for the three models added to the media backend.

These drive the real app over the fake ComfyUI harness, so they prove that the
registry entries, the endpoint/model-kind checks and the new request fields
survive the trip from HTTP to the graph builder.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys

from conftest import asgi_client, make_bridge

# A real 1x1 PNG: the bridge sniffs artifact bytes, so a fake extension is not
# enough to make an image response valid.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
WAV = b"RIFF" + (36).to_bytes(4, "little") + b"WAVEfmt " + b"\x00" * 16

MODELS = {
    "Comfy-Org/Krea-2-Turbo": {"kind": "image", "family": "krea2"},
    "Comfy-Org/Ideogram-4": {"kind": "image", "family": "ideogram4"},
    "Comfy-Org/YuE2-3B": {"kind": "audio", "family": "yue2"},
}

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), "graphs"))


def capturing_builder(kind, seen):
    def build_graph(model_id, payload, image_filename=None, prefix="lloom", **kwargs):
        seen.append({"model": model_id, "payload": payload, "image": image_filename,
                     "prefix": prefix, "kwargs": kwargs})
        return {"9": {"class_type": "SaveImage" if kind == "image" else "SaveAudio",
                      "inputs": {}}}, "9", kind

    return build_graph


def png_fake():
    """A fake whose history publishes a ``.png`` artifact name like SaveImage."""
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=PNG)
    fake.artifact_item = {"filename": "lloom_00001.png", "subfolder": "", "type": "output"}
    return fake


async def post(fake, builder, path, payload, *, expect_submit=True):
    """POST one request, finishing the fake job if one is queued.

    A rejected request never reaches Comfy, so waiting for the submit event
    would hang; ``expect_submit`` says which of the two we are asserting.
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
        resp = await client.post(path, json=payload)
        if finisher is not None:
            await finisher
        await comfy.aclose()
        return resp


async def test_images_endpoint_serves_krea2():
    fake = png_fake()
    seen = []
    resp = await post(fake, capturing_builder("image", seen), "/v1/images/generations",
                      {"model": "Comfy-Org/Krea-2-Turbo", "prompt": "a red barn",
                       "size": "1024x768"})
    assert resp.status_code == 200, resp.text
    item = resp.json()["data"][0]
    assert item["mime_type"] == "image/png"
    assert base64.b64decode(item["b64_json"]) == PNG
    assert seen[0]["model"] == "Comfy-Org/Krea-2-Turbo"
    assert seen[0]["payload"]["size"] == "1024x768"
    assert seen[0]["image"] is None
    assert seen[0]["prefix"].startswith("lloom_")


async def test_images_endpoint_serves_ideogram4_with_its_new_fields():
    fake = png_fake()
    seen = []
    resp = await post(fake, capturing_builder("image", seen), "/v1/images/generations",
                      {"model": "Comfy-Org/Ideogram-4", "prompt": "editorial poster",
                       "size": "2048x1152", "preset": "Quality", "steps": 30,
                       "mu": 0.25, "std": 2.0})
    assert resp.status_code == 200, resp.text
    payload = seen[0]["payload"]
    assert seen[0]["model"] == "Comfy-Org/Ideogram-4"
    for field, value in (("preset", "Quality"), ("steps", 30), ("mu", 0.25), ("std", 2.0),
                         ("size", "2048x1152")):
        assert payload[field] == value, f"{field} did not reach the builder"


async def test_audio_endpoint_serves_yue2_with_its_new_fields():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=WAV)
    seen = []
    resp = await post(fake, capturing_builder("audio", seen), "/v1/audio/generations",
                      {"model": "Comfy-Org/YuE2-3B", "instructions": "warm indie pop",
                       "lyrics": "[Verse]\nhi", "max_duration": 120, "mode": "melody",
                       "abc_planning": True, "steps": 16, "cfg": 2.0})
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("audio/wav")
    assert resp.content == WAV
    payload = seen[0]["payload"]
    assert seen[0]["model"] == "Comfy-Org/YuE2-3B"
    for field, value in (("max_duration", 120), ("mode", "melody"), ("abc_planning", True),
                         ("steps", 16), ("cfg", 2.0), ("lyrics", "[Verse]\nhi")):
        assert payload[field] == value, f"{field} did not reach the builder"


async def test_unknown_model_is_still_refused():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=PNG)
    for path, payload in (
        ("/v1/images/generations", {"model": "Comfy-Org/Does-Not-Exist", "prompt": "x"}),
        ("/v1/audio/generations", {"model": "Comfy-Org/Does-Not-Exist", "input": "x"}),
    ):
        resp = await post(fake, capturing_builder("image", []), path, payload,
                          expect_submit=False)
        assert resp.status_code == 400, f"{path}: {resp.status_code} {resp.text}"
        assert resp.json()["error"]["code"] == "unsupported_model", resp.text


async def test_new_image_models_are_not_served_on_the_audio_endpoint():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=WAV)
    resp = await post(fake, capturing_builder("image", []), "/v1/audio/generations",
                      {"model": "Comfy-Org/Krea-2-Turbo", "input": "x"}, expect_submit=False)
    assert resp.status_code == 400, resp.text
    assert resp.json()["error"]["code"] == "model_kind_mismatch", resp.text
    assert not fake.prompts, "a rejected request must never reach Comfy"


async def test_new_image_model_refuses_a_reference_image_at_the_bridge():
    # The registry says these are text-to-image, so an inline image must be a 400
    # from the graph's own rejection: not a 500, and not a silently dropped field.
    from fake_comfy import FakeComfy
    from graphs import build_graph

    def strict_builder(model_id, payload, image_filename=None, prefix="lloom"):
        return build_graph(model_id, payload, image_filename=image_filename, prefix=prefix)

    fake = png_fake()
    resp = await post(fake, strict_builder, "/v1/images/generations",
                      {"model": "Comfy-Org/Krea-2-Turbo", "prompt": "x",
                       "image": "data:image/png;base64," + base64.b64encode(PNG).decode()},
                      expect_submit=False)
    assert resp.status_code == 400, resp.text
    assert "image" in json.dumps(resp.json()).lower()


async def test_music_is_rejected_at_speech_endpoint_before_submission():
    fake = png_fake()
    seen = []
    resp = await post(fake, capturing_builder('audio', seen), '/v1/audio/speech',
                      {'model': 'Comfy-Org/YuE2-3B', 'lyrics': 'hello'}, expect_submit=False)
    assert resp.status_code == 400
    assert resp.json()['error']['code'] == 'wrong_model_kind'
    assert seen == []


async def test_identical_requests_have_distinct_save_nodes():
    # The bridge deletes fetched files. A cached SaveImage must not point the
    # next identical request at that deleted artifact; only its output prefix
    # changes, so reusable model loaders can stay cached.
    seen = []
    payload = {"model": "Comfy-Org/Krea-2-Turbo", "prompt": "a red barn"}
    for _ in range(2):
        response = await post(png_fake(), capturing_builder("image", seen),
                              "/v1/images/generations", payload)
        assert response.status_code == 200
    assert seen[0]["prefix"] != seen[1]["prefix"]
