import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openAIToResponses,
  responsesInputToMessages,
  responsesToolChoiceToOpenAI,
  responsesToolsToOpenAI
} from '../src/protocol/responses.mjs';
import { createResponsesStreamTranslator } from '../src/protocol/stream-responses.mjs';
import { prepareStructuredOutputForBackend } from '../src/protocol/structured-output.mjs';

const tools = [
  { type: 'custom', name: 'apply_patch', description: 'Apply a patch.', format: { type: 'text' } },
  {
    type: 'function',
    name: 'inspect',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  }
];
const patch = '*** Begin Patch\n*** Add File: café.txt\n+"quoted" \\ path\n+Hello 🌍\n*** End Patch';
const wrappedPatch = JSON.stringify({ input: patch });
const inspectArguments = JSON.stringify({ path: 'café.txt' });

function toolCall(name, args, id) {
  return { id, type: 'function', function: { name, arguments: args } };
}

function chatCompletion(calls) {
  return {
    id: 'chatcmpl_codex',
    choices: [
      { index: 0, message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }
    ]
  };
}

test('developer instructions remain privileged and ordered ahead of user input', () => {
  const messages = responsesInputToMessages({
    instructions: 'System policy.',
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: 'Project policy.' }] },
      { role: 'user', content: 'Task.' }
    ]
  });
  assert.deepEqual(messages, [
    { role: 'system', content: 'System policy.' },
    { role: 'system', content: [{ type: 'text', text: 'Project policy.' }] },
    { role: 'user', content: 'Task.' }
  ]);
});

test('custom tool declarations and explicit choices become callable Chat functions', () => {
  const converted = responsesToolsToOpenAI(tools);
  assert.equal(converted.length, 2);
  assert.equal(converted[0].type, 'function');
  assert.equal(converted[0].function.name, 'apply_patch');
  assert.equal(converted[0].function.parameters.type, 'object');
  assert.equal(converted[0].function.parameters.properties.input.type, 'string');
  assert.deepEqual(converted[0].function.parameters.required, ['input']);
  assert.deepEqual(converted[1].function.parameters, tools[1].parameters);
  assert.deepEqual(responsesToolChoiceToOpenAI({ type: 'custom', name: 'apply_patch' }), {
    type: 'function',
    function: { name: 'apply_patch' }
  });
});

test('buffered custom calls round trip exact input and tool results without leaking JSON wrappers', () => {
  const response = openAIToResponses(
    chatCompletion([
      toolCall('apply_patch', wrappedPatch, 'call_patch'),
      toolCall('inspect', inspectArguments, 'call_inspect')
    ]),
    'gateway-model',
    { tools }
  );
  const [custom, normal] = response.output;
  assert.equal(custom.type, 'custom_tool_call');
  assert.equal(custom.name, 'apply_patch');
  assert.equal(custom.call_id, 'call_patch');
  assert.equal(custom.input, patch);
  assert.equal(Object.hasOwn(custom, 'arguments'), false);
  assert.equal(normal.type, 'function_call');
  assert.equal(normal.arguments, inspectArguments);
  const messages = responsesInputToMessages({
    input: [
      { role: 'user', content: 'Apply this patch and inspect it.' },
      ...response.output,
      { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'Patch applied.' },
      { type: 'function_call_output', call_id: 'call_inspect', output: 'File present.' }
    ]
  });
  assert.deepEqual(messages[1].tool_calls, [
    toolCall('apply_patch', wrappedPatch, 'call_patch'),
    toolCall('inspect', inspectArguments, 'call_inspect')
  ]);
  assert.deepEqual(messages.slice(2), [
    { role: 'tool', tool_call_id: 'call_patch', content: 'Patch applied.' },
    { role: 'tool', tool_call_id: 'call_inspect', content: 'File present.' }
  ]);
});

test('custom stream reconstructs fragmented escapes and unicode, while ordinary functions keep arguments events', () => {
  const translator = createResponsesStreamTranslator('gateway-model', { tools });
  const feed = (calls, finish = null) =>
    translator.handleChunk({
      id: 'chatcmpl_codex',
      choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: finish }]
    });
  // Split at every UTF-16 code unit, including JSON escapes and the emoji surrogate pair.
  // The custom name arrives after arguments started, as some providers stream metadata late.
  feed([{ index: 0, id: 'call_patch', function: { arguments: wrappedPatch.slice(0, 2) } }]);
  feed([{ index: 0, function: { name: 'apply_patch', arguments: '' } }]);
  for (let i = 2; i < wrappedPatch.length; i++) {
    feed([{ index: 0, function: { arguments: wrappedPatch[i] } }]);
  }
  feed([{ index: 1, ...toolCall('inspect', inspectArguments, 'call_inspect') }], 'tool_calls');
  translator.finish();
  const events = translator.events.map(({ data }) => data);
  const added = events.filter((event) => event.type === 'response.output_item.added');
  const custom = added.find((event) => event.item.call_id === 'call_patch');
  assert.equal(custom.item.type, 'custom_tool_call');
  assert.equal(custom.item.input, '');
  assert.equal(Object.hasOwn(custom.item, 'arguments'), false);
  assert.equal(
    events
      .filter((event) => event.type === 'response.custom_tool_call_input.delta')
      .map((event) => event.delta)
      .join(''),
    patch
  );
  assert.equal(events.find((event) => event.type === 'response.custom_tool_call_input.done').input, patch);
  assert.equal(
    events.some(
      (event) => event.type.startsWith('response.function_call_arguments.') && event.item_id === custom.item.id
    ),
    false
  );
  const ordinary = added.find((event) => event.item.call_id === 'call_inspect');
  assert.equal(
    events
      .filter((event) => event.type === 'response.function_call_arguments.delta' && event.item_id === ordinary.item.id)
      .map((event) => event.delta)
      .join(''),
    inspectArguments
  );
  const final = events.find((event) => event.type === 'response.completed').response;
  assert.equal(final.output[0].input, patch);
  assert.equal(Object.hasOwn(final.output[0], 'arguments'), false);
  assert.equal(final.output[1].arguments, inspectArguments);
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    events.map((_, index) => index + 1)
  );
});

const affectedBackend = { backend: { toolChoiceRequiresNonThinking: true } };
const assistantCall = (reasoning) => ({
  role: 'assistant',
  content: null,
  tool_calls: [toolCall('inspect', inspectArguments, 'call_inspect')],
  ...(reasoning === undefined ? {} : { reasoning_content: reasoning })
});
const result = { role: 'tool', tool_call_id: 'call_inspect', content: 'File present.' };

test('forced tool followups without reasoning continue in non-thinking mode without fabricating history', () => {
  for (const reasoning of [undefined, '']) {
    const body = {
      thinking: { type: 'enabled' },
      tool_choice: 'auto',
      messages: [{ role: 'user', content: 'Inspect the file.' }, assistantCall(reasoning), result]
    };
    const before = structuredClone(body);
    const prepared = prepareStructuredOutputForBackend(body, affectedBackend).body;
    assert.equal(prepared.thinking.type, 'disabled');
    assert.deepEqual(prepared.messages, before.messages);
    assert.deepEqual(body, before, 'normalization must not mutate caller-owned history');
    assert.equal(prepareStructuredOutputForBackend(body, {}).body, body, 'other backends retain their semantics');
  }
});

test('complete reasoning histories preserve thinking, including multiple tool iterations', () => {
  const body = {
    thinking: { type: 'enabled' },
    tool_choice: 'auto',
    messages: [
      { role: 'user', content: 'Inspect the file.' },
      assistantCall('First inspection rationale.'),
      result,
      assistantCall('Second inspection rationale.'),
      result
    ]
  };
  assert.deepEqual(prepareStructuredOutputForBackend(body, affectedBackend).body, body);
  const incomplete = structuredClone(body);
  delete incomplete.messages[1].reasoning_content;
  assert.equal(prepareStructuredOutputForBackend(incomplete, affectedBackend).body.thinking.type, 'disabled');
});

test('old non-thinking tool histories do not disable thinking after a new user turn', () => {
  const body = {
    thinking: { type: 'enabled' },
    tool_choice: 'auto',
    messages: [
      { role: 'user', content: 'Previous task.' },
      assistantCall(),
      result,
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Next task.' }
    ]
  };
  assert.deepEqual(prepareStructuredOutputForBackend(body, affectedBackend).body, body);
  const forced = { ...body, tool_choice: { type: 'function', function: { name: 'inspect' } } };
  assert.equal(prepareStructuredOutputForBackend(forced, affectedBackend).body.thinking.type, 'disabled');
});

// Codex strictly decodes both detail counters, including non-thinking turns.
test('buffered and streaming usage always provide Codex detail counters', () => {
  const response = openAIToResponses(chatCompletion([]), 'model');
  assert.equal(response.usage.input_tokens_details.cached_tokens, 0);
  assert.equal(response.usage.output_tokens_details.reasoning_tokens, 0);
  const t = createResponsesStreamTranslator('model');
  t.handleChunk({
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 3 } }
  });
  t.finish();
  const usage = t.events.at(-1).data.response.usage;
  assert.equal(usage.input_tokens_details.cached_tokens, 0);
  assert.equal(usage.output_tokens_details.reasoning_tokens, 3);
});

test('truncated custom tool input ends incomplete without an executable custom call', () => {
  const completion = chatCompletion([toolCall('apply_patch', '{"input":"unfinished', 'call_cut')]);
  completion.choices[0].finish_reason = 'length';
  const response = openAIToResponses(completion, 'model', { tools });
  assert.equal(response.status, 'incomplete');
  assert.equal(response.incomplete_details.reason, 'max_output_tokens');
  assert.deepEqual(response.output, []);
  const t = createResponsesStreamTranslator('model', { tools });
  t.handleChunk({
    choices: [
      { delta: { tool_calls: [{ index: 0, ...completion.choices[0].message.tool_calls[0] }] }, finish_reason: 'length' }
    ]
  });
  t.finish();
  assert.equal(t.events.at(-1).event, 'response.incomplete');
  assert.deepEqual(t.events.at(-1).data.response.output, []);
  assert(!t.events.some((e) => e.event === 'response.custom_tool_call_input.done'));
  assert(!t.events.some((e) => e.event === 'response.output_item.done' && e.data.item.type === 'custom_tool_call'));
});

test('malformed completed custom input is classified as an upstream error', () => {
  const completion = chatCompletion([toolCall('apply_patch', '{"input":7}', 'call_invalid')]);
  assert.throws(
    () => openAIToResponses(completion, 'model', { tools }),
    (e) => e.statusCode === 502 && e.code === 'invalid_custom_tool_input'
  );
});
