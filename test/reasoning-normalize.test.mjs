import assert from 'node:assert/strict';
import {
  normalizeOpenAIAssistantPayload,
  normalizeOpenAIChatCompletionBody,
  normalizeOpenAIChatRequestBody,
  splitThinkingFromContent
} from '../src/protocol/reasoning-normalize.mjs';

{
  const split = splitThinkingFromContent('<think>step one</think>\nFinal answer.');
  assert.equal(split.reasoning, 'step one');
  assert.equal(split.content, 'Final answer.');
}

{
  const split = splitThinkingFromContent("Here's a thinking process:\n\n1. Do math.\n2. Return 7.");
  assert.match(split.reasoning, /Do math/);
  assert.equal(split.content, '');
}

{
  const message = normalizeOpenAIAssistantPayload({
    role: 'assistant',
    content: '<think>plan</think>',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'SearchMemory', arguments: '{}' } }]
  });
  assert.equal(message.reasoning_content, 'plan');
  assert.equal(message.content, '');
  assert.equal(message.tool_calls[0].id, 'c1');
}

{
  const message = normalizeOpenAIAssistantPayload({
    role: 'assistant',
    content: 'visible',
    reasoning_content: 'hidden'
  });
  assert.equal(message.content, 'visible');
  assert.equal(message.reasoning_content, 'hidden');
}

{
  const body = normalizeOpenAIChatCompletionBody({
    id: 'chatcmpl_1',
    choices: [
      {
        message: {
          role: 'assistant',
          content: '<thinking>reason</thinking>\nOK'
        }
      }
    ]
  });
  assert.equal(body.choices[0].message.reasoning_content, 'reason');
  assert.equal(body.choices[0].message.content, 'OK');
}

{
  const req = normalizeOpenAIChatRequestBody({
    model: 'x',
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '<think>t1</think>',
        tool_calls: [{ id: '1', type: 'function', function: { name: 'A', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: '1', content: 'result' }
    ]
  });
  assert.equal(req.messages[1].reasoning_content, 't1');
  assert.equal(req.messages[1].content, '');
  assert.equal(req.messages[2].role, 'tool');
}

console.log('reasoning-normalize tests passed');
