/** Shared OpenAI text, usage, and stream-chunk helpers. */

export function openAIChoiceText(choice) {
  const content = choice?.message?.content ?? choice?.text ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text ?? '')
      .filter(Boolean)
      .join('');
  }
  return '';
}

export function stringFromUnknown(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        const text = part?.text ?? part?.content ?? part?.reasoning ?? part?.reasoning_content ?? '';
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean)
      .join('');
  }
  if (value && typeof value === 'object') {
    const text = value.text ?? value.content ?? value.reasoning ?? value.reasoning_content ?? '';
    return typeof text === 'string' ? text : '';
  }
  return '';
}

export function openAIReasoningText(source = {}) {
  return stringFromUnknown(
    source.reasoning_content ?? source.reasoning_text ?? source.reasoning ?? source.thinking ?? ''
  );
}

export function openAIReasoningSummaryText(source = {}) {
  return stringFromUnknown(source.reasoning_summary ?? source.summary ?? source.reasoning?.summary ?? '');
}

export function openAIChoiceReasoning(choice = {}) {
  return openAIReasoningText(choice.message ?? choice.delta ?? choice);
}

export function openAIChoiceReasoningSummary(choice = {}) {
  return openAIReasoningSummaryText(choice.message ?? choice.delta ?? choice);
}

export function openAIChoiceReasoningSignature(choice = {}) {
  const source = choice.message ?? choice.delta ?? choice;
  return stringFromUnknown(source.reasoning_signature ?? source.signature ?? '');
}

export function responseUsageFromOpenAI(usage = {}) {
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage.total_tokens ?? inputTokens + outputTokens,
    input_tokens_details: usage.prompt_tokens_details ?? usage.input_tokens_details ?? {},
    output_tokens_details: usage.completion_tokens_details ?? usage.output_tokens_details ?? {}
  };
}

export function anthropicUsageFromOpenAI(usage = {}) {
  const normalized = responseUsageFromOpenAI(usage);
  return {
    input_tokens: normalized.input_tokens,
    output_tokens: normalized.output_tokens,
    ...(usage.cache_creation_input_tokens != null
      ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
      : {}),
    ...(usage.cache_read_input_tokens != null || normalized.input_tokens_details?.cached_tokens != null
      ? { cache_read_input_tokens: usage.cache_read_input_tokens ?? normalized.input_tokens_details.cached_tokens }
      : {})
  };
}

export function metricUsageFromOpenAI(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const hasInput = usage.prompt_tokens != null || usage.input_tokens != null;
  const hasOutput = usage.completion_tokens != null || usage.output_tokens != null;
  const hasTotal = usage.total_tokens != null;
  if (!hasInput && !hasOutput && !hasTotal) return null;
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: Number(usage.total_tokens ?? inputTokens + outputTokens)
  };
}

export function usageFromJsonText(text) {
  if (!text?.trim()) return null;
  try {
    return metricUsageFromOpenAI(JSON.parse(text).usage);
  } catch {
    return null;
  }
}

export function usageFromJsonBuffer(buffer, headers = {}) {
  const contentTypeValue = String(headers['content-type'] ?? '');
  if (!/json/i.test(contentTypeValue)) return null;
  return usageFromJsonText(buffer.toString('utf8'));
}
export function responseIncompleteDetails(finishReason) {
  if (finishReason === 'length') return { reason: 'max_output_tokens' };
  if (finishReason === 'content_filter') return { reason: 'content_filter' };
  return null;
}

export function responseStatusFromFinishReason(finishReason) {
  return responseIncompleteDetails(finishReason) ? 'incomplete' : 'completed';
}
export function rewriteJsonModelText(text, model) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'model')) {
      value.model = model;
      return {
        rewritten: true,
        text: JSON.stringify(value),
        value
      };
    }
    return {
      rewritten: false,
      text,
      value
    };
  } catch {
    return {
      rewritten: false,
      text,
      value: null
    };
  }
}
export function openAIChunkText(chunk) {
  const delta = chunk?.choices?.[0]?.delta ?? {};
  const content = delta.content ?? delta.text ?? '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text ?? '')
      .filter(Boolean)
      .join('');
  }
  return '';
}

export function openAIStreamChunkHasContent(chunk) {
  const choice = chunk?.choices?.[0];
  if (!choice) return false;
  if (openAIChunkText(chunk)) return true;
  if (openAIChoiceReasoning(choice)) return true;
  if (openAIChoiceReasoningSummary(choice)) return true;
  if (openAIChoiceReasoningSignature(choice)) return true;
  return (choice.delta?.tool_calls?.length ?? 0) > 0 || (choice.message?.tool_calls?.length ?? 0) > 0;
}
