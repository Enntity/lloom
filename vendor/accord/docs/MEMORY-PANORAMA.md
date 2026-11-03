# Memory panorama

The panorama makes every agent's learned facts discoverable to every other agent
without changing how any harness stores or writes memory. Each harness keeps its
native memory store; Accord indexes it read-only and answers queries across linked
hosts. Nothing migrates, nothing is rewritten, no harness behavior changes.

## Principles

- **Native stores stay native.** Accord never writes to a harness's memory. The
  harness's own curation (deliberate files, async summarization) remains the only
  quality filter. A memory entry is an observation, like a session summary.
- **Read-only federation.** Each host indexes only its own local stores. Queries
  fan out to linked hosts on demand, exactly like `accord_find`. There is no
  replicated memory state, no sync protocol, no new daemon.
- **Descriptions cross hosts; bodies stay home.** Only the index entry (name,
  description, type, source, hash) is served remotely, and a host checks and caps
  each entry a peer returns before an agent sees it. A body is fetched only by
  explicit `accord_recall_read` against the owning host, bounded and redacted.
- **Untrusted with provenance.** A memory entry is untrusted data, like a peer
  message. Every hit carries its source: host, harness, participant label, path,
  and last-updated. Entries never grant authority, and they never override
  `AGENTS.md`, which remains the only user-authored instruction layer.
- **Almost no tokens.** The tool is not in the daily tool list; it is reached via
  `accord_more`. Search results are capped lines, not dumps. The join digest is
  capped and skippable.
- **Off until you turn it on.** Memory files can hold free-text secrets that no
  redaction reliably catches, so a host indexes nothing until its operator starts
  Accord with `ACCORD_MEMORY=on`. Turning it off again clears the index.

## Format contract

An adapter publishes index entries with this fixed shape (`accord.memory-index/v1`):

```json
{
  "id": "sha256(source.path + name)",
  "name": "gateway-on-main",
  "type": "project",
  "description": "The model gateway serves the main branch; the old canary is retired",
  "updated": "2026-11-02T15:20:00Z",
  "hash": "sha256 of the file body",
  "source": {"host": "…", "harness": "zcode", "label": "Reviewer", "path": "…/memory/gateway-on-main.md"},
  "scope": "shared"
}
```

Constraints: `description` is at most 200 characters (adapters truncate); `type`
is a free string (user, feedback, project, reference by convention); `name` is a
slug. `scope` is `shared` or `private` — `private` entries are never indexed, never
published, and are invisible to the panorama. `AGENTS.md` and other instruction
files are indexed as `type: "authority"` and flagged as user-authored in results.

## Adapters

Each harness gets one adapter, ~50 lines each, run inside the existing Accord
service on a slow poll (30 s) with hash-based change detection:

| Adapter | Store | Notes |
| --- | --- | --- |
| `zcode` | `~/.enntity-zcode/cli/memories/projects/<proj>/memory/` + `MEMORY.md` | plain markdown, frontmatter |
| `claude` | `~/.claude/projects/<project>/memory/` only, never the transcripts and tool output beside it | same shape |
| `codex` | `~/.codex/memories/` | summarized entries; hash the file, index the summary line |
| `agents-md` | `AGENTS.md` in known project roots | `type: authority` |

Adapter rules:

1. **Allowlist paths.** Only configured roots are indexed; everything else is
   invisible. Symlinks are refused. Bodies are never read for indexing beyond the
   frontmatter and first description line.
2. **Isolation.** An `AGENTS.md` root without the file is skipped, and so is a
   single file Accord refuses (a link, an unusable name) while the rest of its
   source stays current. Only configured sources are served; one taken out of
   `ACCORD_MEMORY_SOURCES` is cleared at the next start. A store that
   disappears, is unreadable, or exceeds size caps
   (per source: 2,000 entries) produces a `stale` marker on its entries, not a
   crash. One bad harness cannot degrade the panorama.
3. **No secrets.** Paths containing credential patterns (`.ssh`, `*.pem`, token
   files) are refused. Adapter output is descriptions only; the body fetch is the
   only path that returns content, and it is capped and refusable.

## Tools

One new extra tool and one board view. The daily tool list is unchanged.

- `accord_recall` — search memory entries on this host and linked hosts.
  `schema({query:string, host:string, limit:{type:'integer',maximum:20}})`.
  Returns capped index lines with provenance. Idempotent, read-only.
- `accord_recall_read` — fetch one entry body from its owning host, capped
  (16 KiB), redacted like `accord_session_read`. Refused for `authority` type
  (read the file yourself) and for entries whose source no longer matches.
- **Join digest.** The bootstrap reply gains a `learnings` section: the 5 newest
  shared entries, one line each, totaling under 1 KiB. Capped by the existing
  4 KiB bootstrap limit; omitted entirely if the adapter is disabled.
- **Board.** The memory view lists entries by source with staleness (never
  updated in N days), duplicates, and cross-source contradictions — flagged, not
  merged.

## Trust and scope

- Results are labeled: `Reviewer (codex, build-host) · project · 2d ago`. They are
  information, not instruction. This matches the existing rule that peer messages
  are untrusted data.
- `private` scope is enforced at the adapter: private entries never appear in any
  index, never cross a host link, and are invisible even on their own host except
  through the harness's own UI. Delegated workers see only what the operator's
  path allowlist permits.
- No entry is ever auto-injected into a prompt beyond the optional join digest.
  Everything else is pull-based: an agent that wants collective knowledge calls
  `accord_recall`.

## Bulletproofing

- **Idempotent indexing.** Entries are keyed by content hash; re-indexing is a
  no-op unless the hash changed. Stale entries carry `stale: true` rather than
  being deleted, so a transient I/O error cannot erase collective knowledge.
- **Caps everywhere.** 200-char descriptions, 2,000 entries per source, 20 per
  query, 16 KiB per body, 5 digest lines. The panorama adds no unbounded state.
- **Failure containment.** Adapters run independently; a failed adapter marks its
  entries stale. Cross-host queries degrade to local-only when a peer is offline.
- **No writes, ever.** The service holds read-only handles. If a store file is
  locked by its harness, adapters skip the mtime check that round and retry.

## Status

Shipped: the `zcode`, `claude`, `codex` and `agents-md` adapters, `accord_recall`,
`accord_recall_read`, cross-host recall over linked hosts that share sessions, and
the join digest behind `ACCORD_MEMORY_LEARNINGS=on`. Not built: a shared scratch
store for facts that are genuinely cross-agent, written through Accord
reservations. That waits until the read-only panorama proves insufficient.

Out of scope, deliberately: vector retrieval (fused keyword + frontmatter match is
enough at this scale), auto-harvesting transcripts into memory, cross-store merging
or dedup beyond flagging, and any write path into native stores.
