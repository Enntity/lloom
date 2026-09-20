FROM ubuntu@sha256:b3cc40b72b93588182b5410f723c7aaf142363311c2aa993d8a453ddcbb3ae15
ENV DEBIAN_FRONTEND=noninteractive PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates ffmpeg libsndfile1 libgl1 libglib2.0-0 git build-essential && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
RUN pip install pip==26.0.1 wheel==0.46.3 setuptools==82.0.0
RUN pip install --index-url https://download.pytorch.org/whl/cu130 torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0
COPY requirements.txt /opt/lloom-qwen/requirements.txt
RUN pip install -r /opt/lloom-qwen/requirements.txt && pip freeze > /opt/package-lock.txt
COPY server.py pipeline.py /opt/lloom-qwen/
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
WORKDIR /opt/lloom-qwen
ENTRYPOINT ["python", "server.py"]
