/**
 * Translate LLooM's OpenAI-shaped reasoning effort into the controls exposed
 * by Qwen running behind vLLM.
 *
 * Qwen's chat template has a boolean thinking switch. vLLM additionally
 * supports `thinking_token_budget`, which is the missing graduated control.
 * Passing `reasoning_effort` through does not create that budget.
 */

export const QWEN_VLLM_THINKING_BUDGETS = Object.freeze({
  minimal: 256,
  low: 1024,
  medium: 4096,
  high: 16384,
  xhigh: 32768
});

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedEffort(body = {}) {
  const raw = body.reasoning_effort ?? (isObject(body.reasoning) ? body.reasoning.effort : undefined);
  if (raw == null) return null;
  const value = String(raw).trim().toLowerCase();
  return value || null;
}

function qwenVllmHints(resolved = {}) {
  const model = resolved.model ?? {};
  const backend = resolved.backend ?? {};
  const runtime = resolved.runtime ?? {};
  return [
    model.id,
    model.name,
    model.upstreamModel,
    model.backend,
    backend.id,
    backend.type,
    backend.name,
    runtime.adapter,
    runtime.recipe?.id,
    runtime.bootstrap?.image,
    ...(runtime.bootstrap?.command ?? [])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** True only for Qwen 3/3.5/3.6 served by a vLLM runtime. */
export function isQwenVllm(resolved = {}) {
  const hints = qwenVllmHints(resolved);
  return /qwen3(?:[._-]?(?:5|6))?/.test(hints) && /vllm/.test(hints);
}

function removeGatewayEffort(body) {
  const next = { ...body };
  delete next.reasoning_effort;
  if (isObject(next.reasoning) && Object.hasOwn(next.reasoning, 'effort')) {
    const { effort: _effort, ...rest } = next.reasoning;
    if (Object.keys(rest).length) next.reasoning = rest;
    else delete next.reasoning;
  }
  return next;
}

function applyChatTemplateBehaviorOverrides(body = {}, resolved = {}) {
  const configured = resolved.runtime?.behaviorOverrides?.chatTemplateKwargs;
  if (!isObject(configured) || !Object.keys(configured).length) return body;
  const requested = isObject(body.chat_template_kwargs) ? body.chat_template_kwargs : {};
  return {
    ...body,
    // Runtime values are profile defaults. An explicit caller value remains
    // authoritative so low-level tests and emergency overrides stay possible.
    chat_template_kwargs: { ...configured, ...requested }
  };
}

/**
 * Return the exact upstream request for the resolved backend.
 *
 * Explicit vLLM knobs are lower-level than the canonical effort abstraction
 * and always win: callers can supply `thinking_token_budget` or explicitly
 * set `chat_template_kwargs.enable_thinking`.
 */
export function translateReasoningEffortForBackend(body = {}, resolved = {}) {
  const profiledBody = applyChatTemplateBehaviorOverrides(body, resolved);
  const effort = normalizedEffort(profiledBody);
  if (!effort || !isQwenVllm(resolved)) return profiledBody;

  const next = removeGatewayEffort(profiledBody);
  const templateKwargs = isObject(profiledBody.chat_template_kwargs) ? profiledBody.chat_template_kwargs : {};
  const hasThinkingOverride = Object.hasOwn(templateKwargs, 'enable_thinking');
  const hasBudgetOverride = Object.hasOwn(profiledBody, 'thinking_token_budget');

  if (hasThinkingOverride && templateKwargs.enable_thinking === false) return next;

  if (effort === 'none') {
    if (hasThinkingOverride || hasBudgetOverride) return next;
    return {
      ...next,
      chat_template_kwargs: { ...templateKwargs, enable_thinking: false }
    };
  }

  // `auto` deliberately leaves Qwen/vLLM defaults alone. All other known
  // non-none tiers enable thinking and receive a deterministic native budget.
  if (effort === 'auto') return next;

  const budget = QWEN_VLLM_THINKING_BUDGETS[effort];
  const withThinking = hasThinkingOverride
    ? next
    : { ...next, chat_template_kwargs: { ...templateKwargs, enable_thinking: true } };
  return budget == null || hasBudgetOverride ? withThinking : { ...withThinking, thinking_token_budget: budget };
}
