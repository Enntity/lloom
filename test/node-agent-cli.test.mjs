import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { handleNodeAgentRequest, runNodeAgentCli } from '../src/node-agent-cli.mjs';

function capture() {
  let value = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk;
        callback();
      }
    }),
    value: () => value
  };
}

test('node-agent JSON boundary dispatches a phase without exposing request content', async () => {
  const output = capture();
  const agent = {
    async preflight(nodeId, context) {
      assert.equal(nodeId, 'node-1');
      assert.equal(context.operationId, 'op-1');
      return { operationId: context.operationId, nodeId, phase: 'preflight', status: 'ok' };
    }
  };
  await handleNodeAgentRequest({
    phase: 'preflight',
    input: { nodeId: 'node-1', operationId: 'op-1', secret: 'must-not-be-echoed' },
    agent,
    output: output.stream
  });
  assert.match(output.value(), /"operationId":"op-1"/);
  assert.doesNotMatch(output.value(), /must-not-be-echoed/);
});

test('node-agent CLI returns sanitized JSON on an injected failure', async () => {
  const output = capture();
  const errors = capture();
  const result = await runNodeAgentCli({
    argv: ['stage', '--json'],
    input: Readable.from([JSON.stringify({ nodeId: 'node-1', operationId: 'op-1' })]),
    output: output.stream,
    errorOutput: errors.stream,
    agent: {
      async stage() {
        throw Object.assign(new Error('private request body'), { code: 'artifact_digest_mismatch' });
      }
    }
  });
  assert.equal(result.ok, false);
  assert.match(errors.value(), /artifact_digest_mismatch/);
  assert.doesNotMatch(errors.value(), /private request body/);
});
