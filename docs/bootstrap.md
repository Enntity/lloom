# Bootstrap

For most first runs, start with `switchyard setup`. It composes config initialization, backend setup, model download/tuning, generated client profiles, and live client integration writes into one guarded dry-run plan.

`switchyard init` and `switchyard bootstrap` remain available as lower-level phases when you want to inspect or run them separately. `init` creates a user config, enables the selected recipe runtimes, points model paths at a model root, sets keep-warm, and writes generated client profiles. `bootstrap` handles backend installation, model download/tuning, and client integration planning for an existing config.

`switchyard setup` composes these lower-level planners:

1. profile the machine
2. select the best compatible recipe
3. derive and write the user config
4. plan backend setup
5. plan model download and tuning
6. plan client integration files

Dry-run:

```zsh
node bin/switchyard.mjs setup
node bin/switchyard.mjs setup-status --no-runtimes
```

Apply after review:

```zsh
node bin/switchyard.mjs setup --apply --yes
```

Useful options:

```zsh
node bin/switchyard.mjs setup --recipe apple-silicon-qwen36
node bin/switchyard.mjs setup --client omp
node bin/switchyard.mjs setup --model-root ~/Models
node bin/switchyard.mjs setup --apply --yes --start
```

Setup uses the same guarded executors as `backend-install`, `install`, and `integrate`. Real execution writes resumable state to `data/install-state.json`; a repeated run skips completed backend and recipe steps.

Check what remains after an interrupted run:

```zsh
node bin/switchyard.mjs setup-status --state data/install-state.json --no-runtimes
node bin/switchyard.mjs setup-status --client omp
```

The status report joins the selected recipe plan with installer state, populated model directories, generated/native client config matches, and optional keep-warm runtime health. `ok: true` means the selected recipe and backend are valid for the machine; `complete: true` means setup, model artifacts, client files, and included runtime health are all satisfied.

Recipe model downloads use the first available Hugging Face CLI in this order:

1. `SWITCHYARD_HF_BIN`
2. `HF_HUB_CLI`
3. `hf`
4. `huggingface-cli`

Install `huggingface_hub[cli]` or point `SWITCHYARD_HF_BIN` at a managed environment before applying recipes that contain `download-model` steps. If the target model directory is already populated, Switchyard marks the step satisfied without invoking the CLI.

After backend shim steps run, add `data/bin` to `PATH` before starting managed runtimes:

```zsh
export PATH="$PWD/data/bin:$PATH"
```

Start and verify the selected keep-warm runtimes from the CLI:

```zsh
switchyard runtimes
switchyard keep-warm
switchyard runtimes
```
