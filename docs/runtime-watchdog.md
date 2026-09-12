# Request watchdog configuration

Configure the watchdog per managed runtime. Gateway-visible silence is a recovery
signal, not proof that the engine is dead: prefill, reasoning and contention can
all delay output. Start unfamiliar models in observe mode and measure their real
workloads before enabling automatic restart.

```json
{
  "watchdog": {
    "enabled": true,
    "action": "observe",
    "firstContentTimeoutMs": 1800000,
    "idleContentTimeoutMs": 180000,
    "failureThreshold": 2,
    "failureWindowMs": 3600000,
    "cooldownMs": 1800000,
    "drainTimeoutMs": 30000,
    "restartWithActiveRequests": false,
    "failureStatuses": [502, 504]
  }
}
```

These times illustrate a long-prefill model; they are not measured SparkGLM
recommendations. The first-content budget begins after loading and admission.
Once streaming content arrives, the idle budget measures silence since the last
progress. Buffered responses cannot expose that progress and do not arm the
streaming timer. These settings do not change client or upstream HTTP timeouts.

`action: "observe"` records failures without pausing admission or restarting.
`action: "restart"` uses the failure threshold, window and cooldown. If requests
remain active after draining, recovery is deferred and admission resumes. Setting
`restartWithActiveRequests: true` explicitly permits interrupting those requests.
A policy changed to disabled or observe while draining also cancels recovery, as
does a successful request or completed request with response content during the
recovery attempt.
Deferred attempts do not count as completed restarts; the cooldown still limits
repeat attempts. No deferred restart is scheduled for later automatically.

The watchdog remains disabled by default. For existing enabled configurations,
action defaults to restart and both phase budgets fall back to `minNoProgressMs`
(default 120000). Forced restart with active requests now requires explicit opt-in.
The policy does not automatically learn deadlines or inspect GPU progress.
