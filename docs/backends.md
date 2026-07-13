# Backend Catalog

LLooM keeps backend families in `backends/catalog.json`. Recipes reference those backend IDs instead of inventing their own runtime vocabulary.

The catalog is also a public interchange format: `https://lloom.dev/schemas/backend-catalog.v1.schema.json` with media type `application/vnd.lloom.backend-catalog+json;version=1`. Runtime authors can publish compatible backend catalogs independently, and LLooM can validate them with the same interchange checker used for recipes and benchmark evidence.

Current catalog entries:

- `mtplx`
- `mlx-lm`
- `llama-cpp`
- `ollama`
- `openai-compatible`
- `lm-studio`
- `optiq`
- `stable-diffusion-cpp`
- `vllm`
- `sglang`

MTPLX runtime definitions can enable LLooM-managed SSD SessionBank caching through `sessionCache`. Generated user configs place those caches under `~/.lloom/session-cache/<runtime-id>` so model restarts, evictions, and gateway restarts reuse the same persistent prefix snapshots.

Inspect catalog entries:

```zsh
lloom backends
lloom backends mtplx
lloom validate backends/catalog.json
```

Inspect a backend readiness plan:

```zsh
lloom backend-plan mtplx
```

Backend plans report:

- platform support
- expected commands on `PATH`
- missing commands
- setup steps
- setup audit metadata
- server protocol and health/chat/image paths

Setup steps use a small, portable action vocabulary:

- `check-command`: verify an expected executable.
- `command`: run a guarded command.
- `python-venv`: create a user-space Python virtual environment.
- `pip-install`: install packages into that environment.
- `git-clone`: clone a backend source tree if it is not already present.
- `cmake-configure` and `cmake-build`: build C/C++ backends without shell glue.
- `brew-install`: install macOS packages through Homebrew.
- `link-command`: expose an existing or newly built executable through a LLooM shim.
- `manual`: documented fallback for platforms where a safe non-interactive installer is not defined yet.

Steps can declare `platforms` to keep macOS, Linux, and architecture-specific setup separate. They can also declare idempotency guards such as `skipIfCommandAvailable`, `skipIfExecutableExists`, and `skipIfPathExists`; dry-runs show those as skipped, and applied skipped steps are recorded as complete.

Each planned setup step includes an `audit` block derived from the action and resolved paths:

- `risk`: `low`, `medium`, `high`, or `manual`
- `effects`: stable labels such as `executes-command`, `writes-files`, `uses-network`, `builds-source`, `creates-shim`, `modifies-system-package-manager`, `manual-required`, or `skipped`
- `writes`: concrete resolved paths that may be created or changed
- `network`, `executes`, and `modifiesSystem`: booleans for UI warnings and policy gates
- `summary`: one-line human review text

The backend plan also includes `setupAudit`, an aggregate of risk counts and effects. `backend-install --apply --yes` persists each step's audit block in install state, so a resumed setup or dashboard can show what was authorized and what ran.

Run a dry-run backend install:

```zsh
lloom backend-install mtplx
lloom backend-install vllm --backend-catalog https://community.example/v1/backends/catalog
lloom backend-install sglang --backend-catalog https://community.example/v1/backends/catalog
```

### NVIDIA DGX Spark / GB10

vLLM and SGLang are the primary Spark backends (see `docs/dgx-spark.md`). On GB10, generic PyPI wheels may lack Blackwell/ARM64 support — set `LLOOM_VLLM_BIN` / `LLOOM_SGLANG_PYTHON` to a Spark-tuned binary or register an external Docker OpenAI server with `lloom add-model 'openai:http://host:port/v1#model-id'`.

Seed recipes:

- `community/recipes/linux-nvidia-qwen36-35b-a3b-fp8-vllm.json` — agent default (vLLM)
- `community/recipes/linux-nvidia-qwen36-27b-nvfp4-vllm.json` — dense NVFP4 (vLLM)
- `community/recipes/linux-nvidia-qwen36-27b-sglang.json` — agent/prefix lane (SGLang)

Apply a backend install after review:

```zsh
lloom backend-install mtplx --apply --yes
```

Completed backend steps are recorded in `~/.lloom/install-state.json` unless `--state` overrides it. `link-command` steps create executable shims under `~/.lloom/bin` by default, so a backend installed beside LLooM can be exposed by adding that directory to `PATH`. The checked-in catalog now includes executable setup paths for MTPLX, MLX LM, llama.cpp, vLLM, SGLang, stable-diffusion.cpp, and macOS Ollama; Linux Ollama, OptiQ, LM Studio, and generic OpenAI-compatible servers use documented fallback steps until their safest non-interactive installers are pinned. MLX LM, vLLM, and SGLang install into private environments under `~/.lloom/backends/<backend>/venv`, avoiding macOS/Homebrew's `externally-managed-environment` restriction and leaving global Python untouched. Their commands are exposed through `~/.lloom/bin`. Config-only external servers can still be added with `lloom add-model lmstudio:<model-id>` or `lloom add-model 'openai:http://host:port/v1#model-id'`.

Recipe install plans remain responsible for model-specific downloads and tuning. Backend plans are the shared substrate that lets community recipes target common runtime families consistently.

Authenticated hosted OpenAI-compatible providers use the same config-only unmanaged path: `lloom add-model 'openai:https://provider.example/v1#model-id' --api-key-env PROVIDER_API_KEY`. The generated backend stores only `apiKeyEnv`, never the credential value. Unmanaged models remain visible through `/v1/models`, client integrations, metrics, and the live topology while staying outside runtime warmup, admission, eviction, and local memory planning.

`lloom-host` publishes a lightweight backend index at `GET /v1/backends` and the full portable backend setup document at `GET /v1/backends/catalog`. Recipe authors and independent installers should use the catalog endpoint when they need setup actions, platform filters, server contracts, and idempotency guards rather than just the stable backend IDs.
