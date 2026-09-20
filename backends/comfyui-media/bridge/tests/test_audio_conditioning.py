"""Audio conditioning: decoding, validation, and the model guard.

A real clip can drive LTX's audio latent and act as a timbre reference. These
tests cover the request contract; graph wiring is covered in
graphs/test_capabilities.py.
"""

from __future__ import annotations

import asyncio
import base64
import struct

import pytest

from conftest import asgi_client, make_bridge, png_data_uri


def wav_data_uri(seconds=0.2, rate=16000):
    """A minimal valid PCM WAV, so the container magic check passes honestly."""
    frames = int(seconds * rate)
    data = b"".join(struct.pack("<h", 0) for _ in range(frames))
    header = (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
              + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
              + b"data" + struct.pack("<I", len(data)))
    return "data:audio/wav;base64," + base64.b64encode(header + data).decode()


async def _finish(fake):
    async def soon():
        await asyncio.wait_for(fake.submitted.wait(), timeout=3)
        await asyncio.sleep(0.02)
        fake.finish()

    return asyncio.ensure_future(soon())


def _builder(seen):
    def build_graph(model_id, payload, image_filename=None, last_image_filename=None,
                    audio_filename=None, prefix="lloom"):
        seen["audio_filename"] = audio_filename
        return {"9": {"class_type": "SaveVideo", "inputs": {}}}, "9", "video"

    return build_graph


async def test_audio_is_uploaded_and_named_for_the_graph():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=b"\x00\x00\x00\x18ftypmp42-video")
    seen = {}
    app, comfy = make_bridge(fake, _builder(seen))
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = await _finish(fake)
        resp = await client.post("/v1/videos/generations",
                                 json={"model": "video-model", "prompt": "a fox",
                                       "audio": wav_data_uri()})
        await finisher
        assert resp.status_code == 200, resp.text
        await comfy.aclose()
    assert seen["audio_filename"], "the graph must receive an audio filename"
    assert seen["audio_filename"].endswith(".wav")
    assert len(fake.uploaded) == 1


async def test_audio_and_frames_together_upload_separately():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=b"\x00\x00\x00\x18ftypmp42-video")
    seen = {}
    app, comfy = make_bridge(fake, _builder(seen))
    async with asgi_client(app) as client:
        await comfy.start()
        finisher = await _finish(fake)
        resp = await client.post("/v1/videos/generations",
                                 json={"model": "video-model", "prompt": "a fox",
                                       "image": png_data_uri(),
                                       "last_frame": png_data_uri(),
                                       "audio": wav_data_uri()})
        await finisher
        assert resp.status_code == 200, resp.text
        await comfy.aclose()
    assert len(fake.uploaded) == 3, "two frames plus one audio clip"
    names = [n for n, _b, _c in fake.uploaded]
    assert len(set(names)) == 3, "each upload needs its own name"


async def test_non_audio_payload_is_rejected_as_audio():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=b"\x00\x00\x00\x18ftypmp42-video")
    seen = {}
    app, comfy = make_bridge(fake, _builder(seen))
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post("/v1/videos/generations",
                                 json={"model": "video-model", "prompt": "a fox",
                                       "audio": png_data_uri().replace("image/png", "audio/wav")})
        assert resp.status_code in (400, 422), resp.text
        await comfy.aclose()
    assert fake.uploaded == []


async def test_audio_url_is_refused():
    from fake_comfy import FakeComfy

    fake = FakeComfy(artifact=b"\x00\x00\x00\x18ftypmp42-video")
    seen = {}
    app, comfy = make_bridge(fake, _builder(seen))
    async with asgi_client(app) as client:
        await comfy.start()
        resp = await client.post("/v1/videos/generations",
                                 json={"model": "video-model", "prompt": "a fox",
                                       "audio": "https://example.test/line.wav"})
        assert resp.status_code in (400, 422), resp.text
        await comfy.aclose()
    assert fake.uploaded == []


def test_audio_conditioning_is_ltx_only():
    import os
    import sys

    # service/graphs holds graphs.py, which is imported as a top-level module when
    # its own suite runs.
    service_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    graphs_dir = os.path.join(service_root, "graphs")
    if graphs_dir not in sys.path:
        sys.path.insert(0, graphs_dir)
    from graphs import build_graph

    with pytest.raises(ValueError, match="not supported"):
        build_graph("MiniMaxAI/MiniMax-H3", {"prompt": "x", "duration": 5, "steps": 20},
                    audio_filename="lloom-a.wav")
    graph, _out, _kind = build_graph("Lightricks/LTX-2.5",
                                     {"prompt": "x", "size": "640x384", "duration": 5, "steps": 8},
                                     audio_filename="lloom-a.wav")
    classes = [n["class_type"] for n in graph.values()]
    assert "LoadAudio" in classes
    assert "LTXVAudioVAEEncode" in classes
    assert "LTXVReferenceAudio" in classes
    assert "LTXVEmptyLatentAudio" not in classes, "real audio must replace the empty latent"
