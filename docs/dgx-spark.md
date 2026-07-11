# DGX Spark / GB10 and LLooM

LLooM is designed as a **multi-backend gateway**: Apple Silicon runs MTPLX/MLX; NVIDIA boxes (including **DGX Spark / GB10**) run **vLLM** and/or **SGLang** (and can still attach llama.cpp). Clients always talk to one OpenAI/Anthropic-compatible endpoint; LLooM starts, warms, and swaps runtimes.

## Popular backends on Spark (2026 community)

| Backend | Role on Spark | When to pick |
|---------|----------------|--------------|
| **vLLM** | Default high-throughput CUDA server | Concurrent agents, multi-GPU / multi-Spark TP, broad model support, official NVIDIA playbooks |
| **SGLang** | Agent / prefix-heavy loops | Shared long prefixes, tool loops, structured gen; often slightly ahead on RadixAttention/MTP |
| **llama.cpp** | Simple GGUF / low-overhead | Fast single-stream decode; weaker multi-request batching than vLLM/SGLang |
| **Ollama** | Easiest first boot | Fine for demos; Spark users usually graduate to vLLM/SGLang for real work |

Community orchestration notes (Spark forums / sparkrun / spark-vllm-docker) converge on **vLLM as the default**, **SGLang as the agent specialist**, both behind an OpenAI-compatible port — which is exactly LLooM’s model.

## What LLooM already does

- **Machine profile**: `nvidia-smi` → CUDA devices; tags `cuda`, `nvidia-gpu`, and (when applicable) `blackwell` / `dgx-spark` / `gb10`.
- **Backend catalog**: install/link paths for `vllm` and `sglang` (`linux-x64` + `linux-arm64`).
- **Runtime manager**: multi-runtime ports (`8201+`), keep-warm, concurrency slots, memory admission, `ensureRuntime` on request.
- **Recipes** (seed community):
  - `linux-nvidia-qwen36-27b-nvfp4-vllm` — dense NVFP4 + MTP-style flags (Spark-oriented)
  - `linux-nvidia-qwen36-35b-a3b-fp8-vllm` — MoE agent default lane
  - `linux-nvidia-qwen36-27b-sglang` — SGLang agent/prefix lane
- **Generic OpenAI attach**: run Docker yourself and register  
  `lloom add-model 'openai:http://127.0.0.1:8000/v1#model-id'`

## Install reality on GB10 (important)

Generic `pip install vllm` / `pip install sglang` often **fails or is suboptimal** on Spark (ARM64 Grace + Blackwell sm_121). Prefer:

1. **NVIDIA / community Docker** (most reliable day-1 path)  
   - e.g. `vllm/vllm-openai:cu130-nightly`, NGC Spark vLLM guides, `eugr/spark-vllm-docker`, `scitrera/dgx-spark-sglang`
2. **Prebuilt Spark wheels** exposed as a binary
3. Point LLooM at that binary:
   ```bash
   export LLOOM_VLLM_BIN=/path/to/vllm
   export LLOOM_SGLANG_PYTHON=/path/to/python   # can import sglang
   lloom backend-install vllm
   lloom backend-install sglang
   ```

If the server is already running in Docker, register it as a Docker runtime. Use
`management: "external"` to adopt and monitor a container without allowing LLooM
to stop it, or `management: "managed"` when LLooM should own `docker start/stop`:

```bash
lloom add-model 'openai:http://127.0.0.1:8000/v1#Qwen/Qwen3.6-35B-A3B'
# then set defaults.chatModel / keepWarm as needed
```

```json
{
  "runtimes": {
    "qwen": {
      "adapter": "docker",
      "management": "external",
      "containerName": "qwen-vllm",
      "healthUrl": "http://127.0.0.1:8000/v1/models",
      "port": 8000
    }
  }
}
```

LLooM still provides the single client URL, auth, multi-model catalog, container
state, and—when management is `managed`—native Docker process lifecycle.

## Multi-backend management pattern

Typical Spark layout:

| Port | Runtime | Backend | Use |
|------|---------|---------|-----|
| 8100 | LLooM gateway | — | All clients |
| 8201 | Chat keep-warm | **vLLM** 35B-A3B | Default agents / OMP |
| 8202 | Optional second chat | **SGLang** 27B or alt | A/B, dense quality |
| 8220 | TTS (optional) | OpenAI-compatible | Voice |

- Only one huge chat model **resident** at a time unless memory admits both.
- `keepWarm: ["vllm-…"]` for the daily driver; second runtime `enabled: true` for on-demand start.
- Clients pick models by **id**; gateway routes to the right backend/runtime.

## Recommended first-run on a new Spark

```bash
# On the Spark (linux-arm64, ~128 GB unified)
lloom up --offline   # or online host once packs are published
# Prefer CUDA recommendation (vLLM Qwen lane)

# After a working vllm is on PATH or LLOOM_VLLM_BIN:
lloom backend-install vllm
lloom recipe-import community/recipes/linux-nvidia-qwen36-35b-a3b-fp8-vllm.json
lloom serve

# Optional agent/prefix specialist:
lloom backend-install sglang
lloom recipe-import community/recipes/linux-nvidia-qwen36-27b-sglang.json
```

Tune recipe flags from local benches:

- `--gpu-memory-utilization` / `--mem-fraction-static` (0.80–0.90)
- `--max-num-seqs` (2–4 on solo Spark)
- `--max-model-len` (131k–262k depending on weight quant + KV)
- `--load-format fastsafetensors` (vLLM) for much faster load
- Qwen: `--reasoning-parser qwen3` + tool-call parser for OpenCode/OMP

## Dual / multi-Spark

LLooM process management is **single-host** today. For two Sparks:

1. Run **vLLM/SGLang with TP or Ray** on the cluster (one OpenAI URL), **or**
2. Run one engine per box and put a load balancer in front, then register **one** OpenAI backend in LLooM.

Recipe seeds are **solo Spark** unless you extend args with `--tensor-parallel-size 2` and multi-node env.

## Checklist before you unbox

- [ ] LLooM builds on `linux-arm64` Node
- [ ] Working vLLM **or** SGLang OpenAI server on localhost
- [ ] `LLOOM_VLLM_BIN` / `LLOOM_SGLANG_PYTHON` if not using generic pip
- [ ] Import at least one CUDA recipe (vLLM 35B-A3B and/or 27B NVFP4)
- [ ] Optional: second backend as alternate model id for A/B
- [ ] Client integrate (OMP / enntity-local) → `http://127.0.0.1:8100/v1`

## See also

- `docs/backends.md` — backend install surface  
- `community/recipes/linux-nvidia-*.json` — Spark-oriented seeds  
- `community/benchmarks/linux-nvidia-qwen36-vllm.json` — seed evidence  
