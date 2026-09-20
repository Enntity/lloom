"""Wiring checks for the three models added on top of the pinned templates.

The node classes, input names and widget values here were read from the pinned
engine's official templates for Ideogram 4, Krea 2 Turbo and YuE2, so these
tests pin the exact graph a request produces rather than a plausible-looking
one. Everything is offline: no engine, no weights, no network.
"""

import json

import pytest

from graphs import build_graph

KREA = "Comfy-Org/Krea-2-Turbo"
IDEO = "Comfy-Org/Ideogram-4"
YUE = "Comfy-Org/YuE2-3B"


def nodes_of(graph, class_type):
    return [n for n in graph.values() if n["class_type"] == class_type]


def only(graph, class_type):
    found = nodes_of(graph, class_type)
    assert len(found) == 1, f"expected one {class_type}, found {len(found)}"
    return found[0]


def node_id(graph, class_type):
    return [nid for nid, n in graph.items() if n["class_type"] == class_type][0]


def source(graph, ref):
    """The (node_id, class_type) feeding a slot reference."""
    assert isinstance(ref, list) and ref, f"expected a slot reference, got {ref!r}"
    return ref[0], graph[ref[0]]["class_type"]


# ------------------------------------------------------------------ Krea 2 Turbo


def test_krea2_wiring_matches_template():
    graph, output, kind = build_graph(KREA, {"prompt": "a red barn", "size": "1024x768"})
    assert kind == "image"
    assert graph[output]["class_type"] == "SaveImage"

    unet = only(graph, "UNETLoader")
    assert unet["inputs"] == {"unet_name": "krea2_turbo_int8_convrot.safetensors",
                              "weight_dtype": "default"}
    clip = only(graph, "CLIPLoader")
    assert clip["inputs"] == {"clip_name": "qwen3vl_4b_fp8_scaled.safetensors",
                              "type": "krea2", "device": "default"}
    assert only(graph, "VAELoader")["inputs"]["vae_name"] == "qwen_image_vae.safetensors"

    encode = only(graph, "CLIPTextEncode")
    assert encode["inputs"]["text"] == "a red barn"
    assert source(graph, encode["inputs"]["clip"]) == (node_id(graph, "CLIPLoader"), "CLIPLoader")
    zero = only(graph, "ConditioningZeroOut")
    assert source(graph, zero["inputs"]["conditioning"])[1] == "CLIPTextEncode"

    latent = only(graph, "EmptyLatentImage")
    assert latent["inputs"] == {"width": 1024, "height": 768, "batch_size": 1}

    sampler = only(graph, "KSampler")
    assert sampler["inputs"]["steps"] == 8
    assert sampler["inputs"]["cfg"] == 1.0
    assert sampler["inputs"]["sampler_name"] == "euler"
    assert sampler["inputs"]["scheduler"] == "simple"
    assert sampler["inputs"]["denoise"] == 1.0
    assert sampler["inputs"]["seed"] == 42
    assert source(graph, sampler["inputs"]["model"])[1] == "UNETLoader"
    assert source(graph, sampler["inputs"]["positive"])[1] == "CLIPTextEncode"
    assert source(graph, sampler["inputs"]["negative"])[1] == "ConditioningZeroOut"
    assert source(graph, sampler["inputs"]["latent_image"])[1] == "EmptyLatentImage"

    decode = only(graph, "VAEDecode")
    assert source(graph, decode["inputs"]["samples"])[1] == "KSampler"
    assert source(graph, decode["inputs"]["vae"])[1] == "VAELoader"
    assert source(graph, graph[output]["inputs"]["images"])[1] == "VAEDecode"


def test_krea2_class_counts():
    graph, _, _ = build_graph(KREA, {"prompt": "x", "size": "1024x768"})
    assert sorted(n["class_type"] for n in graph.values()) == sorted([
        "UNETLoader", "CLIPLoader", "VAELoader", "CLIPTextEncode",
        "ConditioningZeroOut", "EmptyLatentImage", "KSampler", "VAEDecode",
        "SaveImage",
    ])


@pytest.mark.parametrize("payload,match", [
    ({"steps": 12}, "steps"),
    ({"steps": 7}, "steps"),
    ({"cfg": 2.0}, "cfg"),
])
def test_krea2_rejects_non_turbo_sampling(payload, match):
    with pytest.raises(ValueError, match=match):
        build_graph(KREA, {"prompt": "x", "size": "1024x768", **payload})


def test_krea2_rejects_inline_reference_image():
    # A text-to-image checkpoint has no conditioning input, so a reference image
    # cannot be honoured and must not be dropped silently.
    with pytest.raises(ValueError, match="image"):
        build_graph(KREA, {"prompt": "x", "size": "1024x768",
                           "image": "data:image/png;base64,aA=="})


def test_krea2_rejects_uploaded_reference_image():
    with pytest.raises(ValueError, match="image"):
        build_graph(KREA, {"prompt": "x", "size": "1024x768"}, image_filename="lloom-1.png")


def test_krea2_rejects_oversized_geometry():
    with pytest.raises(ValueError):
        build_graph(KREA, {"prompt": "x", "size": "2048x2048"})


# ------------------------------------------------------------------ Ideogram 4


def test_ideogram4_wiring_and_preset():
    graph, output, kind = build_graph(
        IDEO, {"prompt": "editorial poster", "size": "2048x1152", "preset": "Quality"}
    )
    assert kind == "image"
    assert graph[output]["class_type"] == "SaveImage"

    unets = sorted(n["inputs"]["unet_name"] for n in nodes_of(graph, "UNETLoader"))
    assert unets == ["ideogram4_int8_convrot.safetensors",
                     "ideogram4_unconditional_int8_convrot.safetensors"]
    conditional = [n for n in nodes_of(graph, "UNETLoader")
                   if n["inputs"]["unet_name"] == "ideogram4_int8_convrot.safetensors"][0]
    assert conditional["inputs"]["weight_dtype"] == "default"

    clip = only(graph, "CLIPLoader")
    assert clip["inputs"] == {"clip_name": "qwen3vl_8b_fp8_scaled.safetensors",
                              "type": "ideogram4", "device": "default"}
    assert only(graph, "VAELoader")["inputs"]["vae_name"] == "flux2-vae.safetensors"

    scheduler = only(graph, "Ideogram4Scheduler")
    assert scheduler["inputs"] == {"steps": 48, "width": 2048, "height": 1152,
                                   "mu": 0.0, "std": 1.5}

    guider = only(graph, "DualModelGuider")
    assert guider["inputs"]["cfg"] == 7.0
    uncond_id = [nid for nid, n in graph.items() if n["class_type"] == "UNETLoader"
                 and n["inputs"]["unet_name"] == "ideogram4_unconditional_int8_convrot.safetensors"][0]
    assert guider["inputs"]["model_negative"] == [uncond_id, 0]
    assert source(graph, guider["inputs"]["model"]) == (
        [nid for nid, n in graph.items() if n["class_type"] == "UNETLoader"
         and n["inputs"]["unet_name"] == "ideogram4_int8_convrot.safetensors"][0],
        "UNETLoader",
    )
    assert source(graph, guider["inputs"]["positive"])[1] == "CLIPTextEncode"
    assert source(graph, guider["inputs"]["negative"])[1] == "ConditioningZeroOut"

    sampler = only(graph, "SamplerCustomAdvanced")
    assert source(graph, sampler["inputs"]["guider"])[1] == "DualModelGuider"
    assert source(graph, sampler["inputs"]["sigmas"])[1] == "Ideogram4Scheduler"
    assert source(graph, sampler["inputs"]["noise"])[1] == "RandomNoise"
    assert source(graph, sampler["inputs"]["sampler"])[1] == "KSamplerSelect"
    assert source(graph, sampler["inputs"]["latent_image"])[1] == "EmptyFlux2LatentImage"
    assert only(graph, "KSamplerSelect")["inputs"] == {"sampler_name": "euler"}
    assert only(graph, "RandomNoise")["inputs"] == {"noise_seed": 42}

    latent = only(graph, "EmptyFlux2LatentImage")
    assert latent["inputs"] == {"width": 2048, "height": 1152, "batch_size": 1}
    decode = only(graph, "VAEDecode")
    assert source(graph, decode["inputs"]["samples"])[1] == "SamplerCustomAdvanced"
    assert source(graph, graph[output]["inputs"]["images"])[1] == "VAEDecode"


def test_ideogram4_class_counts():
    graph, _, _ = build_graph(IDEO, {"prompt": "x", "size": "1024x1024"})
    assert sorted(n["class_type"] for n in graph.values()) == sorted([
        "VAELoader", "CLIPLoader", "UNETLoader", "UNETLoader", "CLIPTextEncode",
        "ConditioningZeroOut", "EmptyFlux2LatentImage", "RandomNoise",
        "KSamplerSelect", "Ideogram4Scheduler", "DualModelGuider",
        "SamplerCustomAdvanced", "VAEDecode", "SaveImage",
    ])


@pytest.mark.parametrize("preset,expected", [
    ("Quality", (48, 0.0, 1.5)),
    ("Default", (20, 0.0, 1.75)),
    ("Turbo", (12, 0.5, 1.75)),
])
def test_ideogram4_preset_table(preset, expected):
    graph, _, _ = build_graph(IDEO, {"prompt": "x", "size": "1024x1024", "preset": preset})
    scheduler = only(graph, "Ideogram4Scheduler")
    assert (scheduler["inputs"]["steps"], scheduler["inputs"]["mu"],
            scheduler["inputs"]["std"]) == expected


def test_ideogram4_defaults_to_default_preset():
    graph, _, _ = build_graph(IDEO, {"prompt": "x", "size": "1024x1024"})
    assert only(graph, "Ideogram4Scheduler")["inputs"]["steps"] == 20


def test_ideogram4_explicit_scheduler_values_override_preset():
    graph, _, _ = build_graph(
        IDEO, {"prompt": "x", "size": "1024x1024", "preset": "Turbo",
               "steps": 30, "mu": 0.25, "std": 2.0}
    )
    scheduler = only(graph, "Ideogram4Scheduler")["inputs"]
    assert (scheduler["steps"], scheduler["mu"], scheduler["std"]) == (30, 0.25, 2.0)


@pytest.mark.parametrize("payload,match", [
    ({"preset": "Ultra"}, "preset"),
    ({"steps": 0}, "steps"),
    ({"steps": 201}, "steps"),
    ({"mu": 11}, "mu"),
    ({"std": 0.05}, "std"),
    ({"size": "4096x4096"}, None),
    ({"width": 4096, "height": 4096}, None),
    ({"width": 1020, "height": 1024}, None),
    ({"width": 128, "height": 1024}, None),
])
def test_ideogram4_rejects_out_of_range_parameters(payload, match):
    with pytest.raises(ValueError) as err:
        build_graph(IDEO, {"prompt": "x", "size": "1024x1024", **payload})
    assert match is None or match in str(err.value)


def test_ideogram4_rejects_negative_prompt_field():
    # Asymmetric CFG uses a second network, not a negative prompt string, so the
    # field cannot be honoured and is refused rather than ignored.
    with pytest.raises(ValueError, match="negative_prompt"):
        build_graph(IDEO, {"prompt": "x", "negative_prompt": "no text"})


def test_ideogram4_wraps_plain_prompt_as_json_caption():
    graph, _, _ = build_graph(IDEO, {"prompt": "editorial poster", "size": "2048x1152"})
    caption = json.loads(only(graph, "CLIPTextEncode")["inputs"]["text"])
    assert caption == {"aspect_ratio": "16:9", "high_level_description": "editorial poster"}


@pytest.mark.parametrize("size,ratio", [
    ("1024x1024", "1:1"),
    ("2048x1152", "16:9"),
    ("1024x1536", "2:3"),
])
def test_ideogram4_caption_aspect_ratio_follows_geometry(size, ratio):
    graph, _, _ = build_graph(IDEO, {"prompt": "a lighthouse", "size": size})
    caption = json.loads(only(graph, "CLIPTextEncode")["inputs"]["text"])
    assert caption["aspect_ratio"] == ratio
    assert caption["high_level_description"] == "a lighthouse"


def test_ideogram4_structured_caption_passes_through_unchanged():
    structured = json.dumps({
        "aspect_ratio": "1:1",
        "high_level_description": "given",
        "compositional_deconstruction": {"background": "b", "elements": []},
    })
    graph, _, _ = build_graph(IDEO, {"prompt": structured, "size": "1024x1024"})
    assert only(graph, "CLIPTextEncode")["inputs"]["text"] == structured


def test_ideogram4_non_caption_json_is_wrapped():
    graph, _, _ = build_graph(IDEO, {"prompt": '{"note": "not a caption"}', "size": "1024x1024"})
    caption = json.loads(only(graph, "CLIPTextEncode")["inputs"]["text"])
    assert caption["high_level_description"] == '{"note": "not a caption"}'


def test_ideogram4_accepts_2k_geometry_the_shared_rule_would_refuse():
    # A 1536+ side and >2 MP are legal here even though image_geometry refuses
    # them, because this model is natively 2K. 2048x2048 would exceed the 4 MP
    # ceiling, so 2048x1152 is the widest legal shape.
    graph, _, _ = build_graph(IDEO, {"prompt": "x", "size": "2048x1152"})
    assert only(graph, "EmptyFlux2LatentImage")["inputs"]["width"] == 2048
    assert only(graph, "Ideogram4Scheduler")["inputs"]["height"] == 1152


def test_ideogram4_rejects_uploaded_reference_image():
    with pytest.raises(ValueError, match="image"):
        build_graph(IDEO, {"prompt": "x"}, image_filename="lloom-1.png")


# ------------------------------------------------------------------------- YuE2


def test_yue2_wiring_without_planning():
    graph, output, kind = build_graph(
        YUE, {"instructions": "warm indie pop", "lyrics": "[Verse]\nhi", "duration": 120}
    )
    assert kind == "audio"
    assert graph[output]["class_type"] == "SaveAudio"

    ckpt_id = node_id(graph, "CheckpointLoaderSimple")
    assert graph[ckpt_id]["inputs"] == {"ckpt_name": "yue2_3b_int8_convrot.safetensors"}

    music = only(graph, "YuE2GenerateMusic")
    assert music["inputs"] == {
        "clip": [ckpt_id, 1], "style": "warm indie pop", "lyrics": "[Verse]\nhi",
        "abc": "", "seed": 42, "mode": "full", "max_duration": 120,
        "temperature": 1.0, "top_p": 0.95, "top_k": 100, "repetition_penalty": 1.2,
    }
    assert not nodes_of(graph, "YuE2GenerateABC")

    zero = only(graph, "ConditioningZeroOut")
    assert source(graph, zero["inputs"]["conditioning"]) == (node_id(graph, "YuE2GenerateMusic"),
                                                             "YuE2GenerateMusic")
    latent = only(graph, "EmptyYuE2LatentAudio")
    assert latent["inputs"] == {"seconds": [node_id(graph, "YuE2GenerateMusic"), 1], "batch_size": 1}

    sampler = only(graph, "KSampler")
    assert sampler["inputs"]["sampler_name"] == "dpm_2"
    assert sampler["inputs"]["scheduler"] == "sgm_uniform"
    assert sampler["inputs"]["steps"] == 32
    assert sampler["inputs"]["cfg"] == 1.0
    assert sampler["inputs"]["denoise"] == 1.0
    assert sampler["inputs"]["model"] == [ckpt_id, 0]
    assert source(graph, sampler["inputs"]["positive"]) == (node_id(graph, "YuE2GenerateMusic"),
                                                            "YuE2GenerateMusic")
    assert source(graph, sampler["inputs"]["negative"])[1] == "ConditioningZeroOut"
    assert source(graph, sampler["inputs"]["latent_image"])[1] == "EmptyYuE2LatentAudio"

    decode = only(graph, "VAEDecodeAudio")
    assert decode["inputs"]["vae"] == [ckpt_id, 2]
    assert source(graph, decode["inputs"]["samples"])[1] == "KSampler"


def test_yue2_class_counts_without_planning():
    graph, _, _ = build_graph(YUE, {"prompt": "x"})
    assert sorted(n["class_type"] for n in graph.values()) == sorted([
        "CheckpointLoaderSimple", "YuE2GenerateMusic", "ConditioningZeroOut",
        "EmptyYuE2LatentAudio", "KSampler", "VAEDecodeAudio", "SaveAudio",
    ])


def test_yue2_abc_planning_links_generator_into_music():
    graph, _, _ = build_graph(YUE, {"prompt": "x", "abc_planning": True, "mode": "melody"})
    abc_node = only(graph, "YuE2GenerateABC")
    assert abc_node["inputs"]["max_abc_tokens"] == 8192
    assert abc_node["inputs"]["temperature"] == 0.7
    assert abc_node["inputs"]["top_p"] == 0.9
    assert abc_node["inputs"]["top_k"] == 30
    assert abc_node["inputs"]["repetition_penalty"] == 1.005
    assert abc_node["inputs"]["penalty_window"] == 100
    assert abc_node["inputs"]["mode"] == "melody"

    music = only(graph, "YuE2GenerateMusic")
    assert source(graph, music["inputs"]["abc"])[1] == "YuE2GenerateABC"
    assert music["inputs"]["mode"] == "melody"


def test_yue2_caller_supplied_abc_skips_generator():
    score = "X:1\nK:C\nCDEF|"
    graph, _, _ = build_graph(YUE, {"prompt": "x", "abc": score, "abc_planning": True})
    assert graph[node_id(graph, "YuE2GenerateMusic")]["inputs"]["abc"] == score
    assert not nodes_of(graph, "YuE2GenerateABC")


def test_yue2_steps_and_cfg_override():
    graph, _, _ = build_graph(YUE, {"prompt": "x", "steps": 8, "cfg": 4.0})
    sampler = only(graph, "KSampler")
    assert sampler["inputs"]["steps"] == 8
    assert sampler["inputs"]["cfg"] == 4.0


def test_yue2_duration_defaults_to_120_and_accepts_alias():
    graph, _, _ = build_graph(YUE, {"prompt": "x"})
    assert only(graph, "YuE2GenerateMusic")["inputs"]["max_duration"] == 120

    graph, _, _ = build_graph(YUE, {"prompt": "x", "max_duration": 200})
    assert only(graph, "YuE2GenerateMusic")["inputs"]["max_duration"] == 200

    graph, _, _ = build_graph(YUE, {"prompt": "x", "duration": 60, "max_duration": 60})
    assert only(graph, "YuE2GenerateMusic")["inputs"]["max_duration"] == 60


def test_yue2_style_falls_back_to_prompt():
    graph, _, _ = build_graph(YUE, {"prompt": "dreamy synthwave"})
    assert only(graph, "YuE2GenerateMusic")["inputs"]["style"] == "dreamy synthwave"


@pytest.mark.parametrize("payload,match", [
    ({"duration": 400}, "duration"),
    ({"duration": 10}, "duration"),
    ({"max_duration": 5}, "duration"),
    ({"duration": 60, "max_duration": 90}, "agree"),
    ({"mode": "chorus"}, "mode"),
    ({"steps": 4}, "steps"),
    ({"steps": 65}, "steps"),
    ({"cfg": 5.0}, "cfg"),
    ({"abc_planning": "yes"}, "abc_planning"),
])
def test_yue2_rejections(payload, match):
    with pytest.raises(ValueError, match=match):
        build_graph(YUE, {"prompt": "x", **payload})


@pytest.mark.parametrize("model", ["MiniMaxAI/MiniMax-Music3", "ACE-Step/ACE-Step-1.5-XL-SFT"])
def test_other_music_models_keep_their_own_duration_range(model):
    # The per-family table must not move ACE/Music3's existing bounds.
    graph, _, kind = build_graph(model, {"prompt": "x"})
    assert kind == "audio"
    assert graph[node_id(graph, "SaveAudio")]["class_type"] == "SaveAudio"
    with pytest.raises(ValueError):
        build_graph(model, {"prompt": "x", "duration": 400})


# -------------------------------------------------------------------- registry


def test_new_models_are_registered_with_the_right_kind_and_family():
    from graphs import MODELS

    assert MODELS[KREA] == {"kind": "image", "family": "krea2"}
    assert MODELS[IDEO] == {"kind": "image", "family": "ideogram4"}
    assert MODELS[YUE] == {"kind": "audio", "family": "yue2"}
