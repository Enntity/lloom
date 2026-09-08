# Locally built SparkGLM under LLooM

`backends/sparkglm` manages immutable locally built SparkGLM images on two
DGX Sparks. It preserves worker-first admission, readiness, stop and routing;
no independent Docker restart policy is enabled. See its README and the
SparkGLM public installer for pinned NVFP4 and EXL3 configurations.

Cold long-context inference can exceed Undici's five-minute transport idle
deadline. Chat forwarding now uses the existing extended 30-minute dispatcher.
Configured backend deadlines, caller cancellation, stream-progress guards,
and explicit dispatcher overrides still apply. The regression covers delayed
headers, delayed streaming bodies, and buffered responses with a deliberately
short default transport deadline. This changes no model or alias by itself.
