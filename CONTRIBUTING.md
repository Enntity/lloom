# Contributing to LLooM

Thank you for helping improve LLooM. The project welcomes focused fixes, new backend adapters, portable recipes, benchmark evidence, protocol compatibility work, documentation, and tests.

## Development setup

Requirements:

- Node.js 20 or newer
- npm
- Python 3 for syntax-checking the optional MLX Audio and MTPLX patch helpers
- macOS, Linux, or another platform capable of running the Node.js test suite

```bash
git clone https://github.com/enntity/lloom.git
cd lloom
npm ci
npm test
```

## Before opening a pull request

Run the same checks used by CI:

```bash
npm run check
npm run format:check
npm run lint
npm test
npm run interchange:check
npm run package:check
git diff --check
```

Some smoke and package tests open temporary loopback ports. Make sure another LLooM development process is not occupying the test ports if a runtime-planning assertion behaves unexpectedly.

## Contribution guidelines

- Keep changes narrowly scoped and preserve existing API behavior unless the change is intentionally documented as breaking.
- Add or update tests for behavior changes. Protocol work should cover both buffered and streaming paths when applicable.
- Never commit model weights, generated client configuration, private keys, access tokens, machine-local paths, or user data.
- Keep write and execution paths guarded. Imports and plans must remain read-only until the user explicitly applies them.
- Document platform-specific behavior and avoid claiming hardware performance without reproducible evidence.
- Update public docs, schemas, and examples when changing an interchange contract.

### Recipes and benchmarks

Recipe changes should include clear provenance, hardware requirements, backend capabilities, and safe dry-run commands. Benchmark submissions should record the exact model, backend, settings, hardware, workload, and measurement method. Do not submit results that cannot be reproduced or whose model/runtime license prevents redistribution of the metadata.

Community registry changes are reviewed through pull requests; the production host does not accept anonymous uploads. A proposed recipe must use immutable model revisions, container digests, package versions, and source commits where applicable. Do not add arbitrary shell commands, unreviewed executable URLs, mutable image tags, credentials, or new backend installers to a community recipe. Maintainers reproduce proposals in an isolated machine before promoting them to an experimental or stable signed release.

### Third-party code and patches

Identify the upstream project and license for copied or adapted code. Preserve required copyright and NOTICE text, and add the material to `THIRD_PARTY_NOTICES.md` when needed. Do not submit code whose license is incompatible with distribution in this repository.

## Pull requests

Pull requests should explain:

- what changed and why;
- user or developer impact;
- compatibility or security considerations;
- the validation performed;
- hardware and runtime details for platform-specific work.

Contributions are accepted under the license that applies to the contributed file. New LLooM-owned files default to MIT unless they clearly state another compatible license.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
