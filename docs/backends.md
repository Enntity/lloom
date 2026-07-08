# Backend Catalog

LLooM keeps backend families in `backends/catalog.json`. Recipes reference those backend IDs instead of inventing their own runtime vocabulary.

Current catalog entries:

- `mtplx`
- `mlx-lm`
- `llama-cpp`
- `ollama`
- `optiq`
- `stable-diffusion-cpp`
- `vllm`

Inspect catalog entries:

```zsh
node bin/lloom.mjs backends
node bin/lloom.mjs backends mtplx
```

Inspect a backend readiness plan:

```zsh
node bin/lloom.mjs backend-plan mtplx
```

Backend plans report:

- platform support
- expected commands on `PATH`
- missing commands
- setup steps
- server protocol and health/chat/image paths

Run a dry-run backend install:

```zsh
node bin/lloom.mjs backend-install mtplx
```

Apply it after review:

```zsh
node bin/lloom.mjs backend-install mtplx --apply --yes
```

Completed backend steps are recorded in `data/install-state.json`. `link-command` steps create executable shims under `data/bin` by default, so an existing local runtime can be exposed by adding that directory to `PATH`.

Recipe install plans remain responsible for model-specific downloads and tuning. Backend plans are the shared substrate that lets community recipes target common runtime families consistently.
