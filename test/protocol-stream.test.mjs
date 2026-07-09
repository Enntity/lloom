import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnthropicStreamTranslator, createResponsesStreamTranslator } from '../src/protocol/index.mjs';

const fixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/protocol');

async function loadFixture(name) {
  const raw = await fs.readFile(path.join(fixturesRoot, name), 'utf8');
  return JSON.parse(raw);
}

function chunk({ content, reasoning, toolCalls, finish, usage } = {}) {
  const delta = {};
  if (content != null) delta.content = content;
  if (reasoning != null) delta.reasoning_content = reasoning;
  if (toolCalls) delta.tool_calls = toolCalls;
  return {
    id: 'chatcmpl_test',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finish ?? null
      }
    ],
    ...(usage ? { usage } : {})
  };
}

// Fixture: Anthropic tools + thinking
{
  const fixture = await loadFixture('anthropic-tools-stream.json');
  const t = createAnthropicStreamTranslator(fixture.requestedModel, {
    messageId: fixture.messageId
  });
  for (const c of fixture.chunks) t.handleChunk(c);
  t.finish();
  const types = t.events.map((e) => e.data.type);
  assert.equal(t.events[0].data.type, 'message_start');
  assert(types.some((type, i) => type === 'content_block_delta' && t.events[i].data.delta?.type === 'thinking_delta'));
  assert(
    types.some((type, i) => type === 'content_block_delta' && t.events[i].data.delta?.type === 'input_json_delta')
  );
  const toolStart = t.events.find(
    (e) => e.data.type === 'content_block_start' && e.data.content_block?.type === 'tool_use'
  );
  assert.equal(toolStart.data.content_block.name, fixture.expect.toolName);
  assert.equal(toolStart.data.content_block.id, fixture.expect.toolId);
  const delta = t.events.find((e) => e.data.type === 'message_delta');
  assert.equal(delta.data.delta.stop_reason, fixture.expect.stopReason);
  assert.equal(t.events.at(-1).data.type, 'message_stop');
}

// Inline: plain text stream
{
  const t = createAnthropicStreamTranslator('gw', { messageId: 'msg_text' });
  t.handleChunk(chunk({ content: 'hel' }));
  t.handleChunk(chunk({ content: 'lo', finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 2 } }));
  t.finish();
  const textDeltas = t.events
    .filter((e) => e.data.delta?.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('');
  assert.equal(textDeltas, 'hello');
  assert.equal(t.usage.input_tokens, 1);
  assert.equal(t.usage.output_tokens, 2);
}

// Fixture: Responses tools
{
  const fixture = await loadFixture('responses-tools-stream.json');
  const t = createResponsesStreamTranslator(fixture.requestedModel, {
    responseId: fixture.responseId,
    createdAt: fixture.createdAt
  });
  for (const c of fixture.chunks) t.handleChunk(c);
  t.finish();
  const seqs = t.events.map((e) => e.data.sequence_number);
  assert.deepEqual(
    seqs,
    seqs.slice().sort((a, b) => a - b)
  );
  assert(t.events.some((e) => e.data.type === 'response.function_call_arguments.delta'));
  const completed = t.events.find((e) => e.data.type === 'response.completed');
  assert(completed);
  assert(
    completed.data.response.output.some(
      (item) => item.type === 'function_call' && item.name === fixture.expect.functionCallName
    )
  );
}

// Fixture: Responses incomplete
{
  const fixture = await loadFixture('responses-incomplete.json');
  const t = createResponsesStreamTranslator(fixture.requestedModel, {
    responseId: fixture.responseId,
    createdAt: fixture.createdAt
  });
  for (const c of fixture.chunks) t.handleChunk(c);
  t.finish();
  assert(t.events.some((e) => e.data.type === 'response.incomplete'));
  const final = t.events.find((e) => e.data.type === 'response.incomplete');
  assert.equal(final.data.response.status, 'incomplete');
  assert.deepEqual(final.data.response.incomplete_details, {
    reason: fixture.expect.incompleteReason
  });
  assert.equal(t.fullText, fixture.expect.fullText);
}

console.log('protocol-stream tests passed');
