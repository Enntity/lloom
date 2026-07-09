/**
 * OpenAI Responses streaming bridge over chat-completions SSE.
 * Pure translator: consume chunks, emit { event, data } records (no HTTP).
 */

import { responseReasoningItem } from './responses.mjs';
import {
  openAIChoiceReasoning,
  openAIChoiceReasoningSummary,
  openAIChunkText,
  openAIStreamChunkHasContent,
  responseIncompleteDetails,
  responseStatusFromFinishReason,
  responseUsageFromOpenAI
} from './text.mjs';
import { readSseEvents } from './sse.mjs';

export function createResponsesStreamTranslator(
  requestedModel,
  { responseId = `resp_${Date.now()}`, createdAt = Math.floor(Date.now() / 1000) } = {}
) {
  const events = [];
  let sequenceNumber = 0;
  let fullText = '';
  let fullReasoning = '';
  let fullReasoningSummary = '';
  let usage = responseUsageFromOpenAI();
  let stopReason = 'stop';
  let nextOutputIndex = 0;
  let reasoningItem = null;
  let textItem = null;
  const toolItems = new Map();
  let firstContent = false;

  const responseBase = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'in_progress',
    model: requestedModel,
    output: [],
    output_text: '',
    usage: null
  };

  function emit(event, data) {
    sequenceNumber += 1;
    events.push({
      event,
      data: {
        ...data,
        sequence_number: sequenceNumber
      }
    });
  }

  emit('response.created', { type: 'response.created', response: responseBase });
  emit('response.in_progress', { type: 'response.in_progress', response: responseBase });

  function startReasoningItem() {
    if (reasoningItem) return reasoningItem;
    reasoningItem = {
      id: `rs_${responseId}`,
      outputIndex: nextOutputIndex++,
      summaryStarted: false
    };
    emit('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: reasoningItem.outputIndex,
      item: {
        id: reasoningItem.id,
        type: 'reasoning',
        status: 'in_progress',
        content: [],
        summary: []
      }
    });
    return reasoningItem;
  }

  function startTextItem() {
    if (textItem) return textItem;
    textItem = { id: `msg_${responseId}`, outputIndex: nextOutputIndex++ };
    emit('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: textItem.outputIndex,
      item: {
        id: textItem.id,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: []
      }
    });
    emit('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: textItem.id,
      output_index: textItem.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    });
    return textItem;
  }

  function startToolItem(toolCall) {
    const index = toolCall.index ?? 0;
    let item = toolItems.get(index);
    if (item) {
      if (!item.name && toolCall.function?.name) item.name = toolCall.function.name;
      if (!item.callId && toolCall.id) item.callId = toolCall.id;
      return item;
    }
    item = {
      id: toolCall.id,
      fallbackId: `fc_${responseId}_${index}`,
      callId: toolCall.id,
      fallbackCallId: `call_${responseId}_${index}`,
      name: toolCall.function?.name ?? '',
      arguments: '',
      emittedArgumentsLength: 0,
      outputIndex: nextOutputIndex++,
      added: false
    };
    toolItems.set(index, item);
    return item;
  }

  function addToolItemOutput(item) {
    if (item.added) return;
    item.id ??= item.fallbackId;
    item.callId ??= item.fallbackCallId;
    emit('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: item.outputIndex,
      item: {
        id: item.id,
        type: 'function_call',
        status: 'in_progress',
        call_id: item.callId,
        name: item.name,
        arguments: ''
      }
    });
    item.added = true;
  }

  function emitToolItemArguments(item) {
    if (!item.added || item.emittedArgumentsLength >= item.arguments.length) return;
    const delta = item.arguments.slice(item.emittedArgumentsLength);
    item.emittedArgumentsLength = item.arguments.length;
    emit('response.function_call_arguments.delta', {
      type: 'response.function_call_arguments.delta',
      item_id: item.id,
      output_index: item.outputIndex,
      delta
    });
  }

  function handleChunk(chunk) {
    const before = events.length;
    if (openAIStreamChunkHasContent(chunk)) firstContent = true;
    if (chunk.usage) usage = responseUsageFromOpenAI(chunk.usage);
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) stopReason = choice.finish_reason;
    const reasoning = openAIChoiceReasoning(choice);
    if (reasoning) {
      const item = startReasoningItem();
      fullReasoning += reasoning;
      emit('response.reasoning_text.delta', {
        type: 'response.reasoning_text.delta',
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: 0,
        delta: reasoning
      });
    }
    const reasoningSummary = openAIChoiceReasoningSummary(choice);
    if (reasoningSummary) {
      const item = startReasoningItem();
      if (!item.summaryStarted) {
        emit('response.reasoning_summary_part.added', {
          type: 'response.reasoning_summary_part.added',
          item_id: item.id,
          output_index: item.outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' }
        });
        item.summaryStarted = true;
      }
      fullReasoningSummary += reasoningSummary;
      emit('response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        item_id: item.id,
        output_index: item.outputIndex,
        summary_index: 0,
        delta: reasoningSummary
      });
    }
    for (const toolCall of choice?.delta?.tool_calls ?? []) {
      const item = startToolItem(toolCall);
      const partial = toolCall.function?.arguments ?? '';
      if (toolCall.function?.name && !item.name) item.name = toolCall.function.name;
      if (partial) item.arguments += partial;
      if (item.name || choice?.finish_reason) addToolItemOutput(item);
      emitToolItemArguments(item);
    }
    const text = openAIChunkText(chunk);
    if (text) {
      const item = startTextItem();
      fullText += text;
      emit('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: item.outputIndex,
        content_index: 0,
        delta: text
      });
    }
    return events.slice(before);
  }

  function finish() {
    const before = events.length;
    const output = [];
    if (reasoningItem) {
      const item = responseReasoningItem(responseId, {
        text: fullReasoning,
        summary: fullReasoningSummary
      });
      item.id = reasoningItem.id;
      item.status = 'completed';
      if (fullReasoning) {
        emit('response.reasoning_text.done', {
          type: 'response.reasoning_text.done',
          item_id: reasoningItem.id,
          output_index: reasoningItem.outputIndex,
          content_index: 0,
          text: fullReasoning
        });
      }
      if (reasoningItem.summaryStarted) {
        emit('response.reasoning_summary_text.done', {
          type: 'response.reasoning_summary_text.done',
          item_id: reasoningItem.id,
          output_index: reasoningItem.outputIndex,
          summary_index: 0,
          text: fullReasoningSummary
        });
        emit('response.reasoning_summary_part.done', {
          type: 'response.reasoning_summary_part.done',
          item_id: reasoningItem.id,
          output_index: reasoningItem.outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: fullReasoningSummary }
        });
      }
      emit('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: reasoningItem.outputIndex,
        item
      });
      output.push(item);
    }
    if (textItem) {
      const item = {
        id: textItem.id,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: fullText ? [{ type: 'output_text', text: fullText, annotations: [] }] : []
      };
      emit('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: textItem.id,
        output_index: textItem.outputIndex,
        content_index: 0,
        text: fullText
      });
      emit('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: textItem.id,
        output_index: textItem.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: fullText, annotations: [] }
      });
      emit('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: textItem.outputIndex,
        item
      });
      output.push(item);
    }
    for (const item of [...toolItems.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      addToolItemOutput(item);
      emitToolItemArguments(item);
      const completed = {
        id: item.id,
        type: 'function_call',
        status: 'completed',
        call_id: item.callId,
        name: item.name,
        arguments: item.arguments || '{}'
      };
      emit('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: item.outputIndex,
        arguments: completed.arguments
      });
      emit('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: item.outputIndex,
        item: completed
      });
      output.push(completed);
    }
    const status = responseStatusFromFinishReason(stopReason);
    const finalEvent = status === 'incomplete' ? 'response.incomplete' : 'response.completed';
    emit(finalEvent, {
      type: finalEvent,
      response: {
        ...responseBase,
        status,
        completed_at: status === 'completed' ? Math.floor(Date.now() / 1000) : null,
        output_text: fullText,
        output,
        usage,
        incomplete_details: responseIncompleteDetails(stopReason)
      }
    });
    return events.slice(before);
  }

  return {
    handleChunk,
    finish,
    get events() {
      return events;
    },
    get firstContent() {
      return firstContent;
    },
    get usage() {
      return {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens
      };
    },
    get fullText() {
      return fullText;
    }
  };
}

export async function translateResponsesStreamFromOpenAIBody(body, requestedModel, options = {}) {
  const translator = createResponsesStreamTranslator(requestedModel, options);
  for await (const event of readSseEvents(body)) {
    if (event.data === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(event.data);
    } catch {
      continue;
    }
    translator.handleChunk(chunk);
  }
  translator.finish();
  return {
    events: translator.events,
    usage: translator.usage,
    firstContent: translator.firstContent,
    fullText: translator.fullText
  };
}

export async function streamResponsesFromOpenAI(
  res,
  upstream,
  requestedModel,
  { signal, timing, writeSse, throwIfClientClosed, setCors, sseHeaders, markFirstContent } = {}
) {
  throwIfClientClosed(signal, res);
  setCors(res);
  res.writeHead(200, sseHeaders());

  const translator = createResponsesStreamTranslator(requestedModel);
  let sawFirst = false;

  function flush(newEvents) {
    for (const item of newEvents) {
      writeSse(res, item.event, item.data, { signal });
    }
  }

  // Initial created/in_progress already in events
  flush(translator.events.slice());

  for await (const event of readSseEvents(upstream.body)) {
    throwIfClientClosed(signal, res);
    if (event.data === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(event.data);
    } catch {
      continue;
    }
    const beforeLen = translator.events.length;
    translator.handleChunk(chunk);
    if (!sawFirst && translator.firstContent) {
      sawFirst = true;
      markFirstContent?.(timing);
    }
    flush(translator.events.slice(beforeLen));
  }

  const beforeFinish = translator.events.length;
  translator.finish();
  flush(translator.events.slice(beforeFinish));
  res.write('data: [DONE]\n\n');
  res.end();
  return {
    status: 200,
    stream: true,
    usage: translator.usage
  };
}
