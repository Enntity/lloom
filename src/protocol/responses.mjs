/** OpenAI Responses API ↔ chat-completions bridge (pure transforms). */

import {
  openAIChoiceText,
  openAIChoiceReasoning,
  openAIChoiceReasoningSummary,
  responseUsageFromOpenAI,
  responseIncompleteDetails,
  responseStatusFromFinishReason
} from './text.mjs';

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
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? item.id,
            type: 'function',
            function: {
              name: item.name,
              arguments: item.arguments ?? '{}'
            }
          }
        ]
      });
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
    messages.push({ role, content });
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
  return {
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
    ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {})
  };
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
  const choice = responseJson.choices?.[0] ?? {};
  const text = openAIChoiceText(choice);
  const reasoningText = openAIChoiceReasoning(choice);
  const reasoningSummary = openAIChoiceReasoningSummary(choice);
  const responseId = responseJson.id?.startsWith('resp_') ? responseJson.id : `resp_${responseJson.id ?? Date.now()}`;
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
    created_at: responseJson.created ?? Math.floor(Date.now() / 1000),
    status,
    model: requestedModel,
    output,
    output_text: text,
    parallel_tool_calls: true,
    usage: responseUsageFromOpenAI(responseJson.usage),
    error: null,
    incomplete_details: responseIncompleteDetails(choice.finish_reason),
    metadata: responseJson.metadata ?? {}
  };
}
