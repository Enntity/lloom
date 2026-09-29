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

import json

import pytest

import graphs
from graphs import build_graph

QWEN_21 = "Qwen/Qwen-Image-2.1"
QWEN_21_NVFP4 = "BennyDaBall/Qwen-Image-2.1-NVFP4"


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
    assert sample["inputs"]["steps"] == 40
    assert sample["inputs"]["cfg"] == 1.0


def test_2_1_is_not_patched_with_aura_flow():
    """2.1 carries its own sampling shift; the 2512 aura-flow patch would override it."""
    graph, _, _ = build_graph(QWEN_21, {"prompt": "a heron over reeds"})
    assert nodes_of(graph, "ModelSamplingAuraFlow") == []
    assert only(graph, "KSampler")["inputs"]["model"] == [node_id(graph, "UNETLoader"), 0]


def test_generation_honours_explicit_steps_and_cfg():
    graph, _, _ = build_graph(QWEN_21, {"prompt": "a heron", "steps": 33, "cfg": 1.0})
    sample = only(graph, "KSampler")
    assert (sample["inputs"]["steps"], sample["inputs"]["cfg"]) == (33, 1.0)


# ------------------------------------------------------------------------ edits


def test_edit_wires_reference_into_autogrow_and_samples_encoder_latent():
    graph, _, kind = build_graph(QWEN_21, {"prompt": "make it dusk"}, image_filename="lloom-abc.png")
    assert kind == "image"
    encode = only(graph, "TextEncodeQwenImage21")
    assert encode["inputs"]["images.image_1"] == [node_id(graph, "JoinImageWithAlpha"), 0]
    join = only(graph, "JoinImageWithAlpha")["inputs"]
    assert join == {"image": [node_id(graph, "LoadImage"), 0], "alpha": [node_id(graph, "LoadImage"), 1]}
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


def test_generation_uses_resolution_when_size_omitted():
    """The same resolution budget supplies generation defaults and edit resizing."""
    graph, _, _ = build_graph(QWEN_21, {"prompt": "a heron", "resolution": 2048})
    assert only(graph, "EmptyLatentImage")["inputs"]["width"] == 2048


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


# --------------------------------------------------------------------- seeding


def test_omitted_seed_is_fresh_cryptographic_random_per_build(monkeypatch):
    """A generate-then-edit pair must not reuse one seed (issue 14824)."""
    seen = []

    def fake_randbits(k):
        seen.append(k)
        return len(seen) * 7

    monkeypatch.setattr(graphs.secrets, "randbits", fake_randbits)
    first_seed = only(build_graph(QWEN_21, {"prompt": "a heron"})[0], "KSampler")["inputs"]["seed"]
    second_seed = only(build_graph(QWEN_21, {"prompt": "a heron"})[0], "KSampler")["inputs"]["seed"]
    edit_seed = only(build_graph(QWEN_21, {"prompt": "make it dusk"},
                                 image_filename="lloom-abc.png")[0], "KSampler")["inputs"]["seed"]
    assert (first_seed, second_seed, edit_seed) == (7, 14, 21)
    assert seen == [53, 53, 53]


def test_explicit_seed_is_honoured_without_perturbation(monkeypatch):
    def explode(k):
        raise AssertionError("explicit seeds must never consult the random source")

    monkeypatch.setattr(graphs.secrets, "randbits", explode)
    for payload, image in (({"prompt": "a heron"}, None),
                           ({"prompt": "make it dusk"}, "lloom-abc.png")):
        graph, _, _ = build_graph(QWEN_21, {"seed": 1234, **payload}, image_filename=image)
        assert only(graph, "KSampler")["inputs"]["seed"] == 1234
    day = build_graph(QWEN_21, {"seed": 2**53 - 1, "prompt": "a heron"})[0]
    assert only(day, "KSampler")["inputs"]["seed"] == 2**53 - 1


def test_other_models_keep_their_fixed_seed_default():
    """The fresh-seed rule is scoped to 2.1; every other lane still defaults to 42."""
    seed_of = {
        "Qwen/Qwen-Image-2512": lambda g: only(g, "KSampler")["inputs"]["seed"],
        "black-forest-labs/FLUX.2-klein-4B": lambda g: only(g, "RandomNoise")["inputs"]["noise_seed"],
    }
    for model, read in seed_of.items():
        graph, _, _ = build_graph(model, {"prompt": "a heron"})
        assert read(graph) == 42


# ---------------------------------------------------------------------- quality


@pytest.mark.parametrize("quality,steps", [
    ("high", 40),
    ("medium", 25),
    ("low", 12),
    ("auto", 40),
])
def test_quality_presets_map_to_steps(quality, steps):
    graph, _, _ = build_graph(QWEN_21, {"prompt": "a heron", "quality": quality})
    assert only(graph, "KSampler")["inputs"]["steps"] == steps


def test_quality_defaults_to_auto_when_omitted():
    graph, _, _ = build_graph(QWEN_21, {"prompt": "a heron"})
    assert only(graph, "KSampler")["inputs"]["steps"] == 40


def test_explicit_steps_override_quality():
    graph, _, _ = build_graph(QWEN_21, {"prompt": "a heron", "quality": "low", "steps": 50})
    assert only(graph, "KSampler")["inputs"]["steps"] == 50


def test_edit_uses_the_same_quality_mapping():
    for quality, steps in (("high", 40), ("medium", 25), ("low", 12)):
        graph, _, _ = build_graph(QWEN_21, {"prompt": "make it dusk", "quality": quality},
                                  image_filename="lloom-abc.png")
        assert only(graph, "KSampler")["inputs"]["steps"] == steps
    tuned = build_graph(QWEN_21, {"prompt": "make it dusk", "quality": "high", "steps": 33},
                        image_filename="lloom-abc.png")[0]
    assert only(tuned, "KSampler")["inputs"]["steps"] == 33


@pytest.mark.parametrize("quality", ["ultra", "HIGH", "", 40, None, "high "])
def test_invalid_quality_is_rejected_not_dropped(quality):
    with pytest.raises(ValueError, match="quality must be one of"):
        build_graph(QWEN_21, {"prompt": "a heron", "quality": quality})
    with pytest.raises(ValueError, match="quality must be one of"):
        build_graph(QWEN_21, {"prompt": "make it dusk", "quality": quality},
                    image_filename="lloom-abc.png")


def test_other_models_ignore_quality_entirely():
    """The dial is 2.1-only: another lane's fixed step contract is left untouched."""
    graph, _, _ = build_graph("black-forest-labs/FLUX.2-klein-4B", {"prompt": "a heron"})
    assert graphs.qwen_image_21_steps({"quality": "low"}) == 12
    # FLUX.2 pins its own 4-step scheduler; quality cannot reach it.
    assert only(graph, "Flux2Scheduler")["inputs"]["steps"] == 4


@pytest.mark.parametrize("changes", [{"cfg": 7}, {"resolution": 123}, {"size": "3072x3072"}, {"seed": 2**53}, {"quality": "default"}, {"mask": "x"}, {"negative_prompt": "blur"}, {"size": "512x512", "width": 1024}])
def test_qwen_native_contract_bounds(changes):
    with pytest.raises(ValueError):
        build_graph(QWEN_21, {"prompt": "a heron", **changes})


def test_qwen_native_2k_geometry():
    graph, _, _ = build_graph(QWEN_21, {"prompt": "a heron", "size": "2752x1536"})
    assert only(graph, "EmptyLatentImage")["inputs"]["width"] == 2752


# ------------------------------------------------------------------- NVFP4 lane
#
# The NVFP4 lane is additive: it is the same 2.1 contract with a different fixed
# checkpoint set. These tests pin the two things that differ (the filenames the
# loaders open) and the many things that must not (steps, cfg, seed freshness,
# edit wiring, geometry, rejections). The INT8 lane above is asserted again here
# so a shared-code change cannot quietly move it.

NVFP4_FILES = {
    "diffusion": "qwen_image_2.1_nvfp4.safetensors",
    "encoder": "qwen3vl_8b_nvfp4.safetensors",
    "vae": "qwen_image_2.1_vae_bf16.safetensors",
}
INT8_FILES = {
    "diffusion": "qwen_image_2.1_int8_convrot.safetensors",
    "encoder": "qwen3vl_8b_int8_convrot.safetensors",
    "vae": "qwen_image_2.1_vae_bf16.safetensors",
}


def test_nvfp4_is_a_fixed_checkpoint_set_not_a_request_field():
    """The model ID selects the files; a request can never name a checkpoint."""
    assert graphs.MODELS[QWEN_21_NVFP4] == {"kind": "image", "family": "qwen-image-21"}
    assert graphs.QWEN_IMAGE_21_CHECKPOINTS[QWEN_21_NVFP4] == NVFP4_FILES
    assert graphs.QWEN_IMAGE_21_CHECKPOINTS[QWEN_21] == INT8_FILES
    # The shared VAE is genuinely shared, and the two DiTs never collide.
    assert NVFP4_FILES["vae"] == INT8_FILES["vae"]
    assert NVFP4_FILES["diffusion"] != INT8_FILES["diffusion"]
    assert NVFP4_FILES["encoder"] != INT8_FILES["encoder"]


def test_nvfp4_generation_loads_the_pinned_nvfp4_files():
    graph, output, kind = build_graph(QWEN_21_NVFP4, {"prompt": "a heron over reeds", "size": "1024x768"})
    assert kind == "image"
    assert graph[output]["class_type"] == "SaveImage"
    assert only(graph, "UNETLoader")["inputs"] == {
        "unet_name": "qwen_image_2.1_nvfp4.safetensors", "weight_dtype": "default"}
    assert only(graph, "CLIPLoader")["inputs"] == {
        "clip_name": "qwen3vl_8b_nvfp4.safetensors", "type": "qwen_image", "device": "default"}
    assert only(graph, "VAELoader")["inputs"]["vae_name"] == "qwen_image_2.1_vae_bf16.safetensors"


def test_nvfp4_edit_loads_the_pinned_nvfp4_files_and_shared_vae():
    graph, _, kind = build_graph(QWEN_21_NVFP4, {"prompt": "make it dusk"},
                                 image_filename="lloom-abc.png")
    assert kind == "image"
    assert only(graph, "UNETLoader")["inputs"]["unet_name"] == "qwen_image_2.1_nvfp4.safetensors"
    assert only(graph, "CLIPLoader")["inputs"]["clip_name"] == "qwen3vl_8b_nvfp4.safetensors"
    assert only(graph, "VAELoader")["inputs"]["vae_name"] == "qwen_image_2.1_vae_bf16.safetensors"
    encode = only(graph, "TextEncodeQwenImage21")
    assert encode["inputs"]["vae"] == [node_id(graph, "VAELoader"), 0]
    assert encode["inputs"]["images.image_1"] == [node_id(graph, "JoinImageWithAlpha"), 0]


def _comparable(graph):
    """The graph with loader filenames erased, so contracts can be diffed."""
    stripped = json.loads(json.dumps(graph))
    for node in stripped.values():
        node["inputs"].pop("unet_name", None)
        node["inputs"].pop("clip_name", None)
        node["inputs"].pop("vae_name", None)
    return stripped


@pytest.mark.parametrize("payload,image", [
    ({"prompt": "a heron over reeds", "size": "1024x768"}, None),
    ({"prompt": "a heron", "size": "2752x1536"}, None),
    ({"prompt": "a heron", "quality": "low"}, None),
    ({"prompt": "a heron", "quality": "medium", "steps": 33}, None),
    ({"prompt": "a heron", "seed": 1234, "resolution": 2048}, None),
    ({"prompt": "make it dusk"}, "lloom-abc.png"),
    ({"prompt": "make it dusk", "resolution": 2048, "steps": 30}, "lloom-abc.png"),
    ({"prompt": "make it dusk", "quality": "high"}, "lloom-abc.png"),
])
def test_nvfp4_and_int8_build_the_identical_contract(payload, image):
    """Same step/quality/cfg/geometry/edit wiring; only the pinned files differ."""
    payload = {"seed": 112358, **payload}
    int8, int8_out, int8_kind = build_graph(QWEN_21, payload, image_filename=image)
    nvfp4, nvfp4_out, nvfp4_kind = build_graph(QWEN_21_NVFP4, payload, image_filename=image)
    assert (nvfp4_kind, nvfp4_out) == (int8_kind, int8_out)
    assert _comparable(nvfp4) == _comparable(int8)
    assert nodes_of(nvfp4, "ModelSamplingAuraFlow") == []
    assert only(nvfp4, "KSampler")["inputs"]["cfg"] == 1.0


def test_nvfp4_keeps_cfg1_and_rejects_the_same_fields():
    for changes in ({"cfg": 7}, {"negative_prompt": "blur"}, {"resolution": 123},
                    {"size": "3072x3072"}, {"seed": 2**53}, {"quality": "default"},
                    {"mask": "x"}, {"n": 2}, {"steps": 0}):
        with pytest.raises(ValueError):
            build_graph(QWEN_21_NVFP4, {"prompt": "a heron", **changes})
    with pytest.raises(ValueError, match="resolution"):
        build_graph(QWEN_21_NVFP4, {"prompt": "make it dusk", "width": 1024},
                    image_filename="lloom-abc.png")


def test_nvfp4_uses_the_same_quality_presets():
    for quality, steps in (("high", 40), ("medium", 25), ("low", 12), ("auto", 40)):
        graph, _, _ = build_graph(QWEN_21_NVFP4, {"prompt": "a heron", "quality": quality})
        assert only(graph, "KSampler")["inputs"]["steps"] == steps


def test_nvfp4_omitted_seed_is_fresh_53_bit_random_per_build(monkeypatch):
    seen = []

    def fake_randbits(k):
        seen.append(k)
        return len(seen) * 7

    monkeypatch.setattr(graphs.secrets, "randbits", fake_randbits)
    first = only(build_graph(QWEN_21_NVFP4, {"prompt": "a heron"})[0], "KSampler")["inputs"]["seed"]
    edit = only(build_graph(QWEN_21_NVFP4, {"prompt": "make it dusk"},
                            image_filename="lloom-abc.png")[0], "KSampler")["inputs"]["seed"]
    assert (first, edit) == (7, 14)
    assert seen == [53, 53]


def test_nvfp4_explicit_seed_is_honoured_without_perturbation(monkeypatch):
    def explode(k):
        raise AssertionError("explicit seeds must never consult the random source")

    monkeypatch.setattr(graphs.secrets, "randbits", explode)
    graph, _, _ = build_graph(QWEN_21_NVFP4, {"seed": 1234, "prompt": "a heron"})
    assert only(graph, "KSampler")["inputs"]["seed"] == 1234
    day = build_graph(QWEN_21_NVFP4, {"seed": 2**53 - 1, "prompt": "a heron"})[0]
    assert only(day, "KSampler")["inputs"]["seed"] == 2**53 - 1


def test_nvfp4_supports_image_edit():
    assert graphs.supports_image_edit(QWEN_21_NVFP4) is True
