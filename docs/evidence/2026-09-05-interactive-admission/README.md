# Interactive runtime admission

Local candidate, September 5, 2026. No deployment, live configuration edit,
runtime restart, embedding model change, or entity-state mutation.

## Behavior and evidence

`RuntimeManager` accepts an explicit interactive request class. Requests remain
FIFO within each class; after four interactive admissions, eligible queued
standard work gets a turn. Optional execution and queue reservations keep
background work from consuming all gateway capacity. Defaults reserve nothing;
limits clamp to leave standard capacity. Existing active requests are never
preempted. Reservations survive recipe materialization, including the logical
distributed runtime configuration, and can change without a restart.

- `baseline.tap`: the new ordering fixture fails against LLooM HEAD's FIFO
  scheduler. Background requests a and b precede all five interactive requests.
- `candidate.tap`: twelve queue tests pass, covering overtaking with bounded
  fairness, reservations, queue overflow, cancellation, failure, idempotent
  release, pause/resume and live reconfiguration. The HTTP embedding fixture
  runs the real gateway and scheduler against a synthetic healthy backend:
  interactive recall completes while an older standard request stays queued.
  Completed metrics preserve class and slot queue wait; no priority header is
  sent to the backend. Lifecycle health is explicitly stubbed in this fixture.
The public evidence includes the synthetic LLooM fixtures and source hashes.
Private Runtime test reports and machine-local logs are retained separately.
The subsequent federation work is documented in
[the federation evidence](../2026-09-05-federated-priority/README.md).

## Boundaries still open

This proves gateway scheduling behavior, not real GPU latency or native-client
response time. A reserved gateway slot does not reserve backend GPU compute and
cannot interrupt an active prefill. Unmanaged cloud routes have no local slot
queue. The subsequent federation change forwards priority through authenticated gateway hops. Runtime recall
still lacks an explicit query deadline and caller-cancellation propagation.
Provider isolation, embedding-space equivalence before any cloud fallback,
live corpus timing, full-context writer quality, and real macOS/iOS/CLI voice
and avatar acceptance remain required for the interactive experience goal.
