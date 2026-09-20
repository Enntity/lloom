FROM ubuntu@sha256:b3cc40b72b93588182b5410f723c7aaf142363311c2aa993d8a453ddcbb3ae15
ENV DEBIAN_FRONTEND=noninteractive PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates ffmpeg libsndfile1 libgl1 libglib2.0-0 git build-essential && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
RUN pip install pip==26.0.1 wheel==0.46.3 setuptools==82.0.0
RUN pip install --index-url https://download.pytorch.org/whl/cu130 torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0
RUN git init /opt/ComfyUI && git -C /opt/ComfyUI remote add origin https://github.com/Comfy-Org/ComfyUI.git && git -C /opt/ComfyUI fetch --depth 1 origin 5ba116a40f1944f64e2e4a8ace826656e6293bf4 && git -C /opt/ComfyUI checkout --detach FETCH_HEAD
COPY requirements.txt /opt/lloom-media/requirements.txt
COPY build/verify_dependencies.py /opt/lloom-media/build/verify_dependencies.py
RUN pip install -r /opt/ComfyUI/requirements.txt -r /opt/lloom-media/requirements.txt && python /opt/lloom-media/build/verify_dependencies.py && pip freeze > /opt/package-lock.txt
COPY bridge /opt/lloom-media/bridge
COPY graphs /opt/lloom-media/graphs
COPY build /opt/lloom-media/build
COPY model-roots.json /opt/lloom-media/model-roots.json
RUN PYTHONPATH=/opt/ComfyUI:/opt/lloom-media/graphs python /opt/lloom-media/build/verify_qwen_inputs.py --cpu
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONPATH=/opt/lloom-media/graphs
WORKDIR /opt/lloom-media
ENTRYPOINT ["python", "/opt/lloom-media/build/launch.py"]
