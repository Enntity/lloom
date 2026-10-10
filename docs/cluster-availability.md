# Serving during a member control outage

A distributed runtime with a configured logical health endpoint exposes `servingHealthy`
separately from `controlHealthy`. A healthy endpoint remains available when a member control
gateway is unreachable; its `availabilityState` becomes `management-degraded`. Requests use
the already-serving path without attempting a new allocation or remote lifecycle operation.

A failed logical health probe is authoritative. Healthy member telemetry cannot override it.
Owned local Docker members must also be running, so a different allocation sharing the same
port cannot impersonate a stopped runtime. Older groups without a logical health endpoint
retain member-based aggregate health.

Start operations that actually mutate the runtime, stop, and changed-runtime reconfiguration
require fresh control reachability for every remote member before proceeding. Ordinary start
of an already healthy runtime returns `already-healthy` without a lifecycle mutation.

Regression coverage uses local HTTP serving and member-control fixtures, including disconnect,
recovery, unhealthy serving, and rejected lifecycle operations. This is not evidence of a live
GPU or distributed-model failure-injection deployment.
