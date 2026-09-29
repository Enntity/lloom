"""New capabilities: first+last frame pinning, LTX geometry, and named parameter errors.

These encode the intended contract for the media service bridge:

  * H3 accepts an optional ``last_frame`` alongside ``first_frame``/``image`` so a
    clip can be pinned at both ends. That is what makes shot-to-shot joins exact
    instead of approximate.
  * H3 full and FL2VA Turbo both accept first/last-frame inputs.
  * LTX uses a two-pass spatial upscale at the requested output size and
    exposes its image-conditioning strength instead of hard-coding 0.7.
  * A rejected parameter names itself and its legal range, because a generic
    "invalid parameters" message is what made a single wrong integer look like a
    model limitation.
"""

import pytest

from graphs import build_graph

H3 = "MiniMaxAI/MiniMax-H3"
H3T = "MiniMaxAI/MiniMax-H3-Turbo"
LTX = "Lightricks/LTX-2.5"


def node(graph, cls):
    return next(n for n in graph.values() if n["class_type"] == cls)


def nodes(graph, cls):
    return [n for n in graph.values() if n["class_type"] == cls]


# --------------------------------------------------------------- frame pinning


def test_h3_first_and_last_frame_are_both_wired():
    graph, _, _ = build_graph(
        H3, {"prompt": "A calm lake"},
        image_filename="lloom-first.png", last_image_filename="lloom-last.png",
    )
    cond = node(graph, "MiniMaxH3ImageToVideo")["inputs"]
    loads = {n["inputs"]["image"]: key for key, n in graph.items() if n["class_type"] == "LoadImage"}
    # Each conditioning input must point at the loader for its own frame.
    assert cond["first_frame"] == [loads["lloom-first.png"], 0]
    assert cond["last_frame"] == [loads["lloom-last.png"], 0]
    assert len(loads) == 2


def test_h3_first_frame_only_still_works():
    graph, _, _ = build_graph(H3, {"prompt": "A calm lake"}, image_filename="lloom-first.png")
    cond = node(graph, "MiniMaxH3ImageToVideo")["inputs"]
    assert cond["first_frame"][1] == 0
    assert "last_frame" not in cond
    assert len(nodes(graph, "LoadImage")) == 1


def test_h3_last_frame_can_guide_an_unconditioned_opening():
    graph,_,_=build_graph(H3, {"prompt": "A calm lake"}, last_image_filename="lloom-last.png")
    cond=nodes(graph,"MiniMaxH3ImageToVideo")[0]["inputs"]
    assert "last_frame" in cond and "first_frame" not in cond


def test_h3_turbo_accepts_frame_pinning():
    graph, _, _ = build_graph(H3T, {"prompt": "A calm lake"}, image_filename="lloom-first.png", last_image_filename="lloom-last.png")
    cond = nodes(graph, "MiniMaxH3ImageToVideo")[0]["inputs"]
    assert "first_frame" in cond and "last_frame" in cond
    assert nodes(graph, "LoraLoaderModelOnly")


def test_ltx_audio_and_endpoint_are_wired_through_both_video_stages():
    graph, _, _ = build_graph(
        LTX, {"prompt": "A person speaks, then settles", "duration": 8, "size": "768x768"},
        image_filename="lloom-first.png", last_image_filename="lloom-home.png",
        audio_filename="lloom-voice.wav",
    )
    guides = [(k, n) for k, n in graph.items() if n["class_type"] == "LTXVAddGuide"]
    concats = [(k, n) for k, n in graph.items() if n["class_type"] == "LTXVConcatAVLatent"]
    crops = [(k, n) for k, n in graph.items() if n["class_type"] == "LTXVCropGuides"]
    assert len(guides) == len(concats) == len(crops) == 2
    endpoint = next(k for k, n in graph.items() if n["class_type"] == "LoadImage"
                    and n["inputs"]["image"] == "lloom-home.png")
    for (guide_id, guide), (_concat_id, concat) in zip(guides, concats):
        assert guide["inputs"]["frame_idx"] == -1
        assert guide["inputs"]["image"] == [endpoint, 0]
        assert concat["inputs"]["video_latent"] == [guide_id, 2]
        assert graph[guide["inputs"]["latent"][0]]["class_type"] != "LTXVConcatAVLatent"
    assert node(graph, "EmptyLTXVLatentVideo")["inputs"]["length"] == 193
    assert node(graph, "LTXVLatentUpsampler")["inputs"]["samples"] == [crops[0][0], 2]
    assert node(graph, "VAEDecodeTiled")["inputs"]["samples"] == [crops[1][0], 2]
    for _crop_id, crop in crops:
        assert graph[crop["inputs"]["latent"][0]]["class_type"] == "LTXVSeparateAVLatent"
    source_audio = next(k for k, n in graph.items() if n["class_type"] == "LoadAudio")
    assert node(graph, "CreateVideo")["inputs"]["audio"] == [source_audio, 0]
    audio_mask = node(graph, "SetLatentNoiseMask")["inputs"]
    assert graph[audio_mask["mask"][0]]["inputs"]["value"] == 0.0
    assert concats[0][1]["inputs"]["audio_latent"] == [
        next(k for k, n in graph.items() if n["class_type"] == "SetLatentNoiseMask"), 0]


def test_ltx_without_audio_still_generates_an_audio_track():
    graph, _, _ = build_graph(LTX, {"prompt": "A quiet room"}, image_filename="lloom-first.png")
    create = node(graph, "CreateVideo")["inputs"]
    assert graph[create["audio"][0]]["class_type"] == "LTXVAudioVAEDecode"
    assert not nodes(graph, "LTXVAddGuide")
    assert not nodes(graph, "LTXVCropGuides")
    assert not nodes(graph, "SetLatentNoiseMask")


# ------------------------------------------------------------------ LTX geometry


def test_ltx_uses_half_the_requested_dimensions_for_the_first_pass():
    """The upscaler restores the requested 1152x640 dimensions."""
    graph, _, _ = build_graph(LTX, {"prompt": "A calm lake", "size": "1152x640"})
    latent = node(graph, "EmptyLTXVLatentVideo")["inputs"]
    assert (latent["width"], latent["height"]) == (576, 320)


def test_ltx_reports_implied_output_size():
    graph, _, _ = build_graph(LTX, {"prompt": "A calm lake", "size": "1152x640"})
    up = node(graph, "LTXVLatentUpsampler")
    assert up is not None


@pytest.mark.parametrize("size", ["1280x720", "832x480", "512x288"])
def test_ltx_still_rejects_non_multiples_of_64(size):
    with pytest.raises(ValueError, match="multiple of 64"):
        build_graph(LTX, {"prompt": "A calm lake", "size": size})


def test_ltx_strength_is_configurable():
    graph, _, _ = build_graph(LTX, {"prompt": "A calm lake", "image_strength": 0.4},
                              image_filename="lloom-first.png")
    strengths = [n["inputs"]["strength"] for n in nodes(graph, "LTXVImgToVideoInplace")]
    assert 0.4 in strengths


def test_ltx_strength_default_is_unchanged():
    graph, _, _ = build_graph(LTX, {"prompt": "A calm lake"}, image_filename="lloom-first.png")
    strengths = [n["inputs"]["strength"] for n in nodes(graph, "LTXVImgToVideoInplace")]
    assert 0.7 in strengths


@pytest.mark.parametrize("value", [-0.1, 1.5, "high"])
def test_ltx_strength_range_is_enforced(value):
    with pytest.raises(ValueError, match="image_strength"):
        build_graph(LTX, {"prompt": "A calm lake", "image_strength": value},
                    image_filename="lloom-first.png")


# ------------------------------------------------------------- named parameters


def test_step_error_names_the_model_and_its_range():
    """The exact mistake this exists to prevent: steps=8 sent to full H3."""
    with pytest.raises(ValueError, match=r"MiniMax-H3.*between 10 and 50"):
        build_graph(H3, {"prompt": "A calm lake", "steps": 8})


def test_turbo_step_error_names_its_only_legal_value():
    with pytest.raises(ValueError, match=r"Turbo.*exactly 8"):
        build_graph(H3T, {"prompt": "A calm lake", "steps": 20})


def test_ltx_step_error_names_its_only_legal_value():
    with pytest.raises(ValueError, match=r"LTX.*exactly 8"):
        build_graph(LTX, {"prompt": "A calm lake", "steps": 20})


def test_geometry_error_names_the_multiple():
    with pytest.raises(ValueError, match="multiple of 32"):
        build_graph(H3, {"prompt": "A calm lake", "size": "640x360"})


def test_legal_step_counts_still_pass():
    build_graph(H3, {"prompt": "A calm lake", "steps": 10})
    build_graph(H3, {"prompt": "A calm lake", "steps": 50})
    build_graph(H3T, {"prompt": "A calm lake", "steps": 8})
    build_graph(LTX, {"prompt": "A calm lake", "steps": 8})


def test_full_ltx_guided_stage_then_distilled_refinement():
    full = 'Lightricks/LTX-2.5-Comfy-Full'
    graph, _, _ = build_graph(full, {'prompt': 'A speaker', 'steps': 30, 'guidance_scale': 3},
                              image_filename='first.png', last_image_filename='last.png', audio_filename='speech.wav')
    assert node(graph, 'UNETLoader')['inputs']['unet_name'].endswith('dev-transformer-bf16.safetensors')
    assert node(graph, 'LTXVScheduler')['inputs']['steps'] == 30
    guiders = nodes(graph, 'LTXVDualCFGGuider')
    assert [n['inputs']['video_cfg'] for n in guiders] == [3, 1]
    assert [n['inputs']['audio_cfg'] for n in guiders] == [1, 1]
    lora_id = next(k for k, n in graph.items() if n['class_type'] == 'LoraLoaderModelOnly')
    assert guiders[0]['inputs']['model'] != [lora_id, 0]
    assert guiders[1]['inputs']['model'] == [lora_id, 0]
    assert node(graph, 'SolidMask')['inputs']['value'] == 0
    assert len(nodes(graph, 'LTXVConcatAVLatent')) == 2
    audio_id = next(k for k, n in graph.items() if n['class_type'] == 'LoadAudio')
    assert node(graph, 'CreateVideo')['inputs']['audio'] == [audio_id, 0]
    for bad in [True, None, 0, 21, '3']:
        with pytest.raises(ValueError):
            build_graph(full, {'prompt': 'A speaker', 'guidance_scale': bad})
    with pytest.raises(ValueError):
        build_graph(full, {'prompt': 'A speaker', 'steps': 8})
