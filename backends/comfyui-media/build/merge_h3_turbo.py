"""Merge lightx2v's MiniMax-H3 Turbo LoRA into the pruned FL2VA weights as MXFP8.

Runs inside the comfyui-media image (it needs comfy-kitchen's CUDA kernels).
ComfyUI disables its quantized matmul for any layer with a runtime LoRA patch,
so the stock Turbo graph dequantized every int8 ConvRot weight to bf16 and
re-applied the rank-384 delta on each step. Merging once in fp32 and
requantizing to MXFP8 (E4M3 data, power-of-two scale per 32 values) lets the
whole model run on GB10's block-scaled FP8 tensor cores instead.

Usage: merge_h3_turbo.py BASE LORA OUT
"""
import json
import sys
import time

sys.path.insert(0, "/opt/ComfyUI")
argv, sys.argv = sys.argv[1:], sys.argv[:1]  # comfy.cli_args parses sys.argv on import

import torch  # noqa: E402
import comfy_kitchen as ck  # noqa: E402
from comfy.quant_ops import TensorCoreMXFP8Layout, TensorWiseINT8Layout  # noqa: E402
from safetensors import safe_open  # noqa: E402
from safetensors.torch import save_file  # noqa: E402

BASE_FORMAT = {"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": 256}
MXFP8_CONF = torch.tensor(list(json.dumps({"format": "mxfp8"}).encode()), dtype=torch.uint8)


def dequantize(q, scale):
    params = TensorWiseINT8Layout.Params(scale=scale, orig_dtype=torch.float32, orig_shape=tuple(q.shape),
                                         convrot=True, convrot_groupsize=BASE_FORMAT["convrot_groupsize"])
    return TensorWiseINT8Layout.dequantize(q, params).float()


def check_dequantize(q, scale, weight):
    """The decoded weight must reproduce the int8 kernel's own output; ~1% is its
    per-row activation rounding, a wrong un-rotation would be ~100%."""
    x = torch.randn(256, q.shape[1], device=q.device, dtype=torch.bfloat16)
    ref = ck.int8_linear(x, q, scale, convrot=True).float()
    error = ((ref - torch.nn.functional.linear(x.float(), weight)).norm() / ref.norm()).item()
    if error > 0.03:
        raise SystemExit(f"int8 ConvRot dequantization does not match the kernel (relative error {error:.3f})")


def main(base_path, lora_path, out_path):
    torch.manual_seed(0)
    with safe_open(lora_path, "pt") as f:
        lora = {k: f.get_tensor(k) for k in f.keys()}
    targets = {k[len("diffusion_model."):-len(".lora_A.weight")] for k in lora if k.endswith(".lora_A.weight")}
    out, merged, started = {}, 0, time.time()
    with safe_open(base_path, "pt") as f:
        keys = list(f.keys())
        quantized = {k[:-len(".comfy_quant")] for k in keys if k.endswith(".comfy_quant")}
        for key in keys:
            module, _, leaf = key.rpartition(".")
            if module in quantized and leaf != "weight":
                continue  # comfy_quant and weight_scale are rebuilt with the weight
            if leaf != "weight" or module not in targets:
                out[key] = f.get_tensor(key)
                continue
            if module in quantized:
                conf = json.loads(bytes(f.get_tensor(module + ".comfy_quant").tolist()))
                if conf != BASE_FORMAT:
                    raise SystemExit(f"{module}: unexpected base quantization {conf}")
                q = f.get_tensor(key).cuda()
                scale = f.get_tensor(module + ".weight_scale").cuda()
                weight = dequantize(q, scale)
                if merged == 0:
                    check_dequantize(q, scale, weight)
            else:
                weight = f.get_tensor(key).cuda().float()
            prefix = "diffusion_model." + module
            a = lora[prefix + ".lora_A.weight"].cuda().float()
            b = lora[prefix + ".lora_B.weight"].cuda().float()
            weight += (lora[prefix + ".alpha"].item() / a.shape[0]) * (b @ a)
            merged += 1
            if module not in quantized:
                out[key] = weight.to(torch.bfloat16).cpu()  # the token refiner ships in bf16
                continue
            qdata, params = TensorCoreMXFP8Layout.quantize(weight.to(torch.bfloat16))
            for suffix, tensor in TensorCoreMXFP8Layout.state_dict_tensors(qdata, params).items():
                # safetensors has no E8M0 dtype; ComfyUI views the uint8 scales back.
                out[key + suffix] = (tensor.view(torch.uint8) if tensor.dtype == torch.float8_e8m0fnu else tensor).cpu()
            out[module + ".comfy_quant"] = MXFP8_CONF.clone()  # safetensors refuses shared storage
    if merged != len(targets):
        raise SystemExit(f"merged {merged} of {len(targets)} LoRA modules")
    save_file(out, out_path, metadata={"lloom": "MiniMax-H3 FL2VA pruned + lightx2v Turbo 8-step v1.0 LoRA, MXFP8"})
    print(f"merged {merged} modules into {out_path} in {time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    if len(argv) != 3:
        raise SystemExit(__doc__)
    main(*argv)
