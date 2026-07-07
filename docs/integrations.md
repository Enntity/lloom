# Integrations

Switchyard is designed to be boring from the client's point of view: it presents one OpenAI-compatible base URL and generated config files.

## OMP

Generate:

```zsh
npm run generate:clients
node bin/switchyard.mjs integrations
```

Install the generated model catalog and role config:

```zsh
cp clients/generated/omp-models.yml ~/.omp/agent/models.yml
cp clients/generated/omp-config.yml ~/.omp/agent/config.yml
```

The generated role config points OMP at the exact model IDs from that file. For the fastest 27B lane:

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

1. `switchyard setup --client <client>` to preview selected recipe, user config, keep-warm, backend installation, model download/tuning, and client files.
2. `switchyard setup --client <client> --apply --yes` to write the config, install resumable backend/model steps, and install the chosen client profile.
3. `switchyard serve --config ~/.switchyard/config.json` to expose the local OpenAI/Anthropic bridge.
4. `switchyard keep-warm --config ~/.switchyard/config.json` or `switchyard setup --apply --yes --start` when you want the selected keep-warm runtime launched immediately.

The same registry powers `/v1/models`, OMP YAML, OMP role config, and OpenCode JSON, so clients should discover or generate from Switchyard instead of carrying stale model IDs.
