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

When updating a local recipe while keeping an intentional cloud route, pass
`--preserve-routes` to `npm run deploy:spark -- ...`. The installer stages recipe
configuration, retains the leader's aliases (including ordering and suspended
members), defaults, routing and client catalog, then publishes it atomically.
Benchmark the explicit local model ID before changing the public alias.

- **Machine profile**: `nvidia-smi` → CUDA devices; tags `cuda`, `nvidia-gpu`, and (when applicable) `blackwell` / `dgx-spark` / `gb10`.
- **Backend catalog**: install/link paths for `vllm` and `sglang` (`linux-x64` + `linux-arm64`).
- **Runtime manager**: multi-runtime ports (`8201+`), keep-warm, concurrency slots, memory admission, `ensureRuntime` on request.
- **Recipes** (seed community):
  - `linux-nvidia-qwen36-27b-nvfp4-vllm` — dense NVFP4 + MTP-style flags (Spark-oriented)
  - `linux-nvidia-gb10-thinkingcap-qwen36-27b-vllm` — token-efficient ThinkingCap 27B NVFP4 candidate on released vLLM 0.25
  - `linux-nvidia-qwen36-35b-a3b-fp8-vllm` — MoE agent default lane
  - `linux-nvidia-qwen36-27b-sglang` — SGLang agent/prefix lane
- **Generic OpenAI attach**: run Docker yourself and register  
  `lloom add-model 'openai:http://127.0.0.1:8000/v1#model-id'`

## Install reality on GB10 (important)

### Checked-in official NVFP4 lanes

`deploy/dgx-spark/config.json` includes three managed, on-demand NVFP4 lanes sourced from their Hugging Face model cards:

| Gateway model ID | Source recipe | LLooM port | Notes |
|---|---|---:|---|
| `nvidia/Qwen3.6-35B-A3B-NVFP4` | [NVIDIA model card](https://huggingface.co/nvidia/Qwen3.6-35B-A3B-NVFP4) | 8003 | Uses NVIDIA's explicit DGX Spark flags, including Marlin MoE and MTP with Triton |
| `nvidia/Qwen3.6-27B-NVFP4` | [NVIDIA model card](https://huggingface.co/nvidia/Qwen3.6-27B-NVFP4) | 8004 | NVIDIA publishes a generic ModelOpt/vLLM command, not a separate Spark-tuned block |
| `unsloth/Qwen3.6-27B-NVFP4` | [Unsloth model card](https://huggingface.co/unsloth/Qwen3.6-27B-NVFP4) | 8005 | Uses released vLLM 0.25.0 with Unsloth's required Spark `CUTE_DSL_ARCH=sm_121a` and `flashinfer_b12x` guidance plus its MTP configuration. The runtime binds the verified Froggeric Qwen tool template after entity/system context and preserves requested thinking while tools are available. |
| `sakamakismile/ThinkingCap-Qwen3.6-27B-NVFP4` | [ThinkingCap NVFP4 model card](https://huggingface.co/sakamakismile/ThinkingCap-Qwen3.6-27B-NVFP4) | 8008 | Separate on-demand candidate derived from BottleCap AI's token-efficient reasoning fine-tune; uses released vLLM 0.25.0, FP8 KV cache, FlashInfer, and native MTP |

The Unsloth 27B and ThinkingCap candidate lanes are pinned to `vllm/vllm-openai:v0.25.0`; the two NVIDIA-source experimental lanes remain on nightly. These on-demand lanes share the host Hugging Face/vLLM caches and set `keepWarm: false`. Adding the config advertises the models but does not load them. The first request (or `lloom runtime-start <runtime-id>`) lets LLooM admit the runtime, pull the image/checkpoint when absent, create the container, and wait for its health endpoint. When flags or images change, archive the prior recipe and increment the active recipe version. ThinkingCap remains a candidate—not the default—until matched Spark throughput, reasoning-token efficiency, tool use, long-context, and vision checks are recorded as benchmark evidence.

After starting or changing a chat lane, use the synthetic canary before routing entity cognition to it. The canary sends no entity or continuity content, exercises representative prompt and tool-schema load, requires timely streamed content, and verifies the backend returns to idle:

```bash
node scripts/chat-lane-canary.mjs \
  --config ~/.lloom/config.json \
  --model unsloth/Qwen3.6-27B-NVFP4 \
  --backend-metrics-url http://10.20.30.10:8005/metrics
```

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
# then set defaults.chatModel and runtimes.<id>.keepWarm as needed
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

Managed Docker runtimes may also carry a materialized `bootstrap` block from a
recipe. If the named container is missing during request-time admission, LLooM
pulls the declared image, creates the container from `createArgs` and `command`,
then starts it and waits for the configured health check. Runtime status exposes
the originating recipe and whether cache persistence is supported.

vLLM model weights and compiled kernels persist through host cache mounts, but
vLLM does not currently expose a supported portable KV/session checkpoint hook.
LLooM therefore reports `cachePersistence.supported: false` for these Docker
runtimes. MTPLX SSD sessions and llama.cpp slot caches continue to report
continuous persistence and survive runtime eviction.

For unified-memory machines, set `runtimePolicy.maxMemoryUtilization` (for
example `0.9`). Admission samples live `MemAvailable`, adds the requested
runtime's declared memory estimate, and evicts only when the projected host
utilization would cross that ceiling. This allows smaller runtimes to coexist
while preventing two large runtimes from exhausting the machine.

## Multi-backend management pattern

Typical Spark layout:

| Port | Runtime | Backend | Use |
|------|---------|---------|-----|
| 8100 | LLooM gateway | — | All clients |
| 8201 | Chat keep-warm | **vLLM** 35B-A3B | Default agents / OMP |
| 8202 | Optional second chat | **SGLang** 27B or alt | A/B, dense quality |
| 8220 | TTS (optional) | OpenAI-compatible | Voice |

- Only one huge chat model **resident** at a time unless memory admits both.
- `runtimes.<daily-driver>.keepWarm: true`; leave the second runtime `enabled: true, keepWarm: false` for on-demand start.
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

LLooM now discovers NVIDIA Sync clusters, ranks recipes by cluster provider and node count, and coordinates ordered distributed runtime members through authenticated LLooM gateways on each node.

In the standard two-Spark layout, the leader owns the complete client-visible model catalog, external-provider credentials, and routing decisions. The worker receives only projected distributed runtime members and lifecycle commands. Set `server.inferenceEnabled: false` on the worker so an accidentally stale client endpoint returns a clear 503 instead of bypassing leader routing. Stable aliases with local and cloud route profiles let the leader keep entity cognition on the external provider while both Spark model processes are stopped, replaced, or canaried.

For a directly connected two-Spark cluster:

```bash
lloom cluster discover --id my-spark-cluster --apply
lloom select
lloom setup --recipe linux-nvidia-dgx-spark-2x-deepseek-v4-flash-mia-vllm --additive --apply --yes
lloom cluster doctor
lloom runtime-start deepseek-v4-flash-0731-cluster
```

The DeepSeek recipe uses a commit-pinned MiaAI Lab patch pack rather than copying a moving deployment script or making a generic Ray guess. LLooM pins the model revision and container digest, verifies every vendored artifact and the compatibility contract before patching, resolves per-node RoCE GIDs at launch, starts the worker before the head, rolls back partial starts, and exposes the model through the leader's normal LLooM URL. The enabled pack entries cover dict-form DSML tool history, reasoning-boundary JSON schemas, NVFP4 sparse-MLA dispatch, reasoning-safe client stop strings, truncated tool-call finish reasons, empty encoder outputs, the GB10 spin-wait, and measured two-prefill concurrency. MiaAI's issue31 thinking-budget patch and speculative top-k backports are deliberately disabled. See [DSpark patch packs](dspark-patch-packs.md).

The measured coexistence profile uses 262K context with `gpu-memory-utilization=0.73`. It keeps the existing `low` default reasoning mode. Request-level `thinking_token_budget` is opt-in and GPU-resident; omitting it keeps the original sampler path, and LLooM remains responsible for advertised output limits. The pinned checkpoint is expected to be cached on both nodes and starts in Hugging Face/Transformers offline mode. For companion services, keep Qwen3-Embedding-4B on the leader and apply `linux-nvidia-dgx-spark-cluster-flux2-klein-4b` to place FLUX.2 Klein 4B on the worker; both remain available through the leader endpoint.

Replicated placement remains available when each Spark should run an independent engine and LLooM should load-balance one logical model ID across them.

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
