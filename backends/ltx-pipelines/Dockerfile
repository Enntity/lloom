FROM ubuntu@sha256:b3cc40b72b93588182b5410f723c7aaf142363311c2aa993d8a453ddcbb3ae15 AS base
ENV DEBIAN_FRONTEND=noninteractive PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates ffmpeg libsndfile1 libgl1 libglib2.0-0 git build-essential && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/bootstrap && /opt/bootstrap/bin/pip install uv==0.12.19
RUN git init /opt/LTX-2 && git -C /opt/LTX-2 remote add origin https://github.com/Lightricks/LTX-2.git && git -C /opt/LTX-2 fetch --depth 1 origin 9ec55f9f22798a3198d9c923856824821bc3317e && git -C /opt/LTX-2 checkout --detach FETCH_HEAD && rm -rf /opt/LTX-2/.git
COPY upstream-uv.lock /opt/LTX-2/uv.lock
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy
RUN cd /opt/LTX-2 && /opt/bootstrap/bin/uv sync --frozen --no-dev --package ltx-pipelines
RUN apt-get update && apt-get install -y --no-install-recommends python3-dev && rm -rf /var/lib/apt/lists/*
ENV PATH=/opt/venv/bin:$PATH

# ltx-kernels (NVFP4 quantize + cuBLASLt block-scaled FP4 GEMM) is a CUDA build that
# upstream leaves out of the lock. It is compiled here, against the image's own torch,
# with a CUDA 13.2 toolkit that never reaches the final image; patch_ltx_kernels.py adds
# the GB10's sm_121a target, which upstream's arch list lacks.
FROM base AS kernels
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    curl -fsSL -o /tmp/cuda-keyring.deb https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/sbsa/cuda-keyring_1.1-1_all.deb && \
    dpkg -i /tmp/cuda-keyring.deb && apt-get update && \
    apt-get install -y --no-install-recommends cuda-toolkit-13-2 && rm -rf /var/lib/apt/lists/*
COPY patch_ltx_kernels.py /tmp/patch_ltx_kernels.py
RUN python3 /tmp/patch_ltx_kernels.py /opt/LTX-2/packages/ltx-kernels/setup.py
RUN /opt/bootstrap/bin/uv pip install --python /opt/venv/bin/python setuptools==80.9.0 wheel==0.45.1 ninja==1.13.0
ENV CUDA_HOME=/usr/local/cuda-13.2 TORCH_CUDA_ARCH_LIST=12.1a MAX_JOBS=4
RUN cd /opt/LTX-2/packages/ltx-kernels && /opt/bootstrap/bin/uv build --wheel --no-build-isolation --python /opt/venv/bin/python -o /wheels .

FROM base
COPY --from=kernels /wheels /wheels
# --no-deps: torch and triton already come from the lock; the CuTe DSL dependency is
# only for the datacenter-Blackwell VAE kernels, which do not apply to sm_121.
RUN /opt/bootstrap/bin/uv pip install --python /opt/venv/bin/python --no-deps /wheels/*.whl && rm -rf /wheels
COPY requirements.txt /opt/lloom-ltx/requirements.txt
RUN /opt/bootstrap/bin/uv pip install --python /opt/venv/bin/python -r /opt/lloom-ltx/requirements.txt && /opt/bootstrap/bin/uv pip freeze --python /opt/venv/bin/python > /opt/package-lock.txt
COPY pipelines.py server.py a2v.py warm_worker.py UPSTREAM-LICENSE LICENSE-2_x /opt/lloom-ltx/
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONPATH=/opt/lloom-ltx
WORKDIR /opt/lloom-ltx
EXPOSE 8000
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
