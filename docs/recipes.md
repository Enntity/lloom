# Recipes

Recipes are evidence-backed backend/model choices for a machine class. They should record:

- Hardware class and memory
- Backend and version
- Model artifact
- Quantization or tensor format
- Context window
- Startup and warmup requirements
- Prompt-processing and generation throughput
- Known client compatibility issues

## Apple Silicon Qwen3.6 Starting Point

On the current M2 Max 96 GB machine, the strongest observed Qwen3.6 lanes were:

- Dense 27B: `Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed`
- 35B-A3B MoE: `Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16`

These are encoded in `recipes/apple-silicon-qwen36.json` and exposed by default in `config/default.json`.

## Plan Contract

Recipes are JSON documents with these top-level sections:

- `requirements`: platform, memory, disk, and command prerequisites.
- `backend`: the runtime family being configured.
- `setup.steps`: ordered checks, downloads, commands, and tuning operations.
- `models`: role-to-artifact mappings plus gateway model/runtime IDs.

`backend.id` should match an entry in `backends/catalog.json`.

Inspect a plan without running it:

```zsh
node bin/switchyard.mjs profile
node bin/switchyard.mjs select
node bin/switchyard.mjs benchmarks apple-silicon-qwen36
node bin/switchyard.mjs plan apple-silicon-qwen36 --model-root ~/Models
```

`selectable` means the recipe fits the machine platform and memory. `runnable` means the required backend commands are already visible on `PATH`. A selectable recipe with `setupRequired: true` is still a valid choice for automatic setup.

When benchmark evidence exists for the recipe, `plan` attaches the best matching result to each model role. That keeps the recipe executable while making the "best model for this machine" claim auditable.

Run a safe dry-run install:

```zsh
node bin/switchyard.mjs install apple-silicon-qwen36 --model-root ~/Models
```

Execute the same plan only after review:

```zsh
node bin/switchyard.mjs install apple-silicon-qwen36 --model-root ~/Models --apply --yes
```

Real execution records completed steps in `data/install-state.json`. If setup is interrupted, rerunning the command skips completed steps and resumes from the next pending step.
