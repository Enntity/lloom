"""Map recipe downloads to ComfyUI folders, including models installed later."""
import json
import os
from pathlib import Path

CATEGORIES = ('checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'loras',
              'latent_upscale_models', 'audio_encoders', 'clip_vision', 'controlnet', 'embeddings')


def discover_roots(models_root, skip=()):
    roots = []
    if not os.path.isdir(models_root):
        return roots
    for name in sorted(os.listdir(models_root)):
        if name in skip or name.endswith('.incomplete'):
            continue
        for suffix in ('', 'split_files'):
            relative = os.path.join(name, suffix) if suffix else name
            path = os.path.join(models_root, relative)
            categories = [c for c in CATEGORIES if os.path.isdir(os.path.join(path, c))]
            if categories:
                roots.append((relative, path, categories))
    return roots


def render_yaml(roots, container_prefix=None):
    lines = ['# Generated ComfyUI model paths.']
    for index, (name, path, categories) in enumerate(roots):
        if container_prefix and (path == container_prefix[0] or path.startswith(container_prefix[0] + os.sep)):
            path = container_prefix[1] + path[len(container_prefix[0]):]
        lines += [f'lloom_{index}:', '  base_path: ' + json.dumps(path)]
        mapping = categories if isinstance(categories, dict) else {c: c for c in categories}
        lines += ['  ' + category + ': ' + json.dumps(relative) for category, relative in mapping.items()]
    return '\n'.join(lines) + '\n'


def write_extra_model_paths(models_root, destination, container_prefix=None, manifest=None):
    roots = discover_roots(models_root)
    # Register all bundled recipe destinations even before their files exist.
    # ComfyUI invalidates its file cache when a registered path appears/changes.
    if manifest:
        known = json.loads(Path(manifest).read_text())
        by_path = {entry[1]: entry for entry in roots}
        for relative, categories in known.items():
            path = os.path.join(models_root, relative)
            by_path[path] = (relative, path, categories)
        roots = list(by_path.values())
    if roots:
        Path(destination).write_text(render_yaml(roots, container_prefix))
    return roots
