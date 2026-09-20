# Runtime policy

Runtime policy controls predictive memory admission and managed-runtime
residency. `keepWarm` and `preferredWarm` are runtime-policy fields, not model
or alias fields.

Residency is declared per managed internal runtime, never on a `models[]` entry,
an alias, or the config root.

- `keepWarm: true` is a **hard pin**. A loaded pinned runtime is never evicted
  and cannot be displaced by ordinary admission.
- `preferredWarm: true` is a **soft tier**. A loaded preferred runtime stays
  evictable, but ordinary idle evictables are reclaimed first. When a preferred
  runtime is not loaded, boot and periodic reconciliation restore it when the
  configured memory budget allows.
- A runtime with neither flag is ordinary: it may be evicted under pressure and
  is only started by an explicit request.
- `keepWarm: true` and `preferredWarm: true` are mutually exclusive; keep-warm
  is the stronger claim.

The legacy `evictable` field (top-level or `policy.evictable`) still normalizes
to `keepWarm: true` when set to `false`, unchanged from earlier releases.

## Idle restoration

The preferred-restore pass starts after all owned, enabled keep-warm pins are
healthy and loaded. It then reconciles preferred runtimes under the normal
admission mutex. Spare capacity is used first. If the preferred baseline does
not fit, the pass may evict ordinary runtimes after `preferredWarmIdleMs` has
elapsed since each candidate last became idle. The default idle grace is
`30000` ms; set it to `0` for immediate reconciliation.

Restoration never evicts a keep-warm pin, an active or queued runtime, a
delegated-authority protected runtime, another preferred runtime, or a remotely
owned or maintenance-suspended runtime. Idle ordinary runtimes retain cached
state when everything already fits. If no safe eviction can create enough
capacity, the pass skips quietly and tries again later. Manual maintenance
suspension stops preferred restoration until the runtime is resumed.

## Eviction order

Under admission pressure, the planner prefers:

1. Idle ordinary evictables.
2. Older idle evictables within the same tier.
3. Lower `policy.priority` first among equally old candidates.

Because LRU ordering is preserved _within_ a tier, a merely high `policy.priority`
does not protect an old preferred runtime from a newer ordinary one. The tier,
not the priority value, is what keeps image-like runtimes resident.

## Example: pin essentials, prefer image, leave music/video on demand

```json
{
  "runtimePolicy": {
    "memoryBudgetGb": 96,
    "maxMemoryUtilization": 0.9,
    "autoEvict": true,
    "protectActiveRequests": true
  },
  "runtimes": {
    "embeddings": { "keepWarm": true },
    "tts": { "keepWarm": true },
    "stt": { "keepWarm": true },
    "image": { "preferredWarm": true },
    "music": {},
    "video": {}
  }
}
```

Embeddings, TTS, and STT are always pinned. Image is preferred: it survives
ordinary churn but yields to on-demand music or video under real memory
pressure, and returns later when memory frees up. Music and video are ordinary
on-demand runtimes.

## Observability and live toggling

`preferredWarm` is a live-admission field. Toggling it on a running runtime
updates status and admission rows without restarting the container. Runtime
status rows and policy plan rows both expose `preferredWarm`.

`POST /gateway/runtimes/keep-warm` returns `keepWarm` and `preferredWarm`
residency ID lists and runs a residency pass that starts hard pins first, then
preferred runtimes under the safe reconciliation rules. The gateway also
reconciles preferred residency periodically (default 30 seconds) so a preferred
runtime can return after on-demand work idles. The pass skips remotely owned or
maintenance-suspended runtimes and never overlaps itself.
