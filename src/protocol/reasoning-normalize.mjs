/**
 * Normalize OpenAI Chat Completions messages so private reasoning lives in
 * `reasoning_content` and user-visible text in `content`.
 *
 * Keeps the wire contract OpenAI-shaped (optional reasoning_content field).
 * Used so all LLooM clients share one dialect regardless of upstream leak patterns.
 */

const CLOSED_THINK_TAG_RE =
  /<\s*(?:think|thinking|reasoning)\s*>([\s\S]*?)<\s*\/\s*(?:think|thinking|reasoning)\s*>/gi;

const PROSE_THINKING_PREFIX_RE =
  /^(?:here'?s\s+a\s+)?thinking\s+process\s*:?\s*(?:\n+|$)/i;

/**
 * Split think tags / prose "Thinking Process" blocks out of content.
 * @returns {{ content: string, reasoning: string }}
 */
export function splitThinkingFromContent(content) {
  if (typeof content !== 'string' || !content) {
    return { content: typeof content === 'string' ? content : '', reasoning: '' };
  }

  const reasoningParts = [];
  let rest = content;

  rest = rest.replace(CLOSED_THINK_TAG_RE, (_, inner) => {
    const text = String(inner ?? '').trim();
    if (text) reasoningParts.push(text);
    return '';
  });

  // Unclosed open tag at end (truncated generation)
  const unclosed = rest.match(/<\s*(?:think|thinking|reasoning)\s*>([\s\S]*)$/i);
  if (unclosed) {
    const text = String(unclosed[1] ?? '').trim();
    if (text) reasoningParts.push(text);
    rest = rest.slice(0, unclosed.index);
  }

  // Prose thinking dump with no tags (common MTPLX leak before structured fields)
  const proseMatch = rest.match(PROSE_THINKING_PREFIX_RE);
  if (proseMatch) {
    const after = rest.slice(proseMatch[0].length).trim();
    if (after) reasoningParts.push(after);
    rest = '';
  }

  return {
    content: rest.replace(/^\s+|\s+$/g, ''),
    reasoning: reasoningParts.join('\n\n').trim()
  };
}

function mergeReasoning(...parts) {
  return parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Normalize a single assistant message or stream delta object.
 * Preserves tool_calls and other fields.
 */
export function normalizeOpenAIAssistantPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return payload;

  const existingReasoning =
    (typeof payload.reasoning_content === 'string' && payload.reasoning_content) ||
    (typeof payload.reasoning_text === 'string' && payload.reasoning_text) ||
    // mlx_lm uses `reasoning`; Anthropic-style sometimes uses `thinking`
    (typeof payload.reasoning === 'string' && payload.reasoning) ||
    (typeof payload.thinking === 'string' && payload.thinking) ||
    '';

  const rawContent = payload.content;
  const contentString =
    typeof rawContent === 'string'
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.map((part) => part?.text ?? '').join('')
        : rawContent == null
          ? ''
          : String(rawContent);

  const split = splitThinkingFromContent(contentString);
  const reasoning = mergeReasoning(existingReasoning, split.reasoning);

  const next = { ...payload };
  if (typeof rawContent === 'string' || rawContent == null) {
    next.content = split.content;
  } else if (Array.isArray(rawContent) && reasoning && split.content !== contentString) {
    // Multimodal content: only replace when we actually stripped thinking from joined text
    next.content = split.content
      ? [{ type: 'text', text: split.content }]
      : [];
  }

  if (reasoning) {
    next.reasoning_content = reasoning;
  } else {
    // Don't invent empty field
    if ('reasoning_content' in next && !next.reasoning_content) {
      delete next.reasoning_content;
    }
  }

  return next;
}

/**
 * Normalize a full chat.completion JSON body (non-stream).
 */
export function normalizeOpenAIChatCompletionBody(body) {
  if (!body || typeof body !== 'object') return body;
  if (!Array.isArray(body.choices) || body.choices.length === 0) return body;

  const choices = body.choices.map((choice) => {
    if (!choice || typeof choice !== 'object') return choice;
    const next = { ...choice };
    if (choice.message && typeof choice.message === 'object') {
      next.message = normalizeOpenAIAssistantPayload(choice.message);
    }
    return next;
  });

  return { ...body, choices };
}

/**
 * Normalize a chat.completion.chunk (stream).
 * Uses optional stream state for cross-chunk tag parsing.
 *
 * @param {object} chunk
 * @param {{ tagMode?: string, tagCarry?: string }} [state]
 */
export function normalizeOpenAIChatCompletionChunk(chunk, state = null) {
  if (!chunk || typeof chunk !== 'object') return chunk;
  if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) return chunk;

  const choices = chunk.choices.map((choice) => {
    if (!choice || typeof choice !== 'object') return choice;
    const next = { ...choice };
    if (choice.delta && typeof choice.delta === 'object') {
      next.delta = normalizeStreamDelta(choice.delta, state);
    }
    if (choice.message && typeof choice.message === 'object') {
      next.message = normalizeOpenAIAssistantPayload(choice.message);
    }
    return next;
  });

  return { ...chunk, choices };
}

/**
 * Stateful-ish delta normalize: if upstream already sets reasoning_content, pass through.
 * For content that includes complete think tags in a single delta, split.
 * Partial tags are left for the client full-message normalize as a safety net.
 */
function normalizeStreamDelta(delta, _state) {
  if (!delta || typeof delta !== 'object') return delta;

  // Prefer explicit structured fields from upstream (OpenAI + mlx_lm)
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
    return delta;
  }
  if (typeof delta.reasoning === 'string' && delta.reasoning) {
    const next = { ...delta };
    next.reasoning_content = delta.reasoning;
    return next;
  }
  if (typeof delta.thinking === 'string' && delta.thinking) {
    const next = { ...delta };
    next.reasoning_content = delta.thinking;
    return next;
  }

  if (typeof delta.content !== 'string' || !delta.content) {
    return delta;
  }

  // Only split when a closed tag is fully present in this delta (common for short chunks)
  if (!/<\s*\/\s*(?:think|thinking|reasoning)\s*>/i.test(delta.content)) {
    // Prose thinking prefix starting a generation
    if (PROSE_THINKING_PREFIX_RE.test(delta.content) && delta.content.length > 40) {
      const split = splitThinkingFromContent(delta.content);
      if (split.reasoning) {
        const next = { ...delta };
        if (split.content) next.content = split.content;
        else delete next.content;
        next.reasoning_content = split.reasoning;
        return next;
      }
    }
    return delta;
  }

  return normalizeOpenAIAssistantPayload(delta);
}

/**
 * Normalize outbound request messages so history re-sent with reasoning_content
 * is clean, and think tags in content are promoted to reasoning_content.
 */
export function normalizeOpenAIChatRequestMessages(messages = []) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    if (message.role !== 'assistant') return message;
    return normalizeOpenAIAssistantPayload(message);
  });
}

export function normalizeOpenAIChatRequestBody(body = {}) {
  if (!body || typeof body !== 'object') return body;
  if (!Array.isArray(body.messages)) return body;
  return {
    ...body,
    messages: normalizeOpenAIChatRequestMessages(body.messages)
  };
}
