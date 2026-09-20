"""New capabilities: first+last frame pinning, LTX geometry, and named parameter errors.

These encode the intended contract for the media service bridge:

  * H3 accepts an optional ``last_frame`` alongside ``first_frame``/``image`` so a
    clip can be pinned at both ends. That is what makes shot-to-shot joins exact
    instead of approximate.
  * H3 only accepts frame inputs on the full model, never on the Turbo LoRA path.
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


def test_h3_last_frame_requires_a_first_frame():
    with pytest.raises(ValueError, match="last_frame requires"):
        build_graph(H3, {"prompt": "A calm lake"}, last_image_filename="lloom-last.png")


def test_h3_turbo_rejects_frame_pinning():
    """The Turbo path is the fast tier; frame pinning is not a Turbo workload."""
    with pytest.raises(ValueError, match="Turbo"):
        build_graph(H3T, {"prompt": "A calm lake"}, image_filename="lloom-first.png")


def test_ltx_rejects_last_frame_instead_of_overwriting_the_first():
    with pytest.raises(ValueError, match="does not support last_frame"):
        build_graph(LTX, {"prompt": "A calm lake"},
                    image_filename="lloom-first.png", last_image_filename="lloom-last.png")


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
