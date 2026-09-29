# Head preparation qualification

An existing standalone media gateway imported 13 external models, 12 provider backends and 17 complete aliases through `lloom cluster prepare-head`. The source gateway was read only. No other node was reconfigured, and the fleet endpoint, loopback relay and distributed lifecycle owner stayed unchanged.

The target kept all 27 original model definitions and all 28 runtime definitions. Every original top-level configuration section outside the additive model/backend/alias maps matched its pre-import snapshot. Every existing entry in those three maps also matched. Standalone defaults and saved profile files were retained. A repeated import reported no changes.

The installed target needed the cloud music adapter before the imported music route could serve. That adapter and the new CLI modules were deployed additively, preserving the target's other installed features. `lloom service restart` gated inference, drained tracked requests, restarted the local gateway service, and restored the previous inference setting without stopping model processes.

Direct target-gateway canaries passed for DeepSeek chat, OpenRouter chat, cloud embeddings, the model-omitted standalone embedding default, and cloud music. Music returned a valid RIFF WAV. These are routing and artifact smoke checks, not quality or throughput benchmarks; each latency records one request. Individual cloud image/video models were imported and their routes resolved, but no billable image/video generation was run for this qualification.

Validation includes planner/credential preservation tests, SSH transport guards, service drain/failure recovery tests, audio adapter and gateway tests, source checks, interchange validation and package installation smoke. Public evidence contains no credentials, host addresses, local paths or generated media.
