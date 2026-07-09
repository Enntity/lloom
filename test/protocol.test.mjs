import assert from 'node:assert/strict';
import {
  anthropicMessagesToOpenAI,
  openAIToAnthropic,
  openAIToResponses,
  responsesToOpenAIChat,
  responseStatusFromFinishReason,
  rewriteJsonModelText
} from '../src/protocol/index.mjs';

const resolved = { model: { upstreamModel: 'upstream-qwen' } };

// Responses → chat
{
  const body = responsesToOpenAIChat(
    {
      instructions: 'Be brief.',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: '{"ok":true}'
        }
      ],
      max_output_tokens: 64,
      tools: [
        {
          type: 'function',
          name: 'lookup',
          description: 'Lookup',
          parameters: { type: 'object', properties: { q: { type: 'string' } } }
        }
      ],
      tool_choice: { type: 'function', name: 'lookup' },
      stream: true
    },
    resolved
  );
  assert.equal(body.model, 'upstream-qwen');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[2].role, 'tool');
  assert.equal(body.messages[2].tool_call_id, 'call_1');
  assert.equal(body.max_tokens, 64);
  assert.equal(body.tools[0].function.name, 'lookup');
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'lookup' } });
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
}

// Chat → Responses
{
  const response = openAIToResponses(
    {
      id: 'chatcmpl_1',
      created: 1,
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'done',
            tool_calls: [
              {
                id: 'call_9',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"x"}' }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 }
    },
    'gateway-model'
  );
  assert.equal(response.object, 'response');
  assert.equal(response.model, 'gateway-model');
  assert.equal(response.output_text, 'done');
  assert.equal(response.status, 'completed');
  assert(response.output.some((item) => item.type === 'message'));
  assert(response.output.some((item) => item.type === 'function_call' && item.name === 'lookup'));
  assert.equal(response.usage.input_tokens, 3);
  assert.equal(response.usage.output_tokens, 5);
  assert.equal(responseStatusFromFinishReason('length'), 'incomplete');
}

// Anthropic → chat with tools + thinking
{
  const body = anthropicMessagesToOpenAI(
    {
      system: 'sys',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'plan', signature: 'sig' },
            { type: 'text', text: 'calling' },
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } }
          ]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' }]
        }
      ],
      max_tokens: 128,
      tools: [{ name: 'lookup', description: 'd', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'tool', name: 'lookup' }
    },
    resolved
  );
  assert.equal(body.model, 'upstream-qwen');
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].reasoning_content, 'plan');
  assert.equal(body.messages[1].reasoning_signature, 'sig');
  assert.equal(body.messages[1].tool_calls[0].function.name, 'lookup');
  assert.equal(body.messages[2].role, 'tool');
  assert.equal(body.messages[2].tool_call_id, 'toolu_1');
  assert.equal(body.tools[0].function.name, 'lookup');
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'lookup' } });
}

// Chat → Anthropic
{
  const message = openAIToAnthropic(
    {
      id: 'chat_2',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'answer',
            reasoning_content: 'think',
            tool_calls: [
              {
                id: 'call_a',
                type: 'function',
                function: { name: 'lookup', arguments: '{"q":"y"}' }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: { prompt_tokens: 2, completion_tokens: 4 }
    },
    'gateway-model'
  );
  assert.equal(message.type, 'message');
  assert.equal(message.model, 'gateway-model');
  assert.equal(message.stop_reason, 'tool_use');
  assert.equal(message.content[0].type, 'thinking');
  assert.equal(message.content[0].thinking, 'think');
  assert.equal(message.content[1].type, 'text');
  assert.equal(message.content[2].type, 'tool_use');
  assert.equal(message.content[2].name, 'lookup');
  assert.deepEqual(message.content[2].input, { q: 'y' });
  assert.equal(message.usage.input_tokens, 2);
  assert.equal(message.usage.output_tokens, 4);
}

// Model ID rewrite preserves unknown JSON
{
  const rewritten = rewriteJsonModelText(JSON.stringify({ model: 'upstream', ok: true }), 'gateway');
  assert.equal(rewritten.rewritten, true);
  assert.equal(rewritten.value.model, 'gateway');
  const raw = rewriteJsonModelText('not-json', 'gateway');
  assert.equal(raw.rewritten, false);
}

console.log('protocol tests passed');
