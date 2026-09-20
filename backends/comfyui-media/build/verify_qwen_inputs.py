"""CPU-only contract check inside the pinned ComfyUI image.

Run with PYTHONPATH including ComfyUI and LLooM graphs, and pass --cpu.
Uses the real execution resolver; no checkpoint or GPU is loaded.
"""
from types import SimpleNamespace

import comfy.options
comfy.options.enable_args_parsing()
import execution
from comfy_api.latest import _io
from comfy_extras.nodes_qwen import TextEncodeQwenImage21
from graphs import build_graph


def verify():
    graph, _, _ = build_graph("Qwen/Qwen-Image-2.1", {"prompt": "make the door green"},
                              image_filename="reference.png")
    node_id, node = next((key, value) for key, value in graph.items()
                         if value["class_type"] == "TextEncodeQwenImage21")
    reference = object()

    class Cache:
        def get_cache(self, upstream, downstream):
            assert downstream == node_id
            value = reference if graph[upstream]["class_type"] == "LoadImage" else object()
            return SimpleNamespace(outputs=[[value]])

    def resolve(inputs):
        data, missing, v3 = execution.get_input_data(inputs, TextEncodeQwenImage21, node_id, Cache())
        assert not missing, missing
        return _io.build_nested_inputs({key: values[0] for key, values in data.items()}, v3)

    delivered = resolve(node["inputs"])
    assert delivered["images"]["image_1"] is reference, "Reference lost before node execution"
    # Demonstrate why schema-only/nesting tests missed the original defect.
    broken = dict(node["inputs"])
    broken["images"] = {"image_1": broken.pop("images.image_1")}
    assert resolve(broken)["images"] == {}
    print("Qwen 2.1 execution input contract passed: resolved reference reaches images.image_1")


if __name__ == "__main__":
    verify()
