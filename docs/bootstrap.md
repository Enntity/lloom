# Bootstrap

For most first runs, start with `lloom setup`. It composes config initialization, backend setup, model download/tuning, generated client profiles, and live client integration writes into one guarded dry-run plan.

`lloom init` and `lloom bootstrap` remain available as lower-level phases when you want to inspect or run them separately. `init` creates a user config, enables the selected recipe runtimes, points model paths at a model root, sets keep-warm, and writes generated client profiles. `bootstrap` handles backend installation, model download/tuning, and client integration planning for an existing config.

`lloom setup` composes these lower-level planners:

1. profile the machine
2. select the best compatible recipe
3. derive and write the user config
4. plan backend setup
5. plan model download and tuning
6. plan client integration files

Dry-run:

```zsh
node bin/lloom.mjs setup
node bin/lloom.mjs setup-status --no-runtimes
```

Apply after review:

```zsh
node bin/lloom.mjs setup --apply --yes
```

Useful options:

```zsh
node bin/lloom.mjs setup --recipe apple-silicon-qwen36
node bin/lloom.mjs setup --client omp
node bin/lloom.mjs setup --model-root ~/Models
node bin/lloom.mjs setup --apply --yes --start
```

Setup uses the same guarded executors as `backend-install`, `install`, and `integrate`. Real execution writes resumable state to `data/install-state.json`; a repeated run skips completed backend and recipe steps.

Check what remains after an interrupted run:

```zsh
node bin/lloom.mjs setup-status --state data/install-state.json --no-runtimes
node bin/lloom.mjs setup-status --client omp
```

The status report joins the selected recipe plan with installer state, populated model directories, generated/native client config matches, and optional keep-warm runtime health. `ok: true` means the selected recipe and backend are valid for the machine; `complete: true` means setup, model artifacts, client files, and included runtime health are all satisfied.

Recipe model downloads use the first available Hugging Face CLI in this order:

1. `LLOOM_HF_BIN`
2. `HF_HUB_CLI`
3. `hf`
4. `huggingface-cli`

Install `huggingface_hub[cli]` or point `LLOOM_HF_BIN` at a managed environment before applying recipes that contain `download-model` steps. If the target model directory is already populated, LLooM marks the step satisfied without invoking the CLI.

After backend shim steps run, add `data/bin` to `PATH` before starting managed runtimes:

```zsh
export PATH="$PWD/data/bin:$PATH"
```

Start and verify the selected keep-warm runtimes from the CLI:

```zsh
lloom runtimes
lloom keep-warm
lloom runtimes
```
