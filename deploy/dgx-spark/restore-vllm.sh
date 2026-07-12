#!/usr/bin/env bash
set -euo pipefail

backup="${1:-$HOME/.lloom/backups/latest}"
backup="$(cd "$backup" && pwd -P)"
cd "$backup"

test -f vllm-image.tar.zst
test -f vllm-caches.tar.zst
sha256sum --check VLLM-SHA256SUMS

if docker container inspect qwen36-unsloth >/dev/null 2>&1; then
  echo "Refusing to replace existing qwen36-unsloth container." >&2
  echo "This restore is only for recovery after that container has been removed." >&2
  exit 2
fi

zstd -dc vllm-image.tar.zst | docker load
tar --zstd -xpf vllm-caches.tar.zst -C "$HOME"

docker run -d \
  --name qwen36-unsloth \
  --restart unless-stopped \
  --gpus all \
  --ipc host \
  --security-opt label=disable \
  -p 192.168.1.131:8000:8000 \
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
  -v "$HOME/.cache/vllm:/root/.cache/vllm" \
  vllm/vllm-openai@sha256:251eba5cc7c12fed0b75da22a9240e582b1c9e39f6fbc064f86781b963bd814f \
  unsloth/Qwen3.6-35B-A3B-NVFP4 \
  --host 0.0.0.0 \
  --port 8000 \
  --tensor-parallel-size 1 \
  --trust-remote-code \
  --dtype bfloat16 \
  --kv-cache-dtype fp8 \
  --attention-backend flashinfer \
  --gpu-memory-utilization 0.4 \
  --max-model-len 262144 \
  --max-num-seqs 4 \
  --max-num-batched-tokens 8192 \
  --enable-chunked-prefill \
  --async-scheduling \
  --enable-prefix-caching \
  --load-format fastsafetensors \
  --reasoning-parser qwen3 \
  --tool-call-parser qwen3_xml \
  --enable-auto-tool-choice

echo "qwen36-unsloth recreated. Follow startup with: docker logs -f qwen36-unsloth"
