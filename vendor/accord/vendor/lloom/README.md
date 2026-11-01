`host-memory.mjs` is copied unchanged from LLooM commit
`bcce316ec28293e5581f4b7e1d4ebea214e862d2`, under the included MIT license.

The NVIDIA query/field shape, CPU delta sampling, and in-memory single-flight cache
in Accord's telemetry collector are adapted from that revision's
`src/server.mjs:createHostTelemetry`. Hardware identity conventions are adapted
from its `src/machine-profile.mjs`. No LLooM process, model, or runtime dependency
is required. Preserve units and available-memory semantics when changing adapters.
