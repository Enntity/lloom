import pytest
from graphs import build_graph

H3 = "MiniMaxAI/MiniMax-H3"
LTX = "Lightricks/LTX-2.5"


@pytest.mark.parametrize("model,count,cls,field", [
    (H3, 141, "MiniMaxH3ImageToVideo", "length"),
    (LTX, 145, "EmptyLTXVLatentVideo", "length"),
])
def test_explicit_frame_count_is_used(model, count, cls, field):
    graph, _, _ = build_graph(model, {"prompt": "A calm lake", "num_frames": count})
    assert next(n for n in graph.values() if n["class_type"] == cls)["inputs"][field] == count


@pytest.mark.parametrize("model,payload", [
    (H3, {"num_frames": 125}),
    (LTX, {"num_frames": 122}),
    (H3, {"duration": 5, "num_frames": 141}),
    (H3, {"width": 1344, "height": 1344}),
    (H3, {"duration": float("nan")}),
    (LTX, {"width": 1280, "height": 720}),
    (H3, {"graph": {}}),
    (H3, {"n": 2}),
])
def test_unsafe_or_conflicting_requests_rejected(model, payload):
    with pytest.raises(ValueError):
        build_graph(model, {"prompt": "A calm lake", **payload})


def test_image_filename_cannot_select_arbitrary_path():
    with pytest.raises(ValueError):
        build_graph(H3, {"prompt": "A calm lake"}, image_filename="../../private.png")


def test_music_rejects_unhandled_image():
    with pytest.raises(ValueError):
        build_graph("MiniMaxAI/MiniMax-Music3", {"input": "[Instrumental]", "image": "data:image/png;base64,aA=="})
