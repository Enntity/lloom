# Supervised DeepSeek workers through LLooM

A Codex CLI worker can use DeepSeek V4.1 Flash through LLooM's Responses bridge.
The client model ID in the qualified lane is `deepseek-flash`; its backend uses
DeepSeek's external Chat Completions API. This does not load weights on a Spark.

## Protocol contract

- Developer messages map to system messages for Chat backends, retaining their
  instruction role and order rather than turning them into user input.
- Responses custom tools become Chat function tools with a required string
  `input` field. Buffered and streamed results return native `custom_tool_call`
  items, and custom tool outputs replay as Chat tool results.
- Custom inputs are buffered until their JSON wrapper is complete. The bridge
  then emits decoded `response.custom_tool_call_input.delta` and `.done` events.
  The caller never receives JSON wrapper fragments as free-form input.
- Custom grammar definitions are included as instructions to the backend; this
  is not constrained grammar decoding. The tool executor must validate inputs.
- For a backend with `toolChoiceRequiresNonThinking: true`, forced tools disable
  thinking. A tool turn with missing reasoning history remains non-thinking;
  a new user turn permits thinking again. The bridge does not invent reasoning.
- Output-cap truncation ends with `response.incomplete` without completing a
  custom tool call. Malformed completed custom input is an upstream error.
- Usage includes `cached_tokens` and `reasoning_tokens`, defaulting to zero when
  the upstream omits those counters. Such zeroes mean no reported count, not
  proof that no reasoning or caching occurred.

The bridge is stateless: clients replay conversation items. This does not add
`previous_response_id` storage, hosted tools, or full Responses API parity.

## Worker configuration

Use a gateway containing these changes. Set `LLOOM_BASE_URL` to its authenticated
API base URL (ending in `/v1`) and supply its inference key as `LLOOM_API_KEY` in
the environment. Do not put keys in command arguments or config files.

The example catalog declares DeepSeek's identity and tool metadata, avoiding
Codex's unknown-model fallback and its attempt to interpret the standard
OpenAI `/models` list as Codex's proprietary model catalog. Its context window
is catalog metadata, not a long-context worker qualification.

From the LLooM checkout, run a bounded worker as follows. Replace `/path/to/task`
and the prompt with the assigned scope:

```sh
codex exec --ignore-user-config --ephemeral --skip-git-repo-check \
  -C /path/to/task -s workspace-write -m deepseek-flash \
  -c "model_catalog_json=\"$(pwd)/clients/examples/codex-deepseek-models.json\"" \
  -c 'model_provider="lloom"' \
  -c 'model_providers.lloom.name="LLooM"' \
  -c "model_providers.lloom.base_url=\"$LLOOM_BASE_URL\"" \
  -c 'model_providers.lloom.wire_api="responses"' \
  -c 'model_providers.lloom.env_key="LLOOM_API_KEY"' \
  -c 'model_providers.lloom.requires_openai_auth=false' \
  -c 'model_reasoning_effort="high"' \
  -c 'features.multi_agent=false' -c 'features.memories=false' \
  --json 'Complete only the assigned task; verify it with tools and report evidence.'
```

The parent owns task selection, independent verification, and accepting changes.
The worker retains Codex's sandbox. This command does not change global Codex
settings or the parent's model. Use read-only sandboxing for inspection tasks.

## Qualification: 2026-09-11

Tested with Codex CLI 0.153.4 against an isolated loopback LLooM gateway with only
the existing external DeepSeek backend, no runtimes, and no fallback members.
The main gateway and resident workloads were not restarted or reconfigured.

1. The first worker read a synthetic file, applied a patch, and read the result,
   but completion retries exposed the missing `reasoning_tokens` usage field.
2. After fixing usage, a fresh worker completed shell read, free-form
   `apply_patch`, shell verification, and final response without reconnects.
3. A catalog-backed read-only worker completed with no unknown-model warning.
4. A forced custom-tool call followed by its result returned `FIXED_TOOL_OK`,
   fixing the previously observed missing-reasoning HTTP 400.
5. Gateway metrics attributed all successful patched requests to
   `deepseek-flash` / `openai-compatible-deepseek-flash`, with no failover.

A separate native-delegation canary placed a named DeepSeek agent in a temporary
project's `.codex/agents` directory. The parent reported that the configured
agent was not available through its exposed tools and stopped without reading
the marker itself. This establishes the supervised CLI worker path, **not**
working cross-provider native subagent selection in that build or this desktop
session. The Harness SDK remains an alternative if process supervision is not
sufficient.

Regression coverage lives in `test/responses-codex.test.mjs`, alongside the
existing protocol and stream suites. Server resilience, security, interchange,
and package install smoke checks also passed. This is a short tool-use canary,
not research-quality, endurance, or long-context qualification.

## Supervised project assignments

After the user explicitly approved private Atlas context sharing, real project
assignments exercised this lane. Small source-to-code and documentation tasks
completed, but broad exploration repeatedly exceeded its useful tool budget.
Parent review caught incorrect CUDA buffer destinations, synchronization and
bootstrap code, and research claims unsupported by the profiler. A successful
Responses exchange does not establish the quality of the resulting work.

Keep assignments bounded by exact files, expected artifacts and acceptance gates.
Use absolute final-output paths for CLI workers. Enforce time/tool limits in the
parent rather than trusting prompt limits. Tool-free, non-thinking calls worked
well for small transformations and notes; always validate their output before
execution. A reasoning-heavy call exhausted its output allowance without an answer.

For reusable DS/GLM profiles, bounded retries, resource locks and compact reports,
use the [research worker supervisor](research-workers.md).
