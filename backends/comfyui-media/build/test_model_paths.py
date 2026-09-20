"""Tests for the generated ComfyUI extra model roots."""

import os

import model_paths


def make_root(base, name, categories, files=()):
    for category in categories:
        os.makedirs(os.path.join(base, name, category), exist_ok=True)
    for relative in files:
        target = os.path.join(base, name, relative)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w") as handle:
            handle.write("weights")
    return os.path.join(base, name)


def test_discovers_usable_roots_only(tmp_path):
    models = str(tmp_path)
    make_root(models, "Comfy-Org--Krea-2", ["diffusion_models", "text_encoders"])
    make_root(models, "empty-dir", [])
    make_root(models, "not-a-model", ["unrelated"])
    roots = model_paths.discover_roots(models)
    assert [name for name, _, _ in roots] == ["Comfy-Org--Krea-2"]
    assert roots[0][2] == ["diffusion_models", "text_encoders"]


def test_default_and_incomplete_roots_are_skipped(tmp_path):
    models = str(tmp_path)
    make_root(models, "omitted-root", ["diffusion_models"])
    make_root(models, "Comfy-Org--YuE2.incomplete", ["checkpoints"])
    make_root(models, "Comfy-Org--YuE2", ["checkpoints"])
    assert [name for name, _, _ in model_paths.discover_roots(models, skip=("omitted-root",))] == ["Comfy-Org--YuE2"]


def test_yaml_maps_host_paths_into_the_container(tmp_path):
    models = str(tmp_path)
    make_root(models, "Comfy-Org--YuE2", ["checkpoints"],
              files=["checkpoints/yue2_3b_int8_convrot.safetensors"])
    roots = model_paths.discover_roots(models)
    body = model_paths.render_yaml(roots, container_prefix=(models, "/opt/lloom-models"))
    assert 'base_path: "/opt/lloom-models/Comfy-Org--YuE2"' in body
    assert '  checkpoints: "checkpoints"' in body
    assert models not in body


def test_write_is_a_no_op_without_roots(tmp_path):
    destination = os.path.join(str(tmp_path), "extra.yaml")
    assert model_paths.write_extra_model_paths(os.path.join(str(tmp_path), "missing"), destination) == []
    assert not os.path.exists(destination)


def test_write_produces_one_entry_per_root(tmp_path):
    models = str(tmp_path)
    make_root(models, "Comfy-Org--Krea-2", ["diffusion_models"])
    make_root(models, "Comfy-Org--Qwen3-VL", ["text_encoders"])
    destination = os.path.join(str(tmp_path), "extra.yaml")
    roots = model_paths.write_extra_model_paths(models, destination)
    body = open(destination).read()
    assert len(roots) == 2
    assert body.count("base_path:") == 2
    assert "lloom_0:" in body
    assert "lloom_1:" in body


def test_split_files_and_future_roots(tmp_path):
    import json
    import yaml
    make_root(str(tmp_path), 'org--nested/split_files', ['vae'])
    roots = model_paths.discover_roots(str(tmp_path))
    assert roots[0][0] == 'org--nested/split_files'
    manifest = tmp_path / 'roots.json'
    manifest.write_text(json.dumps({'org--future': {'loras': '.'}, 'org--nested/split_files': {'vae': 'vae'}}))
    target = tmp_path / 'paths.yaml'
    model_paths.write_extra_model_paths(str(tmp_path), target, manifest=manifest)
    entries = list(yaml.safe_load(target.read_text()).values())
    assert any(e['base_path'].endswith('org--future') and e['loras'] == '.' for e in entries)
    # YAML punctuation in a user-selected model root remains literal.
    parsed = yaml.safe_load(model_paths.render_yaml([('x', '/tmp/models: # hi', ['vae'])]))
    assert parsed['lloom_0']['base_path'] == '/tmp/models: # hi'
