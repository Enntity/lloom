# Integrations

Switchyard is designed to be boring from the client's point of view: it presents one OpenAI-compatible base URL and generated config files.

## OMP

Generate:

```zsh
npm run generate:clients
node bin/switchyard.mjs integrations
```

Install the generated model catalog:

```zsh
cp clients/generated/omp-models.yml ~/.omp/agent/models.yml
```

Point OMP roles at the exact model IDs from that file. For the fastest 27B lane:

```yaml
modelRoles:
  default: local-llm/Youssofal/Qwen3.6-27B-MTPLX-Optimized-Speed:low
```

Apply directly after reviewing the plan:

```zsh
node bin/switchyard.mjs integrate omp
node bin/switchyard.mjs integrate omp --apply --yes
```

## OpenCode

Merge `clients/generated/opencode.json` into your OpenCode config or start from it directly. The generated provider disables client-side timeouts because local cold starts and long-prefill requests can legitimately exceed hosted-model defaults.

Switchyard also writes a managed profile with:

```zsh
node bin/switchyard.mjs integrate opencode --apply --yes
```

The managed profile goes under `~/.switchyard/integrations/opencode.json`.

## Codex, Claude, Hermes, and Zero

Switchyard emits managed environment profiles:

- `clients/generated/codex.env`
- `clients/generated/claude.env`
- `clients/generated/hermes.env`
- `clients/generated/zero.env`

Apply them to `~/.switchyard/integrations/`:

```zsh
node bin/switchyard.mjs integrate codex --apply --yes
node bin/switchyard.mjs integrate claude --apply --yes
node bin/switchyard.mjs integrate hermes --apply --yes
node bin/switchyard.mjs integrate zero --apply --yes
```

These profiles export `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`; the Claude-compatible profile also exports Anthropic-compatible variables. Native file writes for those clients should be added only when their current config contracts are pinned by tests.

## Other Clients

Use:

```text
base_url: http://127.0.0.1:8100/v1
api_key: sk-switchyard-local
```

The default config allows missing auth for local development. Set `security.allowMissingAuth` to `false` before exposing the gateway beyond localhost.

## Automatic Setup Flow

The intended install flow for a client integration is:

1. `switchyard profile` to detect the machine.
2. `switchyard select` to choose the best runnable recipe.
3. `switchyard install <recipe>` to preview setup.
4. `switchyard install <recipe> --apply --yes` to execute.
5. `switchyard serve` to expose the local OpenAI/Anthropic bridge.
6. `npm run generate:clients` to write exact-ID client configs.
7. `switchyard integrate <client> --apply --yes` to install the chosen client profile.

The same registry powers `/v1/models`, OMP YAML, and OpenCode JSON, so clients should discover or generate from Switchyard instead of carrying stale model IDs.
