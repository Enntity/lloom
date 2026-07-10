/** OpenAI Responses API ↔ chat-completions bridge (pure transforms). */

import {
  openAIChoiceText,
  openAIChoiceReasoning,
  openAIChoiceReasoningSummary,
  responseUsageFromOpenAI,
  responseIncompleteDetails,
  responseStatusFromFinishReason
} from './text.mjs';
import { normalizeOpenAIChatCompletionBody, normalizeOpenAIChatRequestBody } from './reasoning-normalize.mjs';

export function responsesContentPartToOpenAI(part) {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (!part || typeof part !== 'object') return { type: 'text', text: String(part ?? '') };
  if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
    return { type: 'text', text: part.text ?? '' };
  }
  if (part.type === 'input_image') {
    const imageUrl = part.image_url ?? part.url;
    if (imageUrl) {
      return {
        type: 'image_url',
        image_url: {
          url: imageUrl
        }
      };
    }
  }
  if (part.type === 'image_url') return part;
  return { type: 'text', text: part.text ?? JSON.stringify(part) };
}

export function responsesInputToMessages(body) {
  const messages = [];
  if (body.instructions) {
    messages.push({
      role: 'system',
      content: String(body.instructions)
    });
  }
  const input = body.input ?? body.messages ?? '';
  if (typeof input === 'string') {
    messages.push({
      role: 'user',
      content: input
    });
    return messages;
  }
  if (!Array.isArray(input)) {
    messages.push({
      role: 'user',
      content: String(input ?? '')
    });
    return messages;
  }
  for (const item of input) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    // OpenAI Responses reasoning item → chat reasoning_content (for multi-turn tool loops)
    if (item.type === 'reasoning') {
      const text = Array.isArray(item.content)
        ? item.content
            .map((part) => part?.text ?? part?.reasoning_text ?? '')
            .filter(Boolean)
            .join('\n')
        : (item.text ?? item.reasoning_content ?? '');
      if (text) {
        const last = messages.at(-1);
        if (last?.role === 'assistant') {
          last.reasoning_content = [last.reasoning_content, text].filter(Boolean).join('\n\n');
        } else {
          messages.push({
            role: 'assistant',
            content: null,
            reasoning_content: String(text)
          });
        }
      }
      continue;
    }
    if (item.type === 'function_call') {
      const last = messages.at(-1);
      const toolCall = {
        id: item.call_id ?? item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments ?? '{}'
        }
      };
      // Attach to prior assistant (with reasoning) when possible
      if (last?.role === 'assistant' && (last.tool_calls || last.reasoning_content || last.content == null)) {
        last.tool_calls = [...(last.tool_calls ?? []), toolCall];
        if (last.content === undefined) last.content = null;
      } else {
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [toolCall]
        });
      }
      continue;
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
      });
      continue;
    }
    if (item.type && item.type !== 'message') {
      messages.push({
        role: 'user',
        content: [responsesContentPartToOpenAI(item)]
      });
      continue;
    }
    const role = item.role === 'assistant' || item.role === 'system' ? item.role : 'user';
    const content = Array.isArray(item.content) ? item.content.map(responsesContentPartToOpenAI) : (item.content ?? '');
    const message = { role, content };
    // Pass through OpenAI-compatible reasoning fields if a client put them on input messages
    if (role === 'assistant') {
      if (typeof item.reasoning_content === 'string' && item.reasoning_content) {
        message.reasoning_content = item.reasoning_content;
      }
      if (Array.isArray(item.tool_calls) && item.tool_calls.length) {
        message.tool_calls = item.tool_calls;
      }
    }
    messages.push(message);
  }
  return messages;
}

export function responsesToolsToOpenAI(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  const converted = tools
    .filter((tool) => tool?.function?.name || (tool?.type === 'function' && tool.name))
    .map((tool) => {
      if (tool.function?.name) return tool;
      return {
        type: 'function',
        function: {
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: tool.parameters ?? {
            type: 'object',
            properties: {}
          }
        }
      };
    });
  return converted.length ? converted : undefined;
}

export function responsesToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice || typeof toolChoice === 'string') return toolChoice;
  if (toolChoice.type === 'function' && toolChoice.name) {
    return {
      type: 'function',
      function: {
        name: toolChoice.name
      }
    };
  }
  return toolChoice;
}

export function responsesToOpenAIChat(body, resolvedModel) {
  const effort =
    body.reasoning_effort ?? (body.reasoning && typeof body.reasoning === 'object' ? body.reasoning.effort : undefined);
  const chatBody = {
    model: resolvedModel.model.upstreamModel,
    messages: responsesInputToMessages(body),
    max_tokens: body.max_output_tokens ?? body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream === true,
    stream_options: body.stream === true ? { include_usage: true } : undefined,
    tools: responsesToolsToOpenAI(body.tools),
    tool_choice: responsesToolChoiceToOpenAI(body.tool_choice),
    ...(body.reasoning ? { reasoning: body.reasoning } : {}),
    ...(effort ? { reasoning_effort: effort } : {})
  };
  // Ensure history reasoning_content is clean OpenAI-shaped before upstream.
  return normalizeOpenAIChatRequestBody(chatBody);
}

export function responseOutputTextItem(responseId, text) {
  return {
    id: `msg_${responseId}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: text
      ? [
          {
            type: 'output_text',
            text,
            annotations: []
          }
        ]
      : []
  };
}

export function responseReasoningItem(responseId, { text, summary } = {}) {
  const content = text
    ? [
        {
          type: 'reasoning_text',
          text
        }
      ]
    : [];
  const summaryParts = summary
    ? [
        {
          type: 'summary_text',
          text: summary
        }
      ]
    : [];
  return {
    id: `rs_${responseId}`,
    type: 'reasoning',
    status: 'completed',
    content,
    summary: summaryParts
  };
}

export function responseFunctionCallItems(toolCalls = []) {
  return toolCalls
    .filter((toolCall) => toolCall?.function?.name)
    .map((toolCall) => ({
      id: toolCall.id ?? `fc_${Date.now()}`,
      type: 'function_call',
      status: 'completed',
      call_id: toolCall.id ?? `call_${Date.now()}`,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments ?? '{}'
    }));
}

export function openAIToResponses(responseJson, requestedModel) {
  const normalized = normalizeOpenAIChatCompletionBody(responseJson) ?? responseJson;
  const choice = normalized.choices?.[0] ?? {};
  const text = openAIChoiceText(choice);
  const reasoningText = openAIChoiceReasoning(choice);
  const reasoningSummary = openAIChoiceReasoningSummary(choice);
  const responseId = normalized.id?.startsWith('resp_') ? normalized.id : `resp_${normalized.id ?? Date.now()}`;
  const status = responseStatusFromFinishReason(choice.finish_reason);
  const output = [
    ...(reasoningText || reasoningSummary
      ? [responseReasoningItem(responseId, { text: reasoningText, summary: reasoningSummary })]
      : []),
    ...(text ? [responseOutputTextItem(responseId, text)] : []),
    ...responseFunctionCallItems(choice.message?.tool_calls)
  ];
  return {
    id: responseId,
    object: 'response',
    created_at: normalized.created ?? Math.floor(Date.now() / 1000),
    status,
    model: requestedModel,
    output,
    output_text: text,
    parallel_tool_calls: true,
    usage: responseUsageFromOpenAI(normalized.usage),
    error: null,
    incomplete_details: responseIncompleteDetails(choice.finish_reason),
    metadata: normalized.metadata ?? {}
  };
}
