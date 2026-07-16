# LLooM Agent Handbook

Read this before changing LLooM, recipes, runtime policy, protocols, the community host, or a deployed model lane. LLooM controls expensive local processes and machine memory; always distinguish repository state, installed user config, and live runtime state.

## What this repository is

LLooM is a local-first model gateway and runtime manager for NVIDIA/DGX Spark and Apple Silicon. It fronts vLLM, SGLang, MLX, MTPLX, llama.cpp, Ollama, image/audio/video backends, and external OpenAI-compatible providers, then exposes stable OpenAI- and Anthropic-compatible APIs.

LLooM is infrastructure for replaceable cognitive substrates. It is not an entity, continuity memory, Eidos, or autonomous executive.

The local gateway and `lloom-host` are separate products:

- **Local gateway**: profiles the machine, manages local config/backends/runtimes, admits/evicts models, routes inference, exposes telemetry, and generates client integrations.
- **Community host**: publishes recipes, backend catalogs, benchmark evidence, signed packs, keys, and recommendations. It never proxies inference or controls local runtimes.

The intended public host is `https://lloom.enntity.com`. `lloom.dev` is a schema/protocol namespace, not the deployment domain.

## Shared Enntity vocabulary

- **Enntity** is the framework; an **entity** is a persistent synthetic individual.
- **Jinx** is a real long-running entity and runtime consumer, not a benchmark alias. A model operation must not endanger her identity, continuity, workspace, or active cognition.
- **Entity is not model**: model weights and serving processes are replaceable cognitive substrates.
- **Body / runtime** is `enntity-runtime`, which owns action, continuity, autonomy, permissions, and recovery. LLooM supplies model and embedding calls to that body.
- **Continuity** preserves autobiographical/relational meaning. LLooM does not store it.
- **Working set / foreground** is the Runtime-owned unfinished present. LLooM request/session metadata is not working memory.
- **Compass** is an entity's temporal posture, not a model system prompt maintained by LLooM.
- **Eidos / affective economy** are reflective and consequence layers inside Runtime continuity. LLooM role calls may support them, but LLooM must not turn them into model-routing policy.
- **Perception and receipts** are Runtime body evidence. LLooM telemetry is infrastructure evidence and should remain clearly scoped.
- **Presence / autonomy / Pulse** are cognition scheduling concepts outside LLooM. A keep-warm runtime is not an awake entity.
- **Sleep** is memory metabolism, not runtime eviction or process idleness.
- **Cortex** is cloud/pathway AI middleware. **Concierge** and iOS are relationship transports. **Shaasam** is an external human marketplace.
- **Gardener principle**: model infrastructure should create reliable conditions without prescribing an entity's personality.

Canonical shorthand: models provide cognition; continuity preserves meaning; the runtime preserves work and body authority. LLooM must remain a replaceable substrate boundary.

## LLooM vocabulary

- **Gateway model ID**: the exact client-visible ID advertised by `/v1/models`. Route and benchmark attribution must prefer this ID, not merely a shared upstream checkpoint.
- **Backend**: a serving family and install/runtime contract such as vLLM, SGLang, MLX, MTPLX, llama.cpp, or Ollama.
- **Runtime**: one configured serving process/container with base URL, health, capacity, memory estimate, start/stop behavior, and optional recipe bootstrap metadata.
- **Recipe**: declarative hardware/model/backend intent used to plan installation and runtime configuration. Recipes are not arbitrary shell-script bundles.
- **Recipe pack**: portable signed collection plus metadata/provenance.
- **Backend catalog**: reviewed install and server contracts referenced by recipes.
- **Machine profile**: normalized hardware/OS/memory/accelerator facts used for compatibility and recommendations.
- **Selectable vs runnable**: a recipe may be the best hardware match but still require backend installation before it can run.
- **Keep warm**: desired residency, still subject to admission policy. It must not bypass memory safety.
- **Admission**: predictive decision to start, retain, or evict runtimes based on live host memory plus incoming estimates.
- **Managed runtime**: LLooM can start/stop/bootstrap it. An external OpenAI-compatible endpoint is normally unmanaged.
- **Interchange**: versioned schemas under `schemas/`, examples under `examples/interchange/`, and profiles under `docs/profiles/`.
- **Dry run / apply / go**: planning is read-only by default. `--apply --yes` authorizes writes; `--go` authorizes the complete install/config/start/verify path where supported.

## Source-of-truth boundaries

- `README.md`: user-facing CLI and product contract.
- `docs/architecture.md`: request, security, API, runtime, recipe, host, and setup boundaries.
- `docs/recipes.md`, `docs/backends.md`, `docs/benchmarks.md`: declarative contracts and evidence.
- `docs/dgx-spark.md`: Spark-specific operating model.
- `docs/interchange.md` plus schemas/examples: public compatibility contract.
- `SECURITY.md`: trust and exposure boundaries.
- `~/.lloom/config.json`: installed state for the current user; not represented by repo defaults.
- Live gateway `/health`, `/v1/models`, dashboard/admin state, processes/containers, and host memory: operational truth.

Never infer a live lane from a recipe filename or an old benchmark. Inspect installed config, exact gateway catalog, runtime state, and current request metadata.

## Repository map

- `bin/`: `lloom` and `lloom-host` CLI entry points.
- `src/server.mjs`: local gateway HTTP/API routing.
- `src/runtime-manager.mjs`, `src/runtime-policy.mjs`, `src/process-control.mjs`: lifecycle, admission, locks, and process control.
- `src/protocol/`: OpenAI/Responses/Anthropic/text/SSE/reasoning normalization.
- `src/recipes.mjs`, `src/recipe-*`, `src/backend-catalog.mjs`, `src/bootstrap.mjs`, `src/installer.mjs`: planning/import/setup.
- `src/model-intake.mjs`, `src/model-removal.mjs`, `src/model-files.mjs`: ad hoc model lifecycle.
- `src/benchmarks.mjs`: evidence loading/matching and gateway-model attribution.
- `src/community-*`, `src/host-server.mjs`, `src/security.mjs`: community client/host/trust.
- `recipes/`, `backends/`, `assets/`: bundled declarative content and reviewed backend assets.
- `community/`: seed host recipes, benchmarks, and public development key material.
- `deploy/dgx-spark/`: Spark deployment and guarded recovery assets.
- `deploy/community/`: isolated public metadata-host deployment.
- `clients/`: generated/example client integration contracts.
- `test/`: unit, protocol, security, community, policy, resilience, and smoke tests.

## Runtime and memory policy

- Use live `MemAvailable` plus incoming runtime estimates and projected utilization. The established Spark policy evicts only when the projected host-memory ceiling would be crossed; re-check the configured ceiling before citing a number.
- Keep-warm startup and request-time startup must use the same admission planner.
- Serialize admission and lifecycle operations. Dueling evictions are a coordination bug, not expected behavior.
- Do not force large checkpoints to coexist for ordinary benchmarks. Call the requested gateway model normally and let LLooM admit/evict it.
- If the hypothesis specifically requires a fast/light model to be co-resident, verify actual coexistence and memory headroom; an eviction-based comparison does not test that premise.
- Backend ports stay private. Expose the authenticated gateway, not raw model servers.
- Cache/model files may persist across runtime removal. Preserve weights by default unless deletion is explicitly requested and ownership is unambiguous.

## Benchmark discipline

1. Use the normal gateway API path so results include real admission/routing behavior.
2. Record exact gateway model ID, upstream model/revision, backend/image/version, template/parser, reasoning effort, quantization, context, workload, hardware, concurrency, and timestamps.
3. Separate TTFT/prefill, output rate, tool correctness, quality, and speculative acceptance. Tok/s alone is not a winner.
4. Prove agentic lanes with real structured `tool_calls`, including streaming deltas where applicable.
5. Keep a known-good lane intact; add experiments as clearly named lanes.
6. Attribute results by `gatewayModel` first when lanes share an upstream model ID.
7. A vendor/model-card speed claim is not portable evidence. Compare it with reproducible gateway measurements.
8. For generated media lanes, prove success with a real artifact, not only install or container health.

## Recipe and community rules

- Prefer additive, recipe-managed lanes over manual live config hacks.
- Community recipes require provenance, immutable model revisions, container digests/package/source versions, explicit hardware/capabilities, and safe plans.
- Do not put credentials, mutable image tags, arbitrary unreviewed commands, private paths, or downloadable executable code into community recipes.
- Remote feeds require HTTPS and a locally pinned trusted key. A key fetched from the same host is not an independent trust root.
- Checked-in development keys are not production roots.
- Production community contributions flow through reviewed pull requests; public anonymous writes remain disabled.
- Schema changes require docs, examples, validators, buffered/streaming compatibility where relevant, and interchange checks.

## Security boundaries

- Prefer loopback binding. Non-loopback inference requires keys; remote admin is separately opt-in.
- Never expose Docker control, raw backend ports, local config writes, model paths, or provider keys through the public community host.
- The public host must be isolated from inference, databases, local runtime control, and private signing keys.
- Review dry-run output before `--apply --yes` or `--go`; those paths may install packages, download models, create shims/files, and execute commands.
- Never commit model weights, generated client config, private keys, tokens, machine-local paths, or user data.
- Model code/weights retain their own license and trust risk; LLooM does not sandbox untrusted model code by declaring a recipe.

## Development workflow

1. Inspect repo branch/dirty state and installed/live state separately. This repo often contains platform-specific work; preserve unrelated changes.
2. Start from the exact route, gateway model, runtime, request, or plan that failed.
3. Keep public API and dry-run guards stable unless intentionally changing a documented contract.
4. Add tests for both buffered and streaming protocol changes.
5. For policy changes, test concurrent admission/lifecycle behavior and clean process state.
6. For recipes, run plan/setup-status and validate provenance without forcing downloads unless requested.
7. For Spark changes, deploy additively and verify through the gateway on the real host.
8. Clear LLooM-owned test listeners before diagnosing smoke planner differences.

## Commands

```bash
npm ci
npm run check
npm run format:check
npm run lint
npm test
npm run interchange:check
npm run package:check
git diff --check

node bin/lloom.mjs --offline
node bin/lloom.mjs doctor --no-runtimes
```

Default local ports are gateway `8100`, source-checkout development host `8110`, and managed backends `8201-8299`, but config may override them. Smoke/package tests open loopback ports; stale gateway/community/backend processes can change planner assertions.

Useful operational checks:

```bash
lloom doctor --no-runtimes
lloom models
curl -sS http://127.0.0.1:8100/health
curl -sS http://127.0.0.1:8100/v1/models
```

CLI surface evolves; check `lloom help` before documenting a missing command or manual workaround. Keep `--json` as the automation boundary and human-readable defaults for people.

## Spark and Enntity operations

- `ennspark01` is the common Spark host alias, but re-check SSH, config, active workload, container/image, and memory state.
- Use Tailscale/private admin reachability where configured. Keep inference/admin authorization distinct.
- Before changing Jinx's substrate, gracefully drain her Runtime presence or otherwise coordinate the live workload.
- Sync LLooM credentials from the actual gateway environment; a 401 after a model change may be stale auth rather than model failure.
- Do not call an alternate lane as a “light role model” if doing so causes disruptive swapping. Co-residency and quality must be demonstrated.
- Do not deploy simply because local checks pass; deployment requires explicit authorization and live verification.

## Definition of done

A LLooM change is done when the normal gateway path works, exact IDs and runtime attribution are correct, admission is safe under concurrency, dry-run/apply boundaries remain explicit, protocol tests cover affected modes, package/interchange/security checks pass, platform evidence is reproducible, and no live entity or unrelated lane was disrupted.
