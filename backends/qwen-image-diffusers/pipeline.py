"""The pinned official pipeline, with an explicit FP32 VAE boundary.

Quality contract: BF16 transformer/text encoder and the original FP32 VAE are
retained. KV cache stays enabled. Attention backend defaults to the existing
SDPA path; ``LLOOM_QWEN_ATTENTION=flex`` opts into the QwenImage21 flex
attention processor plus ``torch.compile`` on the transformer. Unknown modes are
rejected at construction; there is no silent compile/attention fallback.
"""
import io
import os
import time

MODEL_ID = "Qwen/Qwen-Image-2.1"
GATEWAY_ID = MODEL_ID + "-Diffusers"
MODEL_REVISION = "b3179ad355be050328e483a9dfdd9e60cd62adfa"
DIFFUSERS_REVISION = "80c7ed262aeffbeb43ef13ae04baeb9b84515a69"

ATTENTION_ENV = "LLOOM_QWEN_ATTENTION"
ATTENTION_MODES = ("sdpa", "flex")


class GenerationCancelled(Exception):
    pass


def attention_mode(environ=None):
    """Resolve the opt-in attention mode; reject unknown values."""
    environ = os.environ if environ is None else environ
    mode = environ.get(ATTENTION_ENV, "sdpa")
    if not isinstance(mode, str):
        raise RuntimeError(f"{ATTENTION_ENV} must be one of {', '.join(ATTENTION_MODES)}")
    mode = mode.strip().lower()
    if mode not in ATTENTION_MODES:
        raise RuntimeError(
            f"Unsupported {ATTENTION_ENV}={mode!r}; expected one of {', '.join(ATTENTION_MODES)}"
        )
    return mode


class Runner:
    def __init__(self, model_path):
        import torch
        from diffusers import AutoencoderKLQwenImage21, QwenImage21Pipeline

        class MixedVaePipeline(QwenImage21Pipeline):
            def _encode_vae_image(self, image, generator):
                # Upstream prepares reference pixels in the encoder's dtype.
                # Run the original VAE in FP32, then return BF16 conditioning.
                return super()._encode_vae_image(image.to(self.vae.dtype), generator).to(image.dtype)

        self.torch = torch
        self.attention_mode = attention_mode()
        start = time.monotonic()
        vae = AutoencoderKLQwenImage21.from_pretrained(
            model_path, subfolder="vae", dtype=torch.float32, local_files_only=True
        )
        self.pipe = MixedVaePipeline.from_pretrained(
            model_path, vae=vae, dtype=torch.bfloat16, local_files_only=True
        ).to("cuda")
        assert self.pipe.vae.dtype == torch.float32
        assert self.pipe.transformer.dtype == torch.bfloat16
        assert self.pipe.text_encoder.dtype == torch.bfloat16
        if self.attention_mode == "flex":
            self._enable_flex_attention()
        torch.cuda.synchronize()
        print(
            f"Qwen Diffusers ready; model load {time.monotonic() - start:.2f}s; "
            f"BF16 transformer/encoder, FP32 VAE, attention={self.attention_mode}",
            flush=True,
        )

    def _enable_flex_attention(self):
        from diffusers.models.transformers.transformer_qwenimage21 import QwenImage21FlexAttnProcessor
        self.pipe.transformer.set_attn_processor(QwenImage21FlexAttnProcessor())
        # Compile is part of the opt-in flex mode only. Any failure propagates:
        # there is no silent fallback to eager/SDPA.
        self.pipe.transformer = self.torch.compile(self.pipe.transformer)

    def generate(self, params, image, cancel):
        def check_cancel(*args):
            if cancel.is_set():
                raise GenerationCancelled()
            return args[-1] if args else None

        check_cancel()
        # Text-to-image reuses this exact pipeline: the official pipeline accepts
        # image=None for no-reference generation, so no second process, weight
        # copy, or second Runner is created for generation requests. The request
        # resolution is passed through unchanged.
        result = self.pipe(
            prompt=params["prompt"], image=image, width=params["width"], height=params["height"],
            output_resolution=params["resolution"], num_inference_steps=params["steps"],
            true_cfg_scale=1.0, use_kv_cache=True,
            generator=self.torch.Generator("cuda").manual_seed(params["seed"]),
            callback_on_step_end=check_cancel,
        ).images[0]
        check_cancel()
        output = io.BytesIO()
        result.save(output, format="PNG")
        return output.getvalue()
