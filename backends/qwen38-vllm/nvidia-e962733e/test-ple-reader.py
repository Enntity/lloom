"""CPU semantic check of exact FP8 bytes across uneven safetensors shards."""
import importlib.util
import json
import struct
import tempfile
from pathlib import Path

import torch

spec = importlib.util.spec_from_file_location("ple_mmap", Path(__file__).parent / "overlays/ple_mmap.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    rows = torch.arange(35, dtype=torch.uint8).reshape(7, 5)
    weight_map = {}
    for i, shard in enumerate((rows[:4], rows[4:])):
        name = f"model.layers.0.ple.ngram_embedding.shard_{i}.weight"
        filename = f"part-{i}.safetensors"
        raw = shard.numpy().tobytes()
        header = json.dumps({name: {"dtype": "F8_E4M3", "shape": list(shard.shape), "data_offsets": [0, len(raw)]}}).encode()
        (root / filename).write_bytes(struct.pack("<Q", len(header)) + header + raw)
        weight_map[name] = filename
    (root / "model.safetensors.index.json").write_text(json.dumps({"weight_map": weight_map}))
    table = module.PLEMmapTable(directory, 0, threads=4)
    ids = torch.tensor([6, 0, 4, 3, 3, 1, 5, 2, 0, 6, 4])
    for _ in range(3):
        actual = table.gather(ids).view(torch.uint8)
        assert torch.equal(actual, rows[ids]), "gather changed checkpoint FP8 bytes"
    assert table.gather(torch.tensor([], dtype=torch.int64)).shape == (0, 5)
    table._pool.shutdown()
    for fd in table._fds.values():
        module.os.close(fd)
print("PLE original-byte, shard-boundary, duplicate, repeated and empty-row checks passed")
