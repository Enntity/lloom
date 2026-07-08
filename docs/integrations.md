# Integrations

LLooM is designed to be boring from the client's point of view: it presents one OpenAI-compatible base URL and generated config files.

## OMP

Generate:

```zsh
npm run generate:clients
node bin/lloom.mjs integrations
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
node bin/lloom.mjs integrate omp
node bin/lloom.mjs integrate omp --apply --yes
```

## OpenCode

Merge `clients/generated/opencode.json` into your OpenCode config or start from it directly. The generated provider disables client-side timeouts because local cold starts and long-prefill requests can legitimately exceed hosted-model defaults.

LLooM also writes a managed profile with:

```zsh
node bin/lloom.mjs integrate opencode --apply --yes
```

The managed profile goes under `~/.lloom/integrations/opencode.json`.

## Codex, Claude, Hermes, and Zero

LLooM emits managed environment profiles and launcher scripts:

- `clients/generated/codex.env`
- `clients/generated/lloom-codex`
- `clients/generated/claude.env`
- `clients/generated/lloom-claude`
- `clients/generated/hermes.env`
- `clients/generated/lloom-hermes`
- `clients/generated/zero.env`
- `clients/generated/lloom-zero`

Apply them to `~/.lloom/integrations/` and `~/.lloom/bin/`:

```zsh
node bin/lloom.mjs integrate codex --apply --yes
node bin/lloom.mjs integrate claude --apply --yes
node bin/lloom.mjs integrate hermes --apply --yes
node bin/lloom.mjs integrate zero --apply --yes
```

These profiles export `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`; the Claude-compatible profile also exports Anthropic-compatible variables. The launchers source the matching profile and then execute `codex`, `claude`, `hermes`, or `zero`.

```zsh
export PATH="$HOME/.lloom/bin:$PATH"
lloom-codex --help
lloom-claude --help
```

Use `LLOOM_CODEX_BIN`, `LLOOM_CLAUDE_BIN`, `LLOOM_HERMES_BIN`, or `LLOOM_ZERO_BIN` when the actual binary name or path differs. Native file writes for those clients should be added only when their current config contracts are pinned by tests.

## Other Clients

Use:

```text
base_url: http://127.0.0.1:8100/v1
api_key: sk-lloom-local
```

The default config allows missing auth for local development. Set `security.allowMissingAuth` to `false` before exposing the gateway beyond localhost.

## Automatic Setup Flow

The intended install flow for a client integration is:

1. `lloom setup --client <client>` to preview selected recipe, user config, keep-warm, backend installation, model download/tuning, and client files.
2. `lloom setup --client <client> --apply --yes` to write the config, install resumable backend/model steps, and install the chosen client profile.
3. `lloom serve --config ~/.lloom/config.json` to expose the local OpenAI/Anthropic bridge.
4. `lloom keep-warm --config ~/.lloom/config.json` or `lloom setup --apply --yes --start` when you want the selected keep-warm runtime launched immediately.

The same registry powers `/v1/models`, OMP YAML, OMP role config, and OpenCode JSON, so clients should discover or generate from LLooM instead of carrying stale model IDs.
