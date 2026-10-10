# Inference-only standby gateways

LLooM supports a deliberately limited standby role for a gateway that must
continue serving an already-running model when the client-facing primary is
unavailable. A standby has no lifecycle authority. It cannot start, stop,
warm, admit, evict, reconfigure, or bootstrap a runtime, and its role is fixed
for the lifetime of the process. Promotion is an operator-controlled process
restart; this feature does not provide distributed consensus or automatic
authority transfer.

A standby configuration contains only explicit OpenAI-compatible model
endpoints. Each model names an `openai` backend with a private or loopback
`baseUrl`, an explicit private or loopback `healthUrl`, and an
`upstreamModel`:

```json
{
  "server": { "role": "standby", "host": "127.0.0.1", "port": 8110 },
  "security": {
    "apiKeys": ["${LLOOM_STANDBY_INFERENCE_KEY}"],
    "adminApiKeys": ["${LLOOM_STANDBY_ADMIN_KEY}"]
  },
  "backends": {
    "existing-serving-endpoint": {
      "type": "openai",
      "baseUrl": "http://127.0.0.1:8201/v1",
      "healthUrl": "http://127.0.0.1:8201/health"
    }
  },
  "models": [
    {
      "id": "shared-chat",
      "kind": "chat",
      "backend": "existing-serving-endpoint",
      "upstreamModel": "provider/model"
    }
  ]
}
```

Before every inference request, the standby checks the configured health URL
and then fetches the backend `/models` catalog. It forwards inference only when
the exact configured `upstreamModel` is advertised. Checks are bounded,
non-redirecting, and do not expose upstream response text. A failed health
check or model identity check returns `503` without sending an inference
request. The status document reports `inferenceReady: false` until a recent
successful endpoint check; configured endpoints alone do not claim readiness.

Clients should use an ordered list of authenticated gateway URLs. Retry only a
new request at the next gateway when the prior attempt is known to have been
rejected before inference was accepted: a pre-connect failure before request
transmission, or a `503` received before an inference response or stream bytes
were accepted. A connection close after request transmission, or any response
whose upstream acceptance is ambiguous, must not be retried. Never retry an
active or ambiguous stream: it remains owned by the gateway that accepted it
and is never migrated to a standby. Keep backend ports private; clients use
the gateway inference routes.
The generated client integration document exposes this contract under
`gateway.failover`.

All reads remain authenticated according to the normal gateway policy. An
unauthenticated or invalid admin write receives `401`; a valid admin write on
a standby receives `403` with `standby_read_only`. Recovery starts the primary
with its original `primary` role and does not transfer authority through the
standby.
