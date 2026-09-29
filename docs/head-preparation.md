# Prepare a gateway to become the fleet head

`lloom cluster prepare-head` copies external model mappings into an existing gateway. It preserves that gateway's local models, runtimes, aliases, defaults, profiles, residency, authentication, listeners, and cluster ownership. Preparation does not switch clients or promote distributed-runtime ownership.

Preview a transfer from another host:

```sh
lloom cluster prepare-head --from-ssh source-host --target-ssh media-host --include-secrets --json
```

Both hosts must already be trusted by the operator's SSH client. The source needs Node.js and a configuration at `~/.lloom/config.json`; it needs no new LLooM installation. The target needs this command installed under `~/.local/lib/node_modules/lloom`. The operator connects to each host directly. The source host is read only, and no host-to-host SSH trust is required.

Review added/skipped IDs, conflicts, unresolved credential names, and `destinationHash`. Apply the reviewed destination version:

```sh
lloom cluster prepare-head --from-ssh source-host --target-ssh media-host \
  --include-secrets --expect-destination <destinationHash> --apply --yes --json
```

A local source file uses `--from source.json`; `--from -` reads bounded JSON from stdin. Local operations honor `--config`. SSH source and target use their standard installed configuration paths. The command returns JSON in every mode so a future head-promotion workflow can consume the same report.

Only models whose complete backend targets are external HTTPS endpoints qualify. Runtime-backed, node-bound, federated, private-address and mixed local/cloud target models are excluded. Public hostname syntax is checked; this is classification, not DNS verification or an SSRF sandbox. Models and backends with conflicting IDs block apply. Existing aliases are preserved. New aliases require all normal, optional, fallback and saved-route dependencies to resolve; incomplete aliases are reported and skipped. Defaults and model IDs are not rewritten.

Without `--include-secrets`, required environment credentials must already be available to the destination process. With the flag, the SSH source resolves backend `apiKeyEnv` references from its managed service environment and transfers provider keys through encrypted SSH stdin. Imported keys are stored inline in the target's private configuration; no global environment file is edited. Reports contain no key values. Credentials in command arguments, URL userinfo/query strings, and public recipe exports are not supported. Apply refuses a destination config readable by other users, writes a private backup, validates the composed config, and atomically replaces the destination. A destination hash guards against changes since review. Concurrent changes during apply are rejected by the configuration mutation store; it does not provide a distributed lock.

The gateway's existing config watcher activates added routes. Any required provider adapter must be installed before that route can serve traffic. To restart an updated Linux systemd installation:

```sh
lloom service restart
lloom service restart --apply --yes --drain-timeout-ms 300000
```

Restart verifies the owner gateway identity and active local user service, temporarily gates inference, waits for the gateway to acknowledge the gate and finish all tracked requests, then restarts `lloom.service`. Model processes are retained by the gateway's normal shutdown path. The prior inference setting is restored on success or ordinary failure. A hard kill or host power loss can leave the gate closed; inspect and recover before retrying. This command does not manage OS-level socket proxies or modify other nodes.

Preparing mappings is one phase of head promotion. Endpoint/relay cutover, fleet-wide profile coordination and distributed lifecycle ownership transfer remain separate operations. The pure `mergeExternalModels` planner and `applyHeadPreparation` apply function are reusable without SSH or CLI dependencies; HTTP/UI callers must supply their own authorization boundary.

On macOS, the same drain command supports a running user LaunchAgent with
`KeepAlive=true`. Select its label and exact configuration explicitly:

```sh
lloom service restart --label com.lloom.gateway --config /path/to/config.json --apply --yes
```

LLooM checks the LaunchAgent's configuration path and running PID, sends SIGTERM,
then waits for launchd to start a different process and restore service. It
preserves the previous inference-admission setting.

Existing systemd socket proxies can be pointed at the local gateway with
`lloom service relay --unit model-gateway`. The preview checks the direct
node identity and returns a unit hash. Apply the reviewed unit with
`--expect-unit HASH --apply --yes` from an administrator-authenticated terminal.
The target is the selected configuration's explicit local network interface;
loopback and wildcard destinations are refused. LLooM retains the original unit
and writes an override, restoring the previous override on ordinary failure.
Coordinate and drain consumers before this endpoint cutover; the proxy restart
can close existing TCP connections. This command does not move model processes.

To update an existing client endpoint while preserving its model choices and
credentials, use:

```sh
lloom integrate retarget --file /path/to/client.yml \
  --from-url http://old-head:8100 --to-url http://new-head:8100
```

Apply the returned file hash with `--expect-file HASH --apply --yes`. JSON,
YAML, TOML and env files are supported. A private backup is retained, endpoint
suffixes such as `/v1` are preserved, and symlinks or changed files are refused.
JSON values are matched by exact origin; textual formats only change recognized
endpoint assignment lines. Running clients may need to reload their settings.
