# Bootstrap

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
