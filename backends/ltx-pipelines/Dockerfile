FROM ubuntu@sha256:b3cc40b72b93588182b5410f723c7aaf142363311c2aa993d8a453ddcbb3ae15
ENV DEBIAN_FRONTEND=noninteractive PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates ffmpeg libsndfile1 libgl1 libglib2.0-0 git build-essential && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/bootstrap && /opt/bootstrap/bin/pip install uv==0.12.19
RUN git init /opt/LTX-2 && git -C /opt/LTX-2 remote add origin https://github.com/Lightricks/LTX-2.git && git -C /opt/LTX-2 fetch --depth 1 origin 598ab41247a77dbfe29b5186e915bcf4f9040ec7 && git -C /opt/LTX-2 checkout --detach FETCH_HEAD && rm -rf /opt/LTX-2/.git
COPY upstream-uv.lock /opt/LTX-2/uv.lock
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy
RUN cd /opt/LTX-2 && /opt/bootstrap/bin/uv sync --frozen --no-dev --package ltx-pipelines
RUN apt-get update && apt-get install -y --no-install-recommends python3-dev && rm -rf /var/lib/apt/lists/*
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.txt /opt/lloom-ltx/requirements.txt
RUN /opt/bootstrap/bin/uv pip install --python /opt/venv/bin/python -r /opt/lloom-ltx/requirements.txt && /opt/bootstrap/bin/uv pip freeze --python /opt/venv/bin/python > /opt/package-lock.txt
COPY pipelines.py server.py a2v.py UPSTREAM-LICENSE LICENSE-2_x /opt/lloom-ltx/
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONPATH=/opt/lloom-ltx
WORKDIR /opt/lloom-ltx
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
