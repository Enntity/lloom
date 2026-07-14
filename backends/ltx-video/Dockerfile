FROM nvcr.io/nvidia/pytorch:26.02-py3

ARG LTX_REF=main
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git curl \
    && rm -rf /var/lib/apt/lists/* \
    && git clone --depth 1 --branch "${LTX_REF}" https://github.com/Lightricks/LTX-2.git /opt/LTX-2 \
    && pip install --no-cache-dir -e /opt/LTX-2/packages/ltx-core -e /opt/LTX-2/packages/ltx-pipelines \
    && pip install --no-cache-dir --force-reinstall --no-deps torch==2.11.0 torchaudio==2.11.0

COPY lloom_ltx_video_server.py /opt/lloom/lloom_ltx_video_server.py
ENV PYTHONUNBUFFERED=1
ENV PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
EXPOSE 8000
ENTRYPOINT ["python3", "/opt/lloom/lloom_ltx_video_server.py"]
