#!/usr/bin/env python3
"""Opt-in warm worker for the native LTX-2.5 backend (``LLOOM_LTX_WARM=1``).

``python -m warm_worker ltx_pipelines.distilled`` builds one upstream
``DistilledPipeline`` on its first request and then serves renders until stdin
closes or ``server.py`` kills its process group (idle release, timeout,
cancel, failure).

Protocol: one JSON object per stdin line, ``{"argv": [...]}``, holding exactly
the CLI flags ``pipelines.build_argv`` emits after the module name. Each
request is parsed by that module's own upstream parser and rendered with the
same calls and the same ``encode_video`` its ``main()`` makes, so the MP4 is
the one the per-request subprocess would write. One reply line per request goes
to the original stdout: ``{"ok": true, ...}`` or ``{"ok": false, "error"}``.
Everything else (logging, stray prints) goes to stderr. Any failure is
reported and the worker exits, so the next request starts from a clean build.

Upstream blocks build each model per call and dispose it on exit. The worker
keeps them resident by memoizing each block's build hook and making that
model's ``dispose`` a no-op; Distilled uses one transformer for both stages, so
nothing is rebuilt after the first request.

Two-stage Full pipelines are deliberately not served: their stage 2 fuses the
distilled LoRA into a second 22B copy, so pinning both stages plus Gemma needs
~110 GB. Pinning only Gemma and the VAEs was measured on GB10 and was slower
than a fresh process (4 s Full shot: 315-363 s against 301 s), most likely
because the resident encoder leaves too little page cache for the 44 GB dev
checkpoint that each stage rebuilds from.

Nothing here imports torch at module scope, so ``server.py`` can read
``WARM_MODULES`` without the CUDA stack.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from types import SimpleNamespace

# Modules the worker can serve. Every other workflow and any offloading request
# use the per-request subprocess.
WARM_MODULES = frozenset({"ltx_pipelines.distilled"})

# Flags that select weights or how they are built. A worker serves one value of
# each for its whole life; the server keys workers so this always holds.
BUILD_FLAGS = (
    "--transformer-path", "--text-encoder-path", "--video-vae-path", "--audio-vae-path",
    "--spatial-upsampler-path", "--quantization", "--offload",
)


def build_key(argv):
    return [(flag, argv[argv.index(flag) + 1] if flag in argv else None) for flag in BUILD_FLAGS]


def _noop():
    pass


def _memo(build):
    """Build once per dtype and keep the model: ``gpu_model`` exit becomes a no-op."""
    models = {}

    def resident(*args, **kwargs):
        key = str(kwargs.get("dtype"))
        if key not in models:
            model = build(*args, **kwargs)
            model.dispose = _noop  # instance attribute shadows Disposable.dispose
            models[key] = model
        return models[key]

    return resident


def _resident_builder(builder):
    return SimpleNamespace(build=_memo(builder.build))


def pin(pipeline):
    """Keep every block of a ``DistilledPipeline`` resident."""
    encoder = pipeline.prompt_encoder
    encoder._build_text_encoder = _memo(encoder._build_text_encoder)
    encoder._build_embeddings_processor = _memo(encoder._build_embeddings_processor)
    pipeline.image_conditioner._build_encoder = _memo(pipeline.image_conditioner._build_encoder)
    upsampler = pipeline.upsampler
    upsampler._encoder_builder = _resident_builder(upsampler._encoder_builder)
    upsampler._upsampler_builder = _resident_builder(upsampler._upsampler_builder)
    decoder = pipeline.video_decoder
    prepare_decoder = decoder._prepared_builder
    resident_decoder = SimpleNamespace(build=_memo(lambda **kwargs: prepare_decoder().build(**kwargs)))
    decoder._prepared_builder = lambda: resident_decoder
    audio = pipeline.audio_decoder
    audio._decoder_builder = _resident_builder(audio._decoder_builder)
    audio._vocoder_builder = _resident_builder(audio._vocoder_builder)
    pipeline.stage._build_transformer = _memo(pipeline.stage._build_transformer)
    return pipeline


class Worker:
    """Serves ``ltx_pipelines.distilled`` renders exactly as its ``main()`` does."""

    def __init__(self):
        import torch

        self.torch = torch
        self.pipeline = None
        self.key = None
        # A fresh CLI process starts from torch's default global seed; restore
        # it before every render so no global-RNG consumer sees advanced state.
        self.initial_seed = torch.initial_seed()

    def render(self, argv):
        from ltx_core.model.video_vae import AUTO_TILING, get_video_chunks_number
        from ltx_pipelines.chunks import pipeline_output_from_chunks, split_decoded_chunks
        from ltx_pipelines.distilled import DistilledPipeline
        from ltx_pipelines.utils.args import (
            add_chunk_layout_args,
            add_generated_keyframes_arg,
            add_keyframe_decode_arg,
            chunk_config_from_args,
            default_2_stage_distilled_arg_parser,
            resolve_cli_params,
        )
        from ltx_pipelines.utils.media_io import encode_video, resolve_hdr_color_space, vae_dtype_for_hdr

        torch = self.torch
        # resolve_cli_params reads the checkpoint named in sys.argv.
        sys.argv = ["ltx_pipelines.distilled", *argv]
        params = resolve_cli_params(distilled=True)
        args = add_chunk_layout_args(add_keyframe_decode_arg(add_generated_keyframes_arg(
            default_2_stage_distilled_arg_parser(params=params, supports_auto_duration=True)))).parse_args(argv)
        built = False
        if self.pipeline is None:
            self.key = build_key(argv)
            self.pipeline = pin(DistilledPipeline(
                model_paths=args.model_paths,
                spatial_upsampler_path=args.spatial_upsampler_path,
                loras=tuple(args.lora) if args.lora else (),
                quantization=args.quantization,
                compilation_config=args.compile,
                offload_mode=args.offload_mode,
                prompt_enhancer_gemma_root=args.prompt_enhancer_gemma_root,
                diffvae_optimization=args.diffvae_optimization,
            ))
            built = True
        elif build_key(argv) != self.key:
            raise RuntimeError("request needs different weights than this worker holds")
        torch.manual_seed(self.initial_seed)

        hdr = resolve_hdr_color_space(images=args.images, hdr=args.hdr)
        chunk_config = chunk_config_from_args(args)
        chunks, num_frames, tiling_config = self.pipeline.stream_chunks(
            prompt=args.prompt,
            seed=args.seed,
            height=args.height,
            width=args.width,
            num_frames=args.num_frames,
            frame_rate=args.frame_rate,
            images=args.images,
            vae_dtype=vae_dtype_for_hdr(hdr, torch.bfloat16),
            color_space=hdr,
            enhance_prompt=args.enhance_prompt,
            enhance_static_cache=args.enhance_static_cache,
            tiling_config=AUTO_TILING,
            generated_keyframes=args.num_generated_keyframes,
            decode_with_keyframes=args.decode_with_keyframes,
            chunk_config=chunk_config,
        )
        if chunk_config is not None:
            video, audio, audio_sampling_rate = split_decoded_chunks(chunks)
            video_chunks_number = 1
        else:
            result = pipeline_output_from_chunks(chunks, num_frames=num_frames, tiling_config=tiling_config)
            video, audio, audio_sampling_rate = result.video, result.audio, None
            video_chunks_number = get_video_chunks_number(result.num_frames, result.tiling_config)
        encode_video(
            video=video,
            fps=args.frame_rate,
            audio=audio,
            output_path=args.output_path,
            video_chunks_number=video_chunks_number,
            color_space=hdr,
            audio_sampling_rate=audio_sampling_rate,
        )
        return built


def main():
    module = sys.argv[1]
    if module not in WARM_MODULES:
        raise SystemExit(f"warm_worker does not serve {module}")
    # Keep the reply channel private: stray prints from libraries land in stderr.
    replies = os.fdopen(os.dup(1), "w", buffering=1)
    os.dup2(2, 1)
    logging.basicConfig(level=logging.INFO)
    import torch

    worker = Worker()
    for line in sys.stdin:
        started = time.monotonic()
        try:
            with torch.inference_mode():
                built = worker.render(json.loads(line)["argv"])
        except BaseException as exc:  # noqa: BLE001 - report, then exit for a clean rebuild
            logging.exception("warm render failed")
            replies.write(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"[:2000]}) + "\n")
            raise SystemExit(1) from None
        seconds = round(time.monotonic() - started, 3)
        logging.info("warm render done in %.1fs (built=%s)", seconds, built)
        replies.write(json.dumps({"ok": True, "built": built, "seconds": seconds}) + "\n")


if __name__ == "__main__":
    main()
