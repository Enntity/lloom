# Integrations

LLooM is designed to be boring from the client's point of view: it presents one OpenAI-compatible base URL and generated config files.

## Discovery

Clients that can discover local gateways should read:

```zsh
curl -sS http://127.0.0.1:8100/v1/integrations
curl -sS http://127.0.0.1:8100/gateway/integrations
curl -sS http://127.0.0.1:8100/gateway/integrations/status
```

Both routes return the versioned `client-integrations.v1` interchange document with media type `application/vnd.lloom.client-integrations+json;version=1`. It includes the provider ID, gateway origin, OpenAI `/v1` base URL, Anthropic origin, auth style, supported protocols, concrete endpoint URLs, exact model IDs, modalities, and client artifact hints.

Generated copies are written to `clients/generated/lloom-integrations.json` and `~/.lloom/integrations/lloom-integrations.json`. Committed examples can be refreshed with `npm run generate:clients -- --examples`.

`/gateway/integrations/status` and `lloom integrations <client>` return an install-status report for generated/native files. Each artifact is marked `current`, `missing`, `drifted`, or `unavailable`, with target/generated file paths and a summary count. Use this before rewriting client files from a UI or installer:

```zsh
lloom integrations omp
lloom integrations codex --home "$HOME" --generated-root clients/generated
```

Client integration generation is setup-aware: it can list advertised configured models before their runtimes are started. The serving API remains operational: `/v1/models` and request routing only expose models whose configured runtimes are available.

## OMP

Generate:

```zsh
npm run generate:clients
lloom integrations
```

Install the generated model catalog and role config:

```zsh
cp clients/generated/omp-models.yml ~/.omp/agent/models.yml
cp clients/generated/omp-config.yml ~/.omp/agent/config.yml
```

The generated role config points OMP at the exact model IDs from that file. By default LLooM uses the fastest observed model from the selected recipe:

```yaml
modelRoles:
  default: local-llm/Youssofal/Qwen3.6-35B-A3B-MTPLX-Optimized-Speed-FP16:low
```

Apply directly after reviewing the plan:

```zsh
lloom integrate omp
lloom integrate omp --apply --yes
```

## OpenCode

Merge `clients/generated/opencode.json` into your OpenCode config or start from it directly. The generated provider disables client-side timeouts because local cold starts and long-prefill requests can legitimately exceed hosted-model defaults.

LLooM writes the native OpenCode config and a managed launcher with:

```zsh
lloom integrate opencode --apply --yes
```

The native config target is `~/.config/opencode/opencode.json`; existing drifted files are backed up before rewrite. The launcher is written to `~/.lloom/bin/lloom-opencode`.

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
lloom integrate codex --apply --yes
lloom integrate claude --apply --yes
lloom integrate hermes --apply --yes
lloom integrate zero --apply --yes
```

These profiles export `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`; the Claude-compatible profile also exports Anthropic-compatible variables. The launchers source the matching profile and then execute `codex`, `claude`, `hermes`, or `zero`.

OpenAI-compatible profiles use `OPENAI_BASE_URL=http://127.0.0.1:8100/v1`. Claude/Anthropic-compatible profiles use `ANTHROPIC_BASE_URL=http://127.0.0.1:8100`, because Anthropic clients normally append `/v1/messages` themselves.

OMP profiles advertise streaming usage support because LLooM requests upstream `stream_options.include_usage`, preserves usage chunks from OpenAI-compatible SSE streams, and translates final usage into the `/v1/responses` and `/v1/messages` stream endings.

```zsh
export PATH="$HOME/.lloom/bin:$PATH"
lloom-codex --help
lloom-claude --help
lloom-opencode --help
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
3. `lloom up --go` starts the local OpenAI/Anthropic bridge in the background after setup. Use `lloom serve --config ~/.lloom/config.json` only when you want the gateway in the foreground for debugging.
4. `lloom keep-warm --config ~/.lloom/config.json` or `lloom setup --apply --yes --start` when you want the selected keep-warm runtime launched immediately.

The same registry powers `/v1/models`, OMP YAML, OMP role config, and OpenCode JSON, so clients should discover or generate from LLooM instead of carrying stale model IDs.
