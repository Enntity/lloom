/**
 * Anthropic Messages streaming bridge over OpenAI chat-completions SSE.
 * Pure translator: consume chunks, emit { event, data } records (no HTTP).
 */

import { anthropicStopReason } from './anthropic.mjs';
import {
  anthropicUsageFromOpenAI,
  openAIChoiceReasoning,
  openAIChoiceReasoningSignature,
  openAIChunkText,
  openAIStreamChunkHasContent
} from './text.mjs';
import { readSseEvents } from './sse.mjs';
import { normalizeOpenAIChatCompletionChunk } from './reasoning-normalize.mjs';

export function createAnthropicStreamTranslator(requestedModel, { messageId = `msg_${Date.now()}` } = {}) {
  const events = [];
  let usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = 'end_turn';
  let nextContentIndex = 0;
  let thinkingBlock = null;
  let thinkingSignature = '';
  let textBlock = null;
  const toolBlocks = new Map();
  let firstContent = false;

  function emit(event, data) {
    events.push({ event, data });
  }

  emit('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  function startThinkingBlock(signature = '') {
    if (thinkingBlock) {
      if (signature) thinkingSignature = signature;
      return thinkingBlock;
    }
    thinkingSignature = signature;
    thinkingBlock = { index: nextContentIndex++, stopped: false };
    emit('content_block_start', {
      type: 'content_block_start',
      index: thinkingBlock.index,
      content_block: {
        type: 'thinking',
        thinking: '',
        signature: thinkingSignature
      }
    });
    return thinkingBlock;
  }

  function stopThinkingBlock() {
    if (!thinkingBlock || thinkingBlock.stopped) return;
    emit('content_block_delta', {
      type: 'content_block_delta',
      index: thinkingBlock.index,
      delta: { type: 'signature_delta', signature: thinkingSignature }
    });
    emit('content_block_stop', {
      type: 'content_block_stop',
      index: thinkingBlock.index
    });
    thinkingBlock.stopped = true;
  }

  function startTextBlock() {
    if (textBlock) return textBlock;
    stopThinkingBlock();
    textBlock = { index: nextContentIndex++, stopped: false };
    emit('content_block_start', {
      type: 'content_block_start',
      index: textBlock.index,
      content_block: { type: 'text', text: '' }
    });
    return textBlock;
  }

  function stopTextBlock() {
    if (!textBlock || textBlock.stopped) return;
    emit('content_block_stop', {
      type: 'content_block_stop',
      index: textBlock.index
    });
    textBlock.stopped = true;
  }

  function startToolBlock(toolCall) {
    const toolIndex = toolCall.index ?? 0;
    let block = toolBlocks.get(toolIndex);
    if (block) {
      if (!block.id && toolCall.id) block.id = toolCall.id;
      if ((!block.name || block.name === 'tool') && toolCall.function?.name) {
        block.name = toolCall.function.name;
      }
      return block;
    }
    stopThinkingBlock();
    stopTextBlock();
    block = {
      index: nextContentIndex++,
      id: toolCall.id,
      fallbackId: `toolu_${messageId}_${toolIndex}`,
      name: toolCall.function?.name,
      pendingJson: '',
      started: false,
      stopped: false
    };
    toolBlocks.set(toolIndex, block);
    return block;
  }

  function startToolBlockOutput(block) {
    if (!block.started) {
      block.id ??= block.fallbackId;
      block.name ||= 'tool';
      emit('content_block_start', {
        type: 'content_block_start',
        index: block.index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {}
        }
      });
      block.started = true;
    }
    if (block.pendingJson) {
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'input_json_delta', partial_json: block.pendingJson }
      });
      block.pendingJson = '';
    }
  }

  function handleChunk(chunk) {
    const before = events.length;
    if (openAIStreamChunkHasContent(chunk)) firstContent = true;
    if (chunk.usage) {
      usage = { ...usage, ...anthropicUsageFromOpenAI(chunk.usage) };
    }
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) stopReason = anthropicStopReason(choice);
    const reasoning = openAIChoiceReasoning(choice);
    const signature = openAIChoiceReasoningSignature(choice);
    if (reasoning) {
      const block = startThinkingBlock(signature);
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'thinking_delta', thinking: reasoning }
      });
    } else if (signature && thinkingBlock && !thinkingBlock.stopped) {
      thinkingSignature = signature;
    }
    for (const toolCall of choice?.delta?.tool_calls ?? []) {
      const block = startToolBlock(toolCall);
      const partialJson = toolCall.function?.arguments ?? '';
      if (partialJson) block.pendingJson += partialJson;
      if (block.name || choice?.finish_reason) startToolBlockOutput(block);
    }
    const text = openAIChunkText(chunk);
    if (text) {
      const block = startTextBlock();
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'text_delta', text }
      });
    }
    return events.slice(before);
  }

  function finish() {
    const before = events.length;
    stopThinkingBlock();
    stopTextBlock();
    for (const block of toolBlocks.values()) {
      startToolBlockOutput(block);
      if (block.stopped) continue;
      emit('content_block_stop', {
        type: 'content_block_stop',
        index: block.index
      });
      block.stopped = true;
    }
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage
    });
    emit('message_stop', { type: 'message_stop' });
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
        total_tokens: usage.input_tokens + usage.output_tokens
      };
    }
  };
}

/**
 * Translate an OpenAI chat SSE body into Anthropic message SSE events.
 * @returns {{ events: Array, usage: object, firstContent: boolean }}
 */
export async function translateAnthropicStreamFromOpenAIBody(body, requestedModel, options = {}) {
  const translator = createAnthropicStreamTranslator(requestedModel, options);
  for await (const event of readSseEvents(body)) {
    if (event.data === '[DONE]') break;
    let chunk;
    try {
      chunk = normalizeOpenAIChatCompletionChunk(JSON.parse(event.data));
    } catch {
      continue;
    }
    translator.handleChunk(chunk);
  }
  translator.finish();
  return {
    events: translator.events,
    usage: translator.usage,
    firstContent: translator.firstContent
  };
}

/** HTTP wrapper used by the gateway. */
export async function streamAnthropicFromOpenAI(
  res,
  upstream,
  requestedModel,
  { signal, timing, writeSse, throwIfClientClosed, setCors, sseHeaders, markFirstContent } = {}
) {
  throwIfClientClosed(signal, res);
  setCors(res);
  res.writeHead(200, sseHeaders());

  const translator = createAnthropicStreamTranslator(requestedModel);
  let sawFirst = false;

  function flush(newEvents) {
    for (const item of newEvents) {
      writeSse(res, item.event, item.data, { signal });
    }
  }

  flush(translator.events.slice());

  for await (const event of readSseEvents(upstream.body)) {
    throwIfClientClosed(signal, res);
    if (event.data === '[DONE]') break;
    let chunk;
    try {
      chunk = normalizeOpenAIChatCompletionChunk(JSON.parse(event.data));
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
  res.end();
  return {
    status: 200,
    stream: true,
    usage: translator.usage
  };
}
