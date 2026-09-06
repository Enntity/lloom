import assert from 'node:assert/strict';
import { generateProviderVideo } from '../src/video-providers.mjs';
for (const provider of ['replicate', 'openrouter']) {
  const calls = [];
  const output = provider === 'replicate' ? 'https://replicate.delivery/test.mp4' : 'https://openrouter.ai/api/v1/videos/job/content?index=0';
  const response = await generateProviderVideo({
    backend: { videoProvider: provider, apiKey: 'test-only' },
    body: { model: 'owner/model', image: 'data:image/png;base64,YQ==', audio: 'data:audio/wav;base64,YQ==', frame_images: [{ image_url: { url: 'data:image/png;base64,YQ==' }, frame_type: 'first_frame' }] },
    sleepFn: async () => {},
    fetchFn: async (url, opts) => {
      calls.push({ url, opts });
      if (calls.length === 1) return Response.json({ id: 'job', status: 'processing' });
      if (calls.length === 2) return Response.json({ id: 'job', status: provider === 'replicate' ? 'succeeded' : 'completed', output, unsigned_urls: [output] });
      return new Response('video', { headers: { 'content-type': 'video/mp4' } });
    }
  });
  assert.equal(await response.text(), 'video');
  assert.equal(calls[0].opts.headers.Authorization, provider === 'replicate' ? 'Token test-only' : 'Bearer test-only');
  assert.equal(calls[2].opts.headers.Authorization, provider === 'replicate' ? undefined : 'Bearer test-only');
  assert.equal(calls[0].opts.redirect, 'error');
}
await assert.rejects(generateProviderVideo({ backend: { videoProvider: 'replicate', apiKey: 'test' }, body: { model: 'owner/model', image: '/private/file', audio: 'data:audio/wav;base64,YQ==' } }), /data URI/);
await assert.rejects(generateProviderVideo({ backend: { videoProvider: 'replicate', apiKey: 'test' }, body: { model: 'owner/model', image: 'data:image/png;base64,YQ==', audio: 'data:audio/wav;base64,YQ==' }, fetchFn: async () => Response.json({ id: 'job', status: 'succeeded', output: 'https://attacker.test/video' }) }), /Untrusted/);
console.log('Provider polling, credential isolation, media return and origin checks passed');
