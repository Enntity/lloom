# Accord integration qualification

LLooM uses Accord for agent sessions, messages, search/summaries, jobs, reservations and machine telemetry. Its old scheduler and coordination skill are removed. Both products contain the same qualified Accord package and reuse the installed host identity.

The local integration tests kill the coordinator and the LLooM gateway separately. A real supervised CPU workload survives the gateway crash. The queued agent cannot run while the provider is down, while stop fails, or while restoration is unconfirmed. Recovery stops the old workload before granting a new generation; a stale start is rejected. Deployment fences prevent resource effects during deployment. Prior suspension state and route restoration are preserved. Old active leases remain held regardless of timestamp.

`ssh-recovery.json` records the same loop between a Mac agent and a temporary Linux ARM64 host reached through bidirectional SSH forwards. Discovery, messages, jobs, live telemetry and a remote reservation passed. Killing the remote gateway left its workload alive; restarting the gateway stopped it before the next agent received ownership. The fixture used no GPU or production model and was removed afterward.

`installed-local.json` records both local gateways using the existing Accord authority, with unchanged configuration and runtime contracts. The previous model supervisor PID stayed alive and its endpoint stayed healthy. LLooM observes that preexisting process as external after restart; the recovery tests separately verify stopping a surviving workload. Tessera restored all 13 native tiles, published fresh Accord observations, and displayed all four remote machine readings.

The production Spark reservation head has **not** been cut over. Its legacy pair lease is still active, and its systemd unit uses the default control-group shutdown behavior. Complete the old holder's verified stop/release and qualify a gateway-only service replacement before updating that head. Do not infer that an expired lease is free, remove its state, or restart its model process group.

The full LLooM suite is not green: one rate-limit HTTP burst test also fails on unchanged `bcce316`. The other test groups were exercised independently, and the migration-specific tests, syntax, lint, format, interchange, smoke and packaged installation passed. `qualification.json` records this limit explicitly.
