# Bootstrap

For most first runs, start with `lloom onboard` or its short alias, `lloom up`. It composes hardware profiling, community-library recipe selection, config initialization, backend setup, model download/tuning, generated client profiles, optional keep-warm startup, and a verification pass into one guarded dry-run plan.

`lloom setup`, `lloom init`, and `lloom bootstrap` remain available as lower-level phases when you want to inspect or run them separately. `setup` handles the write/apply portion of onboarding, `init` creates a user config, enables the selected recipe runtimes, points model paths at a model root, sets keep-warm, and writes generated client profiles. `bootstrap` handles backend installation, model download/tuning, and client integration planning for an existing config.

`lloom onboard` composes these lower-level planners:

1. profile the machine
2. ask the configured community host for the best compatible recipe pack, unless `--offline` or an explicit `--recipe` is supplied
3. select the best compatible recipe from the LLooM library or host recommendation
4. derive and write the user config
5. plan backend setup
6. plan model download and tuning
7. plan client integration files
8. run doctor-style verification

Dry-run:

```zsh
lloom onboard
lloom up
lloom onboard --json
lloom setup-status --no-runtimes
```

`onboard` and `up` print a compact human summary by default. Add `--json` when automation, tests, or a UI needs the full machine-readable onboarding report.

Local dashboard:

```zsh
lloom up --go
open http://127.0.0.1:8100/
```

Apply after review:

```zsh
lloom onboard --apply --yes
```

Community-backed first run:

```zsh
lloom onboard --host https://community.example
lloom onboard --host https://community.example --go
lloom onboard --workload agentic-coding --capability tools --capability reasoning
lloom onboard --no-auto-host
```

When no explicit `--recipe` is provided, onboarding fetches the configured host's `recommendation-response.v1`, validates the selected recipe pack against the host's `backend-catalog.v1`, plans setup from the recommended recipe even before it is written locally, and on apply imports the pack before running setup. Community-backed onboarding starts from a minimal local gateway shell; model entries, backend bindings, runtime command lines, warmup, session cache, keep-warm, and client model order come from the selected recipe pack. The packaged default asks for the best known `agentic-coding` recipe with `tools`, `reasoning`, and `long-context` capability evidence. Pass repeated `--workload`, `--capability`, or `--tag` flags to target a different use case, or pass `--offline` / an explicit `--recipe` to force local-only selection.

The source checkout defaults to the local development host at `http://127.0.0.1:8110` and requires signed recipe packs. The dev host serves its seed catalog from `community/`; source checkouts can use a local development signing key under `community/keys/`, while installed packages generate an ephemeral process-local key when no private key is present. Imported local recipe packs still write to `recipes/` and `benchmarks/community/`. Production builds should point `community.hostUrl` at the signed public LLooM host and use production signing keys.

By default, onboarding trusts the configured community host's key feed at `/v1/keys` and uses those keys to verify the selected recipe pack. This keeps the normal install path one-command while still making trust visible in the JSON plan under `community.host.signingKeys`. Use `--signing-keys-path` for a nonstandard host route, `--trusted-key key-id=public-key.pem` for an explicit local trust root, or `--no-trust-host-keys` when testing unsigned/self-contained development feeds.

When the configured host is an explicit loopback HTTP URL, such as `http://127.0.0.1:8110`, onboarding starts `lloom-host serve` automatically if the host is not listening yet. Remote hosts are never auto-started. Use `--no-auto-host` to disable local host startup for debugging.

Useful options:

```zsh
lloom onboard --recipe apple-silicon-qwen36
lloom onboard --host https://community.example --no-require-signature
lloom onboard --host https://community.example --signing-keys-path /v1/keys
lloom onboard --host https://community.example --no-trust-host-keys
lloom onboard --home /opt/lloom-user
lloom onboard --client omp
lloom onboard --model-root ~/Models
lloom onboard --port 9100 --backend-port-range 9200-9299
lloom onboard --backend-catalog ./backend-catalog.json --shim-dir ~/.lloom/bin
lloom onboard --go
```

`--home` relocates the managed install root. If `--config-out` is omitted, onboarding and setup write `<home>/.lloom/config.json`; generated client files, launchers, default model roots, and session-cache paths also follow that home unless separately overridden.

LLooM keeps first-run planning separate from installed-operation commands. `lloom`, `lloom up`, `lloom onboard`, and read-only previews such as `lloom integrations` can use the packaged gateway shell plus community recommendations before anything has been written. `--go` applies the plan, starts the gateway in the background, and waits for `/health`. Operational commands that require an installed registry or runtime state, such as `models`, `doctor`, `serve`, `integrate`, `add-model`, `setup-status`, and runtime controls, require `<home>/.lloom/config.json` unless `--config` is explicit; on a fresh home they return a `not-installed` report with the matching `lloom up --home ...` and `lloom up --home ... --go` next actions.

Onboarding uses the same guarded executors as `setup`, `backend-install`, `install`, and `integrate`. `--go` is the first-run shortcut for applying the plan, confirming noninteractive writes, and starting the selected runtime. Real execution writes resumable state to `~/.lloom/install-state.json` unless `--state` overrides it; a repeated run skips completed backend and recipe steps. If a backend phase fails, LLooM records the failed step, marks recipe and integration phases as blocked, and returns `ok: false` without starting runtimes. Fix the failure and rerun the same `onboard --go` command to continue from the recorded state.

Advanced backend flags let recipe authors and power users test alternate backend catalogs without editing the generated user config: `--backend-catalog`, `--shim-dir`, `--backend-root`, `--install-root`, `--repo-parent`, and `--backend-model-root`. `--backend-catalog` accepts either a local `backend-catalog.v1` JSON file or a hosted catalog URL such as `https://community.example/v1/backends/catalog`; community onboarding defaults to that hosted route automatically. These flags are accepted by first-run setup and the lower-level backend/setup/status commands.

The gateway defaults to `127.0.0.1:8100`. Managed backend runtimes default to the `8201-8299` range in the packaged config. `--port` rewrites the generated LLooM provider URL, and `--backend-port-range` rewrites the selected recipe runtime ports, backend base URLs, health URLs, and warmup URLs. Users who do not have port conflicts should leave both alone.

Check what remains after an interrupted run:

```zsh
lloom setup-status --no-runtimes
lloom setup-status --client omp
```

The status report joins the selected recipe plan with installer state, model payload file checks, generated/native client config matches, and optional keep-warm runtime health. `ok: true` means the selected recipe and backend are valid for the machine; `complete: true` means setup, model files, client files, and included runtime health are all satisfied.

Recipe model downloads use the first available Hugging Face CLI in this order:

1. `LLOOM_HF_BIN`
2. `HF_HUB_CLI`
3. `hf`
4. `huggingface-cli`

Install `huggingface_hub[cli]` or point `LLOOM_HF_BIN` at a managed environment before applying recipes that contain `download-model` steps. If the target model directory already has model payload files, LLooM marks the step satisfied without invoking the CLI.

Browse the local recipe library and machine-ranked recommendation:

```zsh
lloom library
```

The running gateway exposes the same read-only planning contracts for a UI or dashboard:

```zsh
curl -sS http://127.0.0.1:8100/gateway/library
curl -sS 'http://127.0.0.1:8100/gateway/onboarding/plan?port=9100&backend_port_range=9200-9299'
curl -sS 'http://127.0.0.1:8100/gateway/onboarding/plan?host=https%3A%2F%2Fcommunity.example&require_signature=true'
curl -sS 'http://127.0.0.1:8100/gateway/setup/plan?port=9100&backend_port_range=9200-9299'
curl -sS -X POST http://127.0.0.1:8100/gateway/models/import-plan \
  -H 'content-type: application/json' \
  -d '{"modelRef":"qwen3:8b","backend":"ollama"}'
curl -sS -X POST http://127.0.0.1:8100/gateway/models/import \
  -H 'content-type: application/json' \
  -d '{"modelRef":"qwen3:8b","backend":"ollama","yes":true}'
```

Plan endpoints are preview-only. Apply endpoints and the matching CLI commands require an explicit `yes` gate for writes and starts.

After backend shim steps run, add `~/.lloom/bin` to `PATH` before starting managed runtimes:

```zsh
export PATH="$HOME/.lloom/bin:$PATH"
```

Start and verify the selected keep-warm runtimes from the CLI:

```zsh
lloom runtimes
lloom keep-warm
lloom runtimes
```
