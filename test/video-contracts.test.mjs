import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createLloomServer } from '../src/server.mjs';
import { videoContractForModel, prepareVideoRequest, videoCatalog } from '../src/video-contracts.mjs';
const PUBLIC = ['Lightricks/LTX-2.5-Full', 'Lightricks/LTX-2.5-Distilled'];
const REMOVED = [
  'Lightricks/LTX-2.5-Dev',
  'Lightricks/LTX-2.5-Dev-HQ',
  'Lightricks/LTX-2.5-A2V',
  'Lightricks/LTX-2.5-Keyframes',
  'Lightricks/LTX-2.5-Retake',
  'Lightricks/LTX-2.5-DFR'
];
const IMAGE = 'data:image/png;base64,eA==';
const AUDIO = 'data:audio/wav;base64,eA==';
const VIDEO = 'data:video/mp4;base64,eA==';

test('only the two public native IDs resolve; removed IDs are rejected', () => {
  for (const id of PUBLIC) assert.equal(videoContractForModel(id).family, 'ltx-native');
  for (const id of REMOVED) assert.throws(() => videoContractForModel(id), /no longer a public model/);
});

test('workflow defaults to generate and every explicit workflow is honoured', () => {
  assert.equal(videoContractForModel('Lightricks/LTX-2.5-Full').workflow, 'generate');
  assert.equal(videoContractForModel('Lightricks/LTX-2.5-Distilled').workflow, 'generate');
  assert.equal(videoContractForModel('Lightricks/LTX-2.5-Full', 'generate-hq').workflow, 'generate-hq');
  assert.equal(videoContractForModel('Lightricks/LTX-2.5-Full', 'audio-to-video').workflow, 'audio-to-video');
  assert.equal(videoContractForModel('Lightricks/LTX-2.5-Full', 'keyframes').workflow, 'keyframes');
  assert.equal(videoContractForModel('Lightricks/LTX-2.5-Distilled', 'retake').workflow, 'retake');
  assert.equal(videoContractForModel('Lightricks/LTX-2.5-Distilled', 'refine').workflow, 'refine');
  assert.equal(prepareVideoRequest('Lightricks/LTX-2.5-Full', { prompt: 'x' }).workflow, undefined);
  assert.deepEqual(videoContractForModel('Lightricks/LTX-2.5-Full', 'generate').fields.includes('workflow'), true);
});

test('explicit workflow field must be a supported non-empty string', () => {
  const id = 'Lightricks/LTX-2.5-Full';
  for (const workflow of [null, [], {}, 3, true, '', '  '])
    assert.throws(() => videoContractForModel(id, workflow), /workflow/);
  for (const workflow of [null, [], {}, 3, '', '  '])
    assert.throws(() => prepareVideoRequest(id, { prompt: 'x', workflow }), /workflow/);
  assert.throws(() => videoContractForModel(id, 'Dev'), /does not support workflow/);
  assert.throws(() => prepareVideoRequest(id, { prompt: 'x', workflow: 'Dev' }), /does not support workflow/);
  // Wrong-family workflow names are rejected instead of inferred.
  assert.throws(() => videoContractForModel('Lightricks/LTX-2.5-Full', 'retake'), /does not support workflow/);
  assert.throws(
    () => videoContractForModel('Lightricks/LTX-2.5-Distilled', 'audio-to-video'),
    /does not support workflow/
  );
  assert.throws(() => videoContractForModel('Lightricks/LTX-2.5-Distilled', 'keyframes'), /does not support workflow/);
});

test('workflow is never inferred from audio or video presence', () => {
  // Audio alone must not select audio-to-video; generate does not accept audio.
  assert.throws(
    () => prepareVideoRequest('Lightricks/LTX-2.5-Full', { prompt: 'x', audio: AUDIO }),
    /does not support 'audio'/
  );
  // Video alone on the distilled default must not select retake.
  assert.throws(
    () => prepareVideoRequest('Lightricks/LTX-2.5-Distilled', { prompt: 'x', video: VIDEO }),
    /does not support 'video'/
  );
});

test('full generate accepts guided fields and rejects A2V-only controls', () => {
  const id = 'Lightricks/LTX-2.5-Full';
  const fields = videoContractForModel(id, 'generate').fields;
  assert.ok(fields.includes('guidance_scale'));
  assert.ok(fields.includes('steps'));
  assert.ok(fields.includes('negative_prompt'));
  assert.ok(!fields.includes('audio'));
  assert.ok(!fields.includes('sampler'));
  assert.equal(prepareVideoRequest(id, { prompt: 'x', audio_guidance_scale: 3 }).audio_guidance_scale, 3);
  assert.throws(() => prepareVideoRequest(id, { prompt: 'x', sampler: 'euler' }), /does not support/);
});

test('full audio-to-video keeps sampler, audio guidance and frozen audio contract', () => {
  const id = 'Lightricks/LTX-2.5-Full';
  const contract = videoContractForModel(id, 'audio-to-video');
  assert.equal(contract.references.audio, 'driving audio preserved; silence appended if needed');
  assert.ok(contract.fields.includes('sampler'));
  assert.ok(!contract.fields.includes('audio_guidance_scale'));
  assert.ok(contract.fields.includes('audio_start_time'));
  assert.ok(contract.fields.includes('guidance_scale'));
  assert.ok(!contract.fields.includes('v2a_guidance_scale'));
  assert.ok(!contract.fields.includes('generated_keyframes'));
  for (const sampler of ['euler', 'euler_ancestral'])
    assert.equal(
      prepareVideoRequest(id, { prompt: 'x', workflow: 'audio-to-video', audio: AUDIO, sampler }).sampler,
      sampler
    );
  for (const sampler of [null, true, 'typo', {}])
    assert.throws(
      () => prepareVideoRequest(id, { prompt: 'x', workflow: 'audio-to-video', audio: AUDIO, sampler }),
      /sampler/
    );
  assert.throws(() => prepareVideoRequest(id, { prompt: 'x', workflow: 'audio-to-video' }), /requires audio/);
});

test('keyframes rejects automatic guide generation; generate and HQ preserve it', () => {
  for (const workflow of ['generate', 'generate-hq'])
    assert.equal(
      prepareVideoRequest(PUBLIC[0], { prompt: 'x', workflow, generated_keyframes: 1 }).generated_keyframes,
      1
    );
  for (const workflow of ['keyframes'])
    assert.throws(
      () => prepareVideoRequest('Lightricks/LTX-2.5-Full', { prompt: 'x', workflow, generated_keyframes: 1 }),
      /does not support 'generated_keyframes'/
    );
});

test('distilled refine rejects steps, negative, guidance and generated_keyframes', () => {
  const id = 'Lightricks/LTX-2.5-Distilled';
  const fields = videoContractForModel(id, 'refine').fields;
  for (const field of ['steps', 'negative_prompt', 'guidance_scale', 'generated_keyframes', 'audio'])
    assert.ok(!fields.includes(field), `refine must not expose ${field}`);
  assert.throws(() => prepareVideoRequest(id, { prompt: 'x', workflow: 'refine', steps: 8 }), /does not support/);
  assert.throws(
    () => prepareVideoRequest(id, { prompt: 'x', workflow: 'refine', negative_prompt: 'n' }),
    /does not support/
  );
  assert.throws(
    () => prepareVideoRequest(id, { prompt: 'x', workflow: 'refine', guidance_scale: 3 }),
    /does not support/
  );
  assert.throws(
    () => prepareVideoRequest(id, { prompt: 'x', workflow: 'refine', generated_keyframes: 1 }),
    /does not support/
  );
});

test('distilled retake preserves its precise validation', () => {
  const id = 'Lightricks/LTX-2.5-Distilled';
  const ok = prepareVideoRequest(id, { prompt: 'x', workflow: 'retake', video: VIDEO, start_time: 0, end_time: 1 });
  assert.equal(ok.workflow, 'retake');
  assert.throws(
    () => prepareVideoRequest(id, { prompt: 'x', workflow: 'retake', video: VIDEO, start_time: 0, end_time: 0 }),
    /Retake requires/
  );
  assert.throws(
    () => prepareVideoRequest(id, { prompt: 'x', workflow: 'retake', start_time: 0, end_time: 1 }),
    /Retake requires/
  );
  assert.throws(
    () =>
      prepareVideoRequest(id, { prompt: 'x', workflow: 'retake', video: VIDEO, start_time: 0, end_time: 1, fps: 24 }),
    /does not support/
  );
});

test('non-LTX and Comfy behaviour is preserved', () => {
  assert.equal(videoContractForModel('Lightricks/LTX-2.5').workflow, 'distilled');
  assert.equal(videoContractForModel('Lightricks/LTX-2.5-Comfy-Full').steps.default, 30);
  assert.equal(videoContractForModel('Lightricks/LTX-2.5-Comfy-Full', 'full').workflow, 'full');
  const comfy = prepareVideoRequest('Lightricks/LTX-2.5', { prompt: { action: 'A person speaks.' } });
  assert.equal(comfy.prompt, 'action: A person speaks.');
  assert.equal(videoContractForModel('MiniMaxAI/MiniMax-H3').family, 'minimax-h3');
  assert.throws(() => prepareVideoRequest('MiniMaxAI/MiniMax-H3', { prompt: 'x', fps: 30 }), /Invalid fps/);
  assert.equal(videoContractForModel('Wan-AI/Wan2.2-TI2V-5B-Diffusers').references.video, false);
});

test('unknown provider passthrough is retained, not treated as a workflow error', () => {
  assert.equal(videoContractForModel('other/vendor-model'), null);
  assert.deepEqual(prepareVideoRequest('other/vendor-model', { prompt: 'x' }), { prompt: 'x' });
  assert.deepEqual(prepareVideoRequest('constructor', { prompt: 'x' }), { prompt: 'x' });
});

test('removed native IDs are rejected explicitly, never passed through as unknown providers', () => {
  for (const id of REMOVED) {
    assert.throws(() => videoContractForModel(id), /no longer a public model/);
    assert.throws(() => prepareVideoRequest(id, { prompt: 'x' }), /no longer a public model/);
  }
  // The Comfy LTX IDs are unchanged and still resolve.
  assert.equal(videoContractForModel('Lightricks/LTX-2.5').family, 'ltx-comfy');
  assert.equal(videoContractForModel('Lightricks/LTX-2.5-Comfy-Full').family, 'ltx-comfy');
});

test('catalog discovery exposes default_workflow and precise per-workflow objects', () => {
  const catalog = videoCatalog([
    { id: 'ltx-full', kind: 'video', upstreamModel: 'Lightricks/LTX-2.5-Full' },
    { id: PUBLIC[1], kind: 'video', upstreamModel: PUBLIC[1] }
  ]);
  const entry = catalog.data[0];
  assert.equal(entry.family, 'ltx-native');
  assert.equal(entry.model, 'Lightricks/LTX-2.5-Full');
  assert.equal(entry.default_workflow, 'generate');
  assert.deepEqual(Object.keys(entry.workflows), ['generate', 'generate-hq', 'audio-to-video', 'keyframes']);
  const a2v = entry.workflows['audio-to-video'];
  assert.ok(a2v.references.audio);
  assert.ok(a2v.timing.frameGrid);
  assert.ok(a2v.notes.length);
  assert.ok(!a2v.fields.includes('audio_guidance_scale'));
  assert.ok(a2v.fields.includes('guidance_scale'));
  assert.ok(entry.workflows.keyframes.fields.includes('guidance_scale'));
  assert.ok(catalog.data.find((m) => m.id === PUBLIC[1]).workflows.refine.fields.includes('temporal_upscalings'));
  assert.ok(!entry.workflows.generate.fields.includes('audio'));
});

test('HTTP discovery and proxy preserve native workflow, references and default selection', async (t) => {
  const calls = [];
  const backend = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: body.model, workflow: body.workflow ?? 'generate', data: [{ b64_json: 'eA==' }] }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const ids = [...PUBLIC, 'MiniMaxAI/MiniMax-H3', 'Lightricks/LTX-2.5'];
  const app = createLloomServer(
    {
      server: { host: '127.0.0.1', port: 0 },
      security: { allowMissingAuth: true, apiKeys: [] },
      logging: { metricsPersistence: false },
      telemetry: { performanceSampler: false },
      backends: {
        video: { type: 'openai', baseUrl: `http://127.0.0.1:${backend.address().port}/v1`, apiKey: 'test-only' }
      },
      models: ids.map((id) => ({ id, upstreamModel: id, kind: 'video', backend: 'video' }))
    },
    { logger: { error() {}, warn() {} } }
  );
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    app.server.closeAllConnections();
    backend.closeAllConnections();
    await app.close({ stopRuntimes: false });
    await new Promise((r) => backend.close(r));
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const catalog = await (await fetch(base + '/v1/videos/generations/models')).json();
  const full = catalog.data.find((m) => m.id === PUBLIC[0]);
  assert.equal(full.default_workflow, 'generate');
  assert.equal(full.workflows['audio-to-video'].defaults.sampler, 'euler_ancestral');
  assert.equal(catalog.data.filter((m) => m.family === 'ltx-native').length, 2);
  const post = (body) =>
    fetch(base + '/v1/videos/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  for (const body of [
    {
      model: PUBLIC[0],
      workflow: 'audio-to-video',
      prompt: { description: 'A speaker', motion: 'Blink naturally' },
      audio: AUDIO,
      image: IMAGE,
      last_frame: IMAGE,
      guidance_scale: 3,
      sampler: 'euler_ancestral'
    },
    { model: PUBLIC[1], prompt: 'Small head movement' }
  ]) {
    const r = await post(body);
    assert.equal(r.status, 200);
    const result = await r.json();
    assert.equal(result.model, body.model);
    assert.equal(result.workflow, body.workflow ?? 'generate');
    assert.deepEqual(calls.at(-1), body);
  }
  const count = calls.length;
  for (const body of [
    { model: PUBLIC[0], workflow: null },
    { model: PUBLIC[1], workflow: 'audio-to-video' },
    { model: PUBLIC[0], workflow: 'audio-to-video', audio: AUDIO, audio_guidance_scale: 3 },
    { model: PUBLIC[0], workflow: 'keyframes', generated_keyframes: 1 }
  ])
    assert.equal((await post({ prompt: 'x', ...body })).status, 400);
  assert.equal(calls.length, count);
  const h3 = {
    model: 'MiniMaxAI/MiniMax-H3',
    workflow: 'reference',
    prompt: { description: 'A speaker' },
    image: IMAGE,
    audio: AUDIO,
    video: VIDEO,
    transcript: 'Hello'
  };
  assert.equal((await post(h3)).status, 200);
  assert.deepEqual(calls.at(-1), h3);
  assert.equal((await post({ model: 'Lightricks/LTX-2.5', prompt: { action: 'Turn slowly' } })).status, 200);
  assert.equal(calls.at(-1).prompt, 'action: Turn slowly');
});
