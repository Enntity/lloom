# DS4FV upstream refresh: dfa4a92

This pack adapts MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark at
`dfa4a92fcf10f19349fb65a608e476db5c0369d1` to LLooM's existing managed launcher.
The Anemll image and official Vision-Exp checkpoint remain pinned in the manifest.

Upstream patch and fixture files are copied without changes. LLooM's
`apply-runtime.sh` and `launch-options.sh` adapt the launch integration.
The refresh includes the image-limit fix in the Vision processor and the
HF snapshot symlink fix in the optional issue144 preflight. The new C128A
metadata-local prefill conversion cache is available through
`DSPARK_ENABLE_C128A_PREFILL_CACHE=1`, with upstream's default `0` retained.
Its source checks, idempotence and drift rejection tests are included.

The upstream's optional runtime ablation path is not selected by this managed
recipe. Official weights, normal decoding behavior, current speculation,
context and admission defaults are retained. The pack is not an assertion
that every optional upstream configuration is supported by LLooM.

Version 6 and its previous pack remain available for rollback. Package tests
validate artifact hashes and upstream transform behavior; hardware comparison
receipts are tracked separately in the private SparkGLM research workspace.
