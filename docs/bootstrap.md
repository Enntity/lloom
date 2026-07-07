# Bootstrap

For most first runs, start with `switchyard init`. It creates a user config, enables the selected recipe runtimes, points model paths at a model root, sets keep-warm, and writes generated client profiles. It does not install backends or download/tune models; `--integrate` only adds live native client file writes such as OMP's model catalog.

`switchyard bootstrap` is the heavier setup orchestrator for backend installation, model download/tuning, and client integration planning.

`switchyard bootstrap` is the one-command orchestration layer. It composes the lower-level planners:

1. profile the machine
2. select the best compatible recipe
3. plan backend setup
4. plan model download and tuning
5. plan client integration files

Dry-run:

```zsh
node bin/switchyard.mjs bootstrap
```

Apply after review:

```zsh
node bin/switchyard.mjs bootstrap --apply --yes
```

Useful options:

```zsh
node bin/switchyard.mjs bootstrap --recipe apple-silicon-qwen36
node bin/switchyard.mjs bootstrap --client omp
node bin/switchyard.mjs bootstrap --model-root ~/Models
```

Bootstrap uses the same guarded executors as `backend-install`, `install`, and `integrate`. Real execution writes resumable state to `data/install-state.json`; a repeated run skips completed backend and recipe steps.

After backend shim steps run, add `data/bin` to `PATH` before starting managed runtimes:

```zsh
export PATH="$PWD/data/bin:$PATH"
```
