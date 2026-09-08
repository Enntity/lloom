# Long cold-prefill transport

A backend's overall `timeoutMs` does not override Undici's independent HTTP
headers/body idle deadlines. A streamed GLM request with a 523264-token cold
prompt reached the gateway's default transport deadline after 301.6 seconds,
returning an SSE `server_error` (`terminated`) without a first token. The
GPU recorded no preemptions.

`fetchUpstream` now defaults to the existing 30-minute extended dispatcher,
previously explicitly selected only by media callers. Backend overall deadlines,
explicit stream-progress deadlines, cancellation, and explicit dispatcher
arguments remain in effect. This allows cold prefill to remain silent longer
than five minutes without silently extending a shorter configured deadline.

`node test/long-prefill-transport.test.mjs` uses a deliberately short global
transport deadline and a delayed upstream to cover both response headers and
the stream body in seconds. It fails without the dispatcher default and passes
with it. The existing server-resilience suite covers stream-progress timeout and
error handling.

Operationally, route-member suspension and runtime keep-warm are independent.
Before restarting a gateway during a GPU takeover, temporarily disable the
resident runtime's keep-warm setting as well as suspending its alias member.
Restore the original setting after the test window. Otherwise startup admission
can reload the resident runtime and evict the experimental model even while the
resident member is suspended in its alias.

The runtime watchdog is a separate deadline. A near-1M cold prefill was still
progressing without GPU preemption when the inherited 600000 ms no-output
watchdog requested a restart and then expired its 30-second drain. Explicit
SparkGLM contexts above 524288 now use 1800000 ms while retaining watchdog
recovery. Context admission, exact token validation, HTTP transport, backend
overall timeout, and watchdog budget all need to agree.
