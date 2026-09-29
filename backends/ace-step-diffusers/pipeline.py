"""ACE-Step 1.5 through the pinned official diffusers pipeline.

Why this backend exists
-----------------------
ComfyUI drives ACE-Step base/SFT with a plain ``KSampler`` CFG, but those
checkpoints are trained for APG (adaptive projected guidance). Comfy-Org tracks
this as ComfyUI#12322: with CFG > ~2.5 the output "becomes garbled and
compressed"; only the turbo checkpoint (guidance distilled into the weights)
survives the vanilla-CFG path. The bundled ComfyUI blueprint consequently ships
turbo only.

``AceStepPipeline`` implements the guidance these checkpoints expect
(``normalized_guidance`` from ``diffusers.guiders.adaptive_projected_guidance``),
auto-detects turbo and coerces its guidance to 1.0, and exposes the musical
parameters ComfyUI had hard-coded: ``bpm``, ``keyscale`` and ``timesignature``
default to ``None``, meaning the model infers them from the prompt instead of
being pinned to 100 BPM / C major.
"""
import io
import time


class GenerationCancelled(Exception):
    pass


class Runner:
    """Loads one ACE-Step checkpoint and renders requests for it."""

    def __init__(self, model_path, model_id):
        import torch
        from diffusers import AceStepPipeline

        self.torch = torch
        self.model_id = model_id
        start = time.monotonic()
        self.pipe = AceStepPipeline.from_pretrained(
            model_path, dtype=torch.bfloat16, local_files_only=True
        ).to("cuda")
        self.sample_rate = int(getattr(self.pipe, "sample_rate", 48000))
        # The checkpoint config declares guidance-distilled turbo weights; the
        # pipeline reads this to skip CFG and coerce guidance_scale to 1.0.
        self.is_turbo = bool(getattr(self.pipe, "is_turbo", False))
        torch.cuda.synchronize()
        print(
            f"ACE-Step ready; model load {time.monotonic() - start:.2f}s; "
            f"id={model_id} turbo={self.is_turbo} sample_rate={self.sample_rate}",
            flush=True,
        )

    def generate(self, params, cancel):
        import numpy as np
        import soundfile as sf

        def check_cancel(pipe, step_idx, timestep, kwargs):
            if cancel.is_set():
                raise GenerationCancelled()
            return kwargs

        check_cancel(None, 0, 0, None)
        result = self.pipe(
            prompt=params["prompt"],
            lyrics=params["lyrics"],
            audio_duration=params["duration"],
            vocal_language=params["language"],
            num_inference_steps=params["steps"],
            guidance_scale=params["guidance_scale"],
            shift=params["shift"],
            # None means "infer from the prompt" rather than pinning a value.
            bpm=params["bpm"],
            keyscale=params["keyscale"],
            timesignature=params["timesignature"],
            generator=self.torch.Generator("cuda").manual_seed(params["seed"]),
            output_type="np",
            callback_on_step_end=check_cancel,
        )
        check_cancel(None, 0, 0, None)
        audio = result.audios[0]
        audio = np.asarray(audio, dtype=np.float32)
        # The pipeline yields (channels, samples); soundfile wants (samples, channels).
        if audio.ndim == 2 and audio.shape[0] <= 2 and audio.shape[1] > audio.shape[0]:
            audio = audio.T
        if audio.ndim == 1:
            audio = audio[:, None]
        if not np.isfinite(audio).all():
            audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)
        # Generated music arrives well below full scale, so normalise to a
        # predictable peak instead of shipping whatever amplitude the model
        # happened to emit. Peak only; no dynamics processing.
        peak = float(np.abs(audio).max())
        if peak > 0:
            audio = audio * (10 ** (-1.0 / 20) / peak)
        output = io.BytesIO()
        sf.write(output, audio, self.sample_rate, format="WAV", subtype="PCM_16")
        return output.getvalue()
