/** Anthropic Messages API ↔ chat-completions bridge (pure transforms). */

import {
  openAIChoiceText,
  openAIChoiceReasoning,
  openAIChoiceReasoningSignature,
  anthropicUsageFromOpenAI
} from './text.mjs';
import {
  normalizeOpenAIChatCompletionBody,
  normalizeOpenAIChatRequestBody
} from './reasoning-normalize.mjs';

export function anthropicStopReason(choice) {
  const reason = choice?.finish_reason;
  if (reason === 'length') return 'max_tokens';
  if (reason === 'tool_calls') return 'tool_use';
  return reason ?? 'end_turn';
}

export function anthropicContentToOpenAI(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  const parts = [];
  for (const part of content) {
    if (part?.type === 'text') {
      parts.push({ type: 'text', text: part.text ?? '' });
    } else if (part?.type === 'image' && part.source?.type === 'base64') {
      const mediaType = part.source.media_type ?? 'image/png';
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${mediaType};base64,${part.source.data ?? ''}`
        }
      });
    }
  }
  return parts.length ? parts : '';
}

export function anthropicToolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text') return part.text ?? '';
      return part?.text ?? JSON.stringify(part);
    })
    .filter(Boolean)
    .join('\n');
}

export function anthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const converted = tools
    .filter((tool) => tool?.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? {
          type: 'object',
          properties: {}
        }
      }
    }));
  return converted.length ? converted : undefined;
}

export function anthropicToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      type: 'function',
      function: {
        name: toolChoice.name
      }
    };
  }
  return undefined;
}

export function stringifyToolInput(input) {
  if (input && typeof input === 'object') return JSON.stringify(input);
  return '{}';
}

export function parseToolArguments(argumentsText) {
  if (!argumentsText) return {};
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { value: parsed };
  } catch {
    return { _raw: argumentsText };
  }
}

export function anthropicMessageToOpenAIMessages(message) {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const content = message.content;
  if (role === 'assistant') {
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
    const text = blocks
      .filter((part) => part?.type === 'text')
      .map((part) => part.text ?? '')
      .join('');
    const thinking = blocks
      .filter((part) => part?.type === 'thinking')
      .map((part) => part.thinking ?? '')
      .filter(Boolean)
      .join('');
    const thinkingSignature = blocks
      .filter((part) => part?.type === 'thinking')
      .map((part) => part.signature ?? '')
      .filter(Boolean)
      .at(-1);
    const redactedThinking = blocks
      .filter((part) => part?.type === 'redacted_thinking')
      .map((part) => part.data)
      .filter(Boolean);
    const toolCalls = blocks
      .filter((part) => part?.type === 'tool_use' && part.name)
      .map((part, index) => ({
        id: part.id ?? `toolu_${index}`,
        type: 'function',
        function: {
          name: part.name,
          arguments: stringifyToolInput(part.input)
        }
      }));
    return [
      {
        role: 'assistant',
        content: text || null,
        ...(thinking ? { reasoning_content: thinking } : {}),
        ...(thinkingSignature ? { reasoning_signature: thinkingSignature } : {}),
        ...(redactedThinking.length ? { redacted_thinking: redactedThinking } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      }
    ];
  }

  if (!Array.isArray(content)) {
    return [
      {
        role: 'user',
        content: anthropicContentToOpenAI(content)
      }
    ];
  }

  const nonToolParts = content.filter((part) => part?.type !== 'tool_result');
  const messages = [];
  if (nonToolParts.length) {
    messages.push({
      role: 'user',
      content: anthropicContentToOpenAI(nonToolParts)
    });
  }
  for (const part of content) {
    if (part?.type !== 'tool_result') continue;
    messages.push({
      role: 'tool',
      tool_call_id: part.tool_use_id ?? part.id,
      content: anthropicToolResultText(part.content)
    });
  }
  return messages.length ? messages : [{ role: 'user', content: '' }];
}

export function anthropicMessagesToOpenAI(body, resolvedModel) {
  const messages = [];
  if (body.system) {
    const system = Array.isArray(body.system)
      ? body.system.map((part) => part?.text ?? '').join('\n')
      : String(body.system);
    if (system.trim()) messages.push({ role: 'system', content: system });
  }
  for (const message of body.messages ?? []) {
    messages.push(...anthropicMessageToOpenAIMessages(message));
  }
  const chatBody = {
    model: resolvedModel.model.upstreamModel,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream === true,
    stream_options: body.stream === true ? { include_usage: true } : undefined,
    tools: anthropicToolsToOpenAI(body.tools),
    tool_choice: anthropicToolChoiceToOpenAI(body.tool_choice),
    ...(body.thinking ? { reasoning: body.thinking } : {})
  };
  // Normalize think tags / reasoning_content before upstream (OpenAI-shaped).
  return normalizeOpenAIChatRequestBody(chatBody);
}

export function openAIToolCallsToAnthropic(toolCalls = []) {
  return toolCalls
    .filter((toolCall) => toolCall?.function?.name)
    .map((toolCall) => ({
      type: 'tool_use',
      id: toolCall.id ?? `toolu_${Date.now()}`,
      name: toolCall.function.name,
      input: parseToolArguments(toolCall.function.arguments)
    }));
}

export function openAIToAnthropic(responseJson, requestedModel) {
  const normalized = normalizeOpenAIChatCompletionBody(responseJson) ?? responseJson;
  const choice = normalized.choices?.[0] ?? {};
  const text = openAIChoiceText(choice);
  const reasoningText = openAIChoiceReasoning(choice);
  const reasoningSignature = openAIChoiceReasoningSignature(choice);
  const toolUse = openAIToolCallsToAnthropic(choice.message?.tool_calls);
  const content = [
    ...(reasoningText
      ? [
          {
            type: 'thinking',
            thinking: reasoningText,
            signature: reasoningSignature
          }
        ]
      : []),
    ...(text ? [{ type: 'text', text }] : []),
    ...toolUse
  ];
  return {
    id: normalized.id ?? `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel,
    content,
    stop_reason: anthropicStopReason(choice),
    stop_sequence: null,
    usage: anthropicUsageFromOpenAI(normalized.usage)
  };
}
