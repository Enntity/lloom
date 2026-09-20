"""The pinned official pipeline, with an explicit FP32 VAE boundary."""
import io
import time

MODEL_ID = "Qwen/Qwen-Image-2.1"
GATEWAY_ID = MODEL_ID + "-Diffusers"
MODEL_REVISION = "b3179ad355be050328e483a9dfdd9e60cd62adfa"
DIFFUSERS_REVISION = "80c7ed262aeffbeb43ef13ae04baeb9b84515a69"


class GenerationCancelled(Exception):
    pass


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
        torch.cuda.synchronize()
        print(f"Qwen Diffusers ready; model load {time.monotonic() - start:.2f}s; BF16 transformer/encoder, FP32 VAE", flush=True)

    def generate(self, params, image, cancel):
        def check_cancel(*args):
            if cancel.is_set():
                raise GenerationCancelled()
            return args[-1] if args else None

        check_cancel()
        # Text-to-image reuses this exact pipeline: the official pipeline accepts
        # image=None for no-reference generation, so no second process, weight
        # copy, or second Runner is created for generation requests.
        result = self.pipe(
            prompt=params["prompt"], image=image, width=params["width"], height=params["height"],
            output_resolution=1024, num_inference_steps=params["steps"], true_cfg_scale=1.0,
            use_kv_cache=True, generator=self.torch.Generator("cuda").manual_seed(params["seed"]),
            callback_on_step_end=check_cancel,
        ).images[0]
        check_cancel()
        output = io.BytesIO()
        result.save(output, format="PNG")
        return output.getvalue()
