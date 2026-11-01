# Session and resource backplane migration

Accord owns portable coordination: stable session records, observed state and its
provenance, bounded redacted activity, search, summaries, jobs, messages, questions,
reservations and overseer incidents. Observations, authenticated agent identity,
and resource ownership remain separate facts.

Tessera owns native interaction: terminals and PTYs, windows, layout, transcripts
as rendered views, permission prompts, notifications, phone presentation, and
approved terminal delivery. Its adapter publishes evidence and consumes Accord's
session/search/summary/incident APIs. Connected send/ask paths use Accord; a
configured but unavailable Accord fails explicitly rather than creating a second
message authority. Native launch/resume and board-level briefs stay in Tessera.

LLooM owns model admission, draining, routing, health checks and exact restoration.
Shrug owns its catalog, plans, downloads, containers, verification and gateway.
Accord coordinates access; product adapters perform and confirm product-specific
effects. An existing manager remains the sole resource authority until migration;
no second cooperative lock can silently supersede it.

## Qualified in this change

- Durable session observations, redacted bounded history, search and summaries.
- Separate heartbeats from progress; working/waiting/done/privacy states.
- Portable Codex/Claude discovery, native Tessera publication and product status adapters.
- Durable overseer incidents with evidence, cooldown, snooze and resolution.
- Stale-work, held-idle-resource and extensible external-observation rules.
- Durable messaging and native delivery deduplication; no guessed recipient or heuristic resource release.
- Shared jobs and operator questions, with standalone UI and Tessera bridge paths.
- LLooM compatibility authority with durable request IDs and absolute renewal deadlines.
- Compact bootstrap, native inbox identity binding and a bounded lease client helper.
- Fixture migration, privacy, restart, cross-host messaging and process recovery.
- Installed local service upgrade and two fresh MCP protocol-client qualification.
- Durable ordinary sessions, bounded bootstrap previews, internal-harness filtering,
  dispatch-time monitoring checks, and active-work rather than lifetime journal limits.

See [SESSION-BACKPLANE.md](SESSION-BACKPLANE.md) for methods and configuration.
Credential-free receipts are in `evidence/qualification.json`,
`evidence/lloom-bridge.json`, `evidence/installed-migration.json`, and
`evidence/installed-backplane.json`.

## Before deleting the old product implementations

The local Accord service and Codex/Claude installer hooks are upgraded to
0.4.0-preview.1. The existing Tessera app and live LLooM gateway were not restarted
or replaced. Their source integrations are staged and tested. There are no
configured live LLooM manager mappings, Shrug observers, summary-model endpoints,
or four-Spark hardware policies in the upgraded local installation.

Remaining cutover gates:

1. Install the Tessera candidate at a safe native-session boundary and verify its
   actual board, message approval and question UX against Accord. Keep native
   transcript adapters for harnesses that do not yet have a portable parser.
2. Deploy the compatible LLooM scheduler under its normal workload rules; configure
   Accord's manager mapping and verify real drain/restore on an explicitly reserved
   resource. Fixture actions are not a live model restoration proof.
3. Upgrade/link the desired host daemons, map telemetry authorities to the existing
   pools, and enable hardware policies only with verified ownership mappings.
4. A Shrug container lifecycle driver must confirm persistent containers stop before
   handing off ownership. The current Shrug adapter is observation-only.
5. Test model-driven Codex/Claude wake-and-response behavior and additional target
   platforms. Fresh MCP protocol clients prove connectivity, not model compliance.

No existing scheduled automation was changed. The screenshot supplied an example
policy; built-in monitoring does not release resources merely because utilization
is low or a session is quiet.
