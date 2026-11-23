import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareImageRequest } from '../src/image-request.mjs';

const local = 'http://localhost:8230/v1';
const cloud = 'https://openrouter.ai/api/v1';
const inline = { model: 'image-edit', prompt: 'Edit the corners', image: 'data:image/png;base64,AQID' };

test('OpenRouter receives inline edit bytes as an image reference', () => {
  const request = prepareImageRequest(cloud, 'gemini', inline);
  assert.deepEqual(request, { model: 'gemini', prompt: inline.prompt, input_references: [
    { type: 'image_url', image_url: { url: inline.image } }
  ] });
  assert.ok(inline.image);
});
test('local edits and existing OpenRouter requests preserve their payload', () => {
  assert.deepEqual(prepareImageRequest(local, 'qwen', inline), { ...inline, model: 'qwen' });
  for (const body of [{ prompt: 'Draw a cat' }, { prompt: 'Edit', input_references: [{ type: 'image_url', image_url: {url: 'https://example.com/cat.png'} }] }]) {
    assert.deepEqual(prepareImageRequest(cloud, 'gemini', body), { ...body, model: 'gemini' });
  }
});
