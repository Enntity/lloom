"""Wiring checks for Qwen-Image 2.1, read off the pinned official templates.

2.1 is the one family here that both generates and edits from a single DiT, and
its conditioning node hands back the latent it was built for. These tests pin
that contract offline: no engine, no weights, no network.

The distinctions that matter and are easy to get wrong:

  * the shared engine's 2512 lane needs ``ModelSamplingAuraFlow`` at 3.1, while
    2.1 carries its own shift and must not be patched;
  * 2.1 uses Qwen3-VL-8B text encoders and its own VAE, not the 2.5-VL / shared
    VAE pair the other Qwen lanes load;
  * an edit samples the encoder's latent *and* wires its reference image into
    the encoder's autogrow slot, which is where the reference set lives.
"""

import pytest

from graphs import build_graph

QWEN_21 = "Qwen/Qwen-Image-2.1"


def nodes_of(graph, class_type):
    return [n for n in graph.values() if n["class_type"] == class_type]


def only(graph, class_type):
    found = nodes_of(graph, class_type)
    assert len(found) == 1, f"expected one {class_type}, found {len(found)}"
    return found[0]


def node_id(graph, class_type):
    return [nid for nid, n in graph.items() if n["class_type"] == class_type][0]


# ------------------------------------------------------------------- generation


def test_generation_wiring_matches_template():
    graph, output, kind = build_graph(QWEN_21, {"prompt": "a heron over reeds", "size": "1024x768"})
    assert kind == "image"
    assert graph[output]["class_type"] == "SaveImage"

    assert only(graph, "UNETLoader")["inputs"] == {
        "unet_name": "qwen_image_2.1_int8_convrot.safetensors", "weight_dtype": "default"}
    assert only(graph, "CLIPLoader")["inputs"] == {
        "clip_name": "qwen3vl_8b_int8_convrot.safetensors", "type": "qwen_image", "device": "default"}
    assert only(graph, "VAELoader")["inputs"]["vae_name"] == "qwen_image_2.1_vae_bf16.safetensors"

    encode = only(graph, "TextEncodeQwenImage21")
    assert encode["inputs"]["prompt"] == "a heron over reeds"
    assert "images" not in encode["inputs"]
    assert only(graph, "EmptyLatentImage")["inputs"] == {"width": 1024, "height": 768, "batch_size": 1}

    sample = only(graph, "KSampler")
    assert sample["inputs"]["latent_image"] == [node_id(graph, "EmptyLatentImage"), 0]
    assert sample["inputs"]["sampler_name"] == "euler"
    assert sample["inputs"]["steps"] == 25
    assert sample["inputs"]["cfg"] == 1.0


def test_2_1_is_not_patched_with_aura_flow():
    """2.1 carries its own sampling shift; the 2512 aura-flow patch would override it."""
    graph, _, _ = build_graph(QWEN_21, {"prompt": "a heron over reeds"})
    assert nodes_of(graph, "ModelSamplingAuraFlow") == []
    assert only(graph, "KSampler")["inputs"]["model"] == [node_id(graph, "UNETLoader"), 0]


def test_generation_honours_explicit_steps_and_cfg():
    graph, _, _ = build_graph(QWEN_21, {"prompt": "a heron", "steps": 40, "cfg": 4.0})
    sample = only(graph, "KSampler")
    assert (sample["inputs"]["steps"], sample["inputs"]["cfg"]) == (40, 4.0)


# ------------------------------------------------------------------------ edits


def test_edit_wires_reference_into_autogrow_and_samples_encoder_latent():
    graph, _, kind = build_graph(QWEN_21, {"prompt": "make it dusk"}, image_filename="lloom-abc.png")
    assert kind == "image"
    encode = only(graph, "TextEncodeQwenImage21")
    assert encode["inputs"]["images.image_1"] == [node_id(graph, "LoadImage"), 0]
    assert "images" not in encode["inputs"]
    assert only(graph, "LoadImage")["inputs"]["image"] == "lloom-abc.png"
    assert encode["inputs"]["vae"] == [node_id(graph, "VAELoader"), 0]
    # The node's own latent is the only geometry an edit may sample.
    assert only(graph, "KSampler")["inputs"]["latent_image"] == [node_id(graph, "TextEncodeQwenImage21"), 2]
    assert nodes_of(graph, "EmptyLatentImage") == []


def test_edit_resolution_is_the_reference_pixel_budget():
    graph, _, _ = build_graph(QWEN_21, {"prompt": "make it dusk", "resolution": 2048},
                              image_filename="lloom-abc.png")
    assert only(graph, "TextEncodeQwenImage21")["inputs"]["resolution"] == 2048


@pytest.mark.parametrize("payload", [{"width": 1024}, {"height": 1024}, {"size": "1024x1024"}])
def test_edit_rejects_geometry_it_would_silently_drop(payload):
    with pytest.raises(ValueError, match="resolution"):
        build_graph(QWEN_21, {"prompt": "make it dusk", **payload}, image_filename="lloom-abc.png")


def test_generation_still_accepts_geometry():
    graph, _, _ = build_graph(QWEN_21, {"prompt": "a heron", "width": 1536, "height": 640})
    assert only(graph, "EmptyLatentImage")["inputs"] == {"width": 1536, "height": 640, "batch_size": 1}


# --------------------------------------------------------------------- rejections


def test_edit_resolution_is_bounded():
    with pytest.raises(ValueError, match="pixel budget"):
        build_graph(QWEN_21, {"prompt": "make it dusk", "resolution": 4096},
                    image_filename="lloom-abc.png")


def test_generation_ignores_the_edit_only_resolution_hint():
    """Resolution only resizes references, so it cannot steer a text-to-image latent."""
    graph, _, _ = build_graph(QWEN_21, {"prompt": "a heron", "resolution": 2048})
    assert only(graph, "EmptyLatentImage")["inputs"]["width"] == 1024


def test_prompt_is_required():
    with pytest.raises(ValueError, match="prompt is required"):
        build_graph(QWEN_21, {"prompt": "   "})


@pytest.mark.parametrize("payload", [
    {"steps": 0},
    {"steps": 61},
    {"cfg": 0.5},
    {"cfg": 9.0},
    {"width": 1023, "height": 1024},
    {"graph": {}},
    {"n": 2},
])
def test_unsupported_parameters_are_rejected(payload):
    with pytest.raises(ValueError):
        build_graph(QWEN_21, {"prompt": "a heron", **payload})
