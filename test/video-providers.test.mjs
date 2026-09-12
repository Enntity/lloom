import assert from 'node:assert/strict';
import { generateProviderVideo, findRecentVideoJob } from '../src/video-providers.mjs';
for (const provider of ['replicate', 'openrouter']) {
  const calls = [];
  const output =
    provider === 'replicate'
      ? 'https://replicate.delivery/test.mp4'
      : 'https://openrouter.ai/api/v1/videos/job/content?index=0';
  const response = await generateProviderVideo({
    backend: { videoProvider: provider, apiKey: 'test-only' },
    body: {
      model: 'owner/model',
      image: 'data:image/png;base64,YQ==',
      audio: 'data:audio/wav;base64,YQ==',
      frame_images: [{ image_url: { url: 'data:image/png;base64,YQ==' }, frame_type: 'first_frame' }]
    },
    sleepFn: async () => {},
    fetchFn: async (url, opts) => {
      calls.push({ url, opts });
      if (calls.length === 1) return Response.json({ id: 'job', status: 'processing' });
      if (calls.length === 2)
        return Response.json({
          id: 'job',
          status: provider === 'replicate' ? 'succeeded' : 'completed',
          output,
          unsigned_urls: [output]
        });
      return new Response('video', { headers: { 'content-type': 'video/mp4' } });
    }
  });
  assert.equal(await response.text(), 'video');
  assert.equal(calls[0].opts.headers.Authorization, provider === 'replicate' ? 'Token test-only' : 'Bearer test-only');
  assert.equal(calls[2].opts.headers.Authorization, provider === 'replicate' ? undefined : 'Bearer test-only');
  assert.equal(calls[0].opts.redirect, 'error');
}
await assert.rejects(
  generateProviderVideo({
    backend: { videoProvider: 'replicate', apiKey: 'test' },
    body: { model: 'owner/model', image: '/private/file', audio: 'data:audio/wav;base64,YQ==' }
  }),
  /data URI/
);
await assert.rejects(
  generateProviderVideo({
    backend: { videoProvider: 'replicate', apiKey: 'test' },
    body: { model: 'owner/model', image: 'data:image/png;base64,YQ==', audio: 'data:audio/wav;base64,YQ==' },
    fetchFn: async () => Response.json({ id: 'job', status: 'succeeded', output: 'https://attacker.test/video' })
  }),
  /Untrusted/
);
console.log('Provider polling, credential isolation, media return and origin checks passed');

const upscaleBody = {
  model: 'topazlabs/video-upscale',
  video: 'data:video/mp4;base64,YQ==',
  target_resolution: '1080p',
  target_fps: 24
};
let submitted;
const upscale = await generateProviderVideo({
  backend: { videoProvider: 'replicate', apiKey: 'test' },
  body: { ...upscaleBody, unexpected: 'must not reach provider' },
  fetchFn: async (url, options) => {
    if (options.method === 'POST') {
      submitted = JSON.parse(options.body);
      return Response.json({ id: 'upscale', status: 'succeeded', output: ['https://replicate.delivery/upscale.mp4'] });
    }
    assert.equal(options.headers.Authorization, undefined);
    return new Response('upscaled', { headers: { 'content-type': 'video/mp4' } });
  }
});
assert.equal(await upscale.text(), 'upscaled');
assert.deepEqual(submitted.input, { video: upscaleBody.video, target_resolution: '1080p', target_fps: 24 });
for (const change of [
  { video: 'https://private.test/video.mp4' },
  { target_resolution: '8k' },
  { target_fps: 0 },
  { target_fps: 61 },
  { target_fps: 24.5 }
]) {
  await assert.rejects(
    generateProviderVideo({
      backend: { videoProvider: 'replicate', apiKey: 'test' },
      body: { ...upscaleBody, ...change },
      fetchFn: async () => {
        assert.fail('invalid input reached provider');
      }
    }),
    /data URI|Invalid/
  );
}
console.log('Topaz inputs, output bytes and credential isolation passed');

const retakeBody = {
  model: 'lightricks/ltx-2.3-pro',
  task: 'retake',
  video: upscaleBody.video,
  prompt: 'She returns naturally to her relaxed standing pose.',
  retake_start_time: 2,
  retake_duration: 2
};
const retake = await generateProviderVideo({
  backend: { videoProvider: 'replicate', apiKey: 'test-only' },
  body: { ...retakeBody, unexpected: 'discard' },
  fetchFn: async (url, options) => {
    if (options.method === 'POST') {
      assert.equal(url, 'https://api.replicate.com/v1/models/lightricks/ltx-2.3-pro/predictions');
      assert.deepEqual(JSON.parse(options.body).input, {
        task: 'retake',
        video: retakeBody.video,
        prompt: retakeBody.prompt,
        retake_start_time: 2,
        retake_duration: 2,
        retake_mode: 'replace_video',
        resolution: '1080p',
        aspect_ratio: '16:9',
        fps: 24
      });
      return Response.json({ id: 'retake', status: 'succeeded', output: 'https://replicate.delivery/retake.mp4' });
    }
    assert.equal(options.headers.Authorization, undefined);
    return new Response('retaken', { headers: { 'content-type': 'video/mp4' } });
  }
});
assert.equal(await retake.text(), 'retaken');
assert.equal(retake.headers.get('x-lloom-provider-job-id'), 'retake');
for (const change of [
  { task: 'extend' },
  { video: 'https://private.test/a.mp4' },
  { prompt: '' },
  { retake_start_time: -1 },
  { retake_start_time: '2' },
  { retake_duration: 1.99 },
  { retake_duration: Infinity },
  { resolution: '720p' },
  { fps: 30 },
  { aspect_ratio: '1:1' },
  { retake_mode: 'replace_audio' },
  { frame_images: [] },
  { last_frame_image: 'data:image/png;base64,YQ==' }
]) {
  await assert.rejects(
    generateProviderVideo({
      backend: { videoProvider: 'replicate', apiKey: 'test-only' },
      body: { ...retakeBody, ...change },
      fetchFn: async () => assert.fail('invalid or unsupported retake reached provider')
    }),
    /requires|required|Invalid|video context/
  );
}
console.log('LTX retake interval, media input, endpoint incompatibility and attribution checks passed');

const editBody = { model: 'kwaivgi/kling-o1', video: upscaleBody.video, prompt: 'Restore clarity', mode: 'pro' };
await generateProviderVideo({
  backend: { videoProvider: 'replicate', apiKey: 'test' },
  body: { ...editBody, video_reference_type: 'feature', unexpected: 'discard' },
  fetchFn: async (url, options) => {
    if (options.method === 'POST') {
      const { input } = JSON.parse(options.body);
      assert.deepEqual(input, {
        reference_video: editBody.video,
        video_reference_type: 'base',
        prompt: editBody.prompt,
        mode: 'pro',
        keep_original_sound: true,
        reference_images: []
      });
      return Response.json({ id: 'edit', status: 'succeeded', output: 'https://replicate.delivery/edit.mp4' });
    }
    assert.equal(options.headers.Authorization, undefined);
    return new Response('edited', { headers: { 'content-type': 'video/mp4' } });
  }
});
for (const change of [
  { video: 'https://private.test/a.mp4' },
  { prompt: '' },
  { mode: 'unknown' },
  { reference_images: ['https://private.test/a.png'] },
  { reference_images: Array(5).fill('data:image/png;base64,YQ==') }
]) {
  await assert.rejects(
    generateProviderVideo({
      backend: { videoProvider: 'replicate', apiKey: 'test' },
      body: { ...editBody, ...change },
      fetchFn: async () => assert.fail('invalid edit reached provider')
    }),
    /required|Invalid/
  );
}
console.log('Video editing contract and input isolation passed');

await assert.rejects(
  generateProviderVideo({
    backend: { videoProvider: 'replicate', apiKey: 'test' },
    body: {
      ...editBody,
      frame_images: ['first_frame', 'last_frame'].map((frame_type) => ({
        frame_type,
        image_url: { url: 'data:image/png;base64,YQ==' }
      }))
    },
    fetchFn: async () => assert.fail('unsupported video/end-frame combination reached provider')
  }),
  /last frame with video input/
);
console.log('Unsupported video/end-frame combination is rejected before a paid request');

const recovered = await findRecentVideoJob({
  backend: { videoProvider: 'replicate', apiKey: 'test-only' },
  model: editBody.model,
  prompt: editBody.prompt,
  fetchFn: async (url, options) => {
    assert.equal(url, 'https://api.replicate.com/v1/predictions');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Token test-only');
    return Response.json({
      results: [
        { id: 'other', model: editBody.model, input: { prompt: 'unrelated private prompt' } },
        {
          id: 'failed-edit',
          model: editBody.model,
          status: 'failed',
          input: { prompt: editBody.prompt, reference_video: 'data:video/mp4;base64,YQ==' },
          error: 'Bad input data:image/png;base64,YQ== at https://provider.test/private',
          output: null
        }
      ]
    });
  }
});
assert.equal(recovered.length, 1);
assert.equal(recovered[0].jobId, 'failed-edit');
assert.equal(recovered[0].hasOutput, false);
assert.equal(recovered[0].error, 'Bad input [media] at [URL]');
assert.ok(!JSON.stringify(recovered).includes(editBody.prompt));
assert.ok(!JSON.stringify(recovered).includes('base64'));
await assert.rejects(
  generateProviderVideo({
    backend: { videoProvider: 'replicate', apiKey: 'test' },
    body: editBody,
    fetchFn: async () => Response.json({ id: 'failed-edit', status: 'failed' })
  }),
  (error) =>
    error.providerJobId === 'failed-edit' && error.providerStatus === 'failed' && error.message.includes('failed-edit')
);
console.log(
  'Read-only job recovery filters exact requests and hides input media; terminal failures retain job attribution'
);

const bridgeBody = {
  model: 'kwaivgi/kling-v3-video',
  prompt: 'Preserve the exact subject',
  duration: 3,
  frame_images: ['first_frame', 'last_frame'].map((frame_type) => ({
    frame_type,
    image_url: { url: 'data:image/png;base64,YQ==' }
  }))
};
await generateProviderVideo({
  backend: { videoProvider: 'replicate', apiKey: 'test' },
  body: bridgeBody,
  fetchFn: async (url, options) => {
    if (options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body).input, {
        start_image: 'data:image/png;base64,YQ==',
        end_image: 'data:image/png;base64,YQ==',
        prompt: bridgeBody.prompt,
        duration: 3,
        mode: 'standard',
        generate_audio: false
      });
      return Response.json({ id: 'bridge', status: 'succeeded', output: 'https://replicate.delivery/bridge.mp4' });
    }
    return new Response('bridge', { headers: { 'content-type': 'video/mp4' } });
  }
});
for (const change of [
  { duration: 2 },
  { frame_images: [bridgeBody.frame_images[0], bridgeBody.frame_images[0]] },
  { mode: 'invalid' }
]) {
  await assert.rejects(
    generateProviderVideo({
      backend: { videoProvider: 'replicate', apiKey: 'test' },
      body: { ...bridgeBody, ...change },
      fetchFn: async () => assert.fail('invalid bridge submitted')
    }),
    /Invalid|required/
  );
}
await assert.rejects(
  generateProviderVideo({
    backend: { videoProvider: 'replicate', apiKey: 'test' },
    body: bridgeBody,
    fetchFn: async () => new Response('', { status: 402 })
  }),
  (e) => e.statusCode === 402
);
console.log('Kling start/end mapping, validation and upstream status passed');
let rateAttempts = 0;
const rateDelays = [];
await generateProviderVideo({
  backend: { videoProvider: 'replicate', apiKey: 'test' },
  body: bridgeBody,
  sleepFn: async (ms) => rateDelays.push(ms),
  fetchFn: async (url, options) => {
    if (options.method === 'POST') {
      if (++rateAttempts === 1) return new Response('', { status: 429, headers: { 'retry-after': '2' } });
      return Response.json({ id: 'retry', status: 'succeeded', output: 'https://replicate.delivery/retry.mp4' });
    }
    return new Response('video');
  }
});
assert.equal(rateAttempts, 2);
assert.deepEqual(rateDelays, [2000]);
console.log('Explicit rate-limit rejection retries respect Retry-After');

await generateProviderVideo({
  backend: { videoProvider: 'replicate', apiKey: 'test' },
  body: { ...bridgeBody, frame_images: [bridgeBody.frame_images[0]], prompt: 'She nods in agreement.' },
  fetchFn: async (url, options) => {
    if (options.method === 'POST') {
      const input = JSON.parse(options.body).input;
      assert.equal(input.start_image, 'data:image/png;base64,YQ==');
      assert.equal(Object.hasOwn(input, 'end_image'), false);
      assert.equal(input.prompt, 'She nods in agreement.');
      return Response.json({ id: 'reel', status: 'succeeded', output: 'https://replicate.delivery/reel.mp4' });
    }
    return new Response('reel', { headers: { 'content-type': 'video/mp4' } });
  }
});
await assert.rejects(
  generateProviderVideo({
    backend: { videoProvider: 'replicate', apiKey: 'test' },
    body: { ...bridgeBody, frame_images: [bridgeBody.frame_images[1]] },
    fetchFn: async () => assert.fail('end-only input reached provider')
  }),
  /required/
);
console.log('First-frame-only performance reel contract passed');

const shortJoin = { ...bridgeBody, model: 'lucataco/wan-2.2-first-last-frame', duration: 9 / 16, seed: 42 };
await generateProviderVideo({
  backend: { videoProvider: 'replicate', apiKey: 'test' },
  body: shortJoin,
  fetchFn: async (url, options) => {
    if (options.method === 'POST') {
      assert.equal(url, 'https://api.replicate.com/v1/predictions');
      const payload = JSON.parse(options.body);
      assert.equal(payload.version, '003fd8a38ff17cb6022c3117bb90f7403cb632062ba2b098710738d116847d57');
      assert.equal(payload.input.duration_seconds, 9 / 16);
      assert.equal(payload.input.seed, 42);
      assert.equal(payload.input.start_image, 'data:image/png;base64,YQ==');
      assert.equal(payload.input.end_image, 'data:image/png;base64,YQ==');
      return Response.json({ id: 'short', status: 'succeeded', output: 'https://replicate.delivery/short.mp4' });
    }
    return new Response('short', { headers: { 'content-type': 'video/mp4' } });
  }
});
for (const duration of [0.5, 1, 10, NaN])
  await assert.rejects(
    generateProviderVideo({
      backend: { videoProvider: 'replicate', apiKey: 'test' },
      body: { ...shortJoin, duration },
      fetchFn: async () => assert.fail('invalid short duration reached provider')
    }),
    /Invalid/
  );
console.log('Pinned subsecond join mapping and frame-lattice validation passed');

const viduJoin = { ...bridgeBody, model: 'vidu/q3-pro', duration: 1, resolution: '1080p' };
await generateProviderVideo({
  backend: { videoProvider: 'replicate', apiKey: 'test' },
  body: viduJoin,
  fetchFn: async (url, options) => {
    if (options.method === 'POST') {
      assert.equal(url, 'https://api.replicate.com/v1/models/vidu/q3-pro/predictions');
      const input = JSON.parse(options.body).input;
      assert.equal(input.duration, 1);
      assert.equal(input.resolution, '1080p');
      assert.equal(input.audio, false);
      assert.equal(input.start_image, 'data:image/png;base64,YQ==');
      assert.equal(input.end_image, 'data:image/png;base64,YQ==');
      return Response.json({ id: 'vidu', status: 'succeeded', output: 'https://replicate.delivery/vidu.mp4' });
    }
    return new Response('vidu', { headers: { 'content-type': 'video/mp4' } });
  }
});
for (const duration of [0, 0.5, 17])
  await assert.rejects(
    generateProviderVideo({
      backend: { videoProvider: 'replicate', apiKey: 'test' },
      body: { ...viduJoin, duration },
      fetchFn: async () => assert.fail('invalid Vidu duration reached provider')
    }),
    /Invalid/
  );
console.log('Vidu one-second high-resolution join contract passed');

// A 2xx response carrying a non-JSON body must not surface the provider's
// payload to the caller: `response.json()` errors embed the first bytes of the
// body, and the gateway forwards `error.message` verbatim.
await assert.rejects(
  generateProviderVideo({
    backend: { videoProvider: 'replicate', apiKey: 'test' },
    body: {
      model: 'topazlabs/video-upscale',
      video: 'data:video/mp4;base64,YQ==',
      target_resolution: '720p',
      target_fps: 24
    },
    sleepFn: async () => {},
    fetchFn: async () => new Response('LEAKMARK rest-of-provider-payload', { status: 200 })
  }),
  (error) => {
    assert.ok(
      !error.message.includes('LEAKMARK'),
      `a provider body fragment must not reach the caller: ${error.message}`
    );
    return true;
  }
);
console.log('A non-JSON provider response does not leak the provider body to callers');
