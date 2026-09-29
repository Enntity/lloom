# Pinned LLooM local CUDA audio adapter image.
#
# The base is the NGC PyTorch container pinned by digest; it already ships the
# CUDA-matched ``torch``/``torchaudio`` builds, so this Dockerfile NEVER installs
# or upgrades torch -- the parent build handles that.
#
#   docker build -t lloom-audio-cuda .
#
# Runtime (single model per process):
#   docker run --gpus all -p 8220:8220 \
#     -v /models/Qwen3-TTS-12Hz-0.6B-CustomVoice:/models/tts:ro \
#     lloom-audio-cuda \
#     --kind tts --model Qwen3-TTS-12Hz-0.6B-CustomVoice --model-path /models/tts \
#     --host 0.0.0.0 --port 8220

FROM nvcr.io/nvidia/pytorch@sha256:bbc2b67e2533edd63ff1496bb1ed00a00338cdc1478af6c1a0bf9f4b369977e7

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# ffmpeg decodes uploaded audio for Whisper; sox + libsndfile cover the
# reference-audio decode path (soundfile) and general audio tooling.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        sox \
        libsndfile1 \
        libsndfile1-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Pinned Python runtime dependencies.  ``qwen-tts`` is installed --no-deps so it
# cannot drag in a clashing torch/transformers build; the versions it depends on
# are pinned explicitly right below.  torch / torchaudio stay as shipped by NGC.
RUN python -m pip install --no-cache-dir --no-deps "qwen-tts==0.1.1" \
    && python -m pip install --no-cache-dir \
        "transformers==4.57.3" \
        "accelerate==1.12.0" \
        "huggingface-hub==0.36.2" \
        "openai-whisper==20250625" \
        "fastapi==0.141.1" \
        "uvicorn==0.53.0" \
        "python-multipart==0.0.32"

# Optional CUDA graph engine, pinned and installed without changing torch.
RUN python -m pip install --no-cache-dir --no-deps "faster-qwen3-tts==0.2.6"

WORKDIR /opt/lloom-audio
COPY lloom_audio_cuda_server.py /opt/lloom-audio/lloom_audio_cuda_server.py

EXPOSE 8220

# Local-only by default; override --host/--port at ``docker run`` time.
ENTRYPOINT ["python", "/opt/lloom-audio/lloom_audio_cuda_server.py"]
CMD ["--help"]
