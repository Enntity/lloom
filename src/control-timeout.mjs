const DEFAULT_CONTROL_TIMEOUT_MS = 1800000;
const CONTROL_TIMEOUT_SLACK_MS = 60000;

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function runtimeControlTimeoutMs(
  config,
  runtimeId,
  { minimumMs = DEFAULT_CONTROL_TIMEOUT_MS, slackMs = CONTROL_TIMEOUT_SLACK_MS } = {}
) {
  const minimum = positiveFinite(minimumMs) ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const slack = Math.max(0, positiveFinite(slackMs) ?? CONTROL_TIMEOUT_SLACK_MS);
  const startup = positiveFinite(config?.runtimes?.[runtimeId]?.startupTimeoutMs);
  return startup == null ? minimum : Math.max(minimum, startup + slack);
}
