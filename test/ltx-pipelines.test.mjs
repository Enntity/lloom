#!/usr/bin/env node
// CPU contract tests for the native LTX-2.5 backend.
//
// Two public model IDs remain: Lightricks/LTX-2.5-Full and
// Lightricks/LTX-2.5-Distilled. The breaking simplification removed every
// compatibility gateway ID (Dev, Dev-HQ, A2V, Keyframes, Retake, DFR); callers
// now select a model plus a ``workflow`` string (Full: generate, generate-hq,
// audio-to-video, keyframes; Distilled: generate, retake, refine). Tests below
// use the real model+workflow request fields, never a hidden alias or
// compatibility conversion, and explicitly reject the removed IDs.
//
// No GPU, no torch, no weights: the Python validation module is imported
// directly, and the server is exercised against a fake pipeline shim that
// writes a deterministic MP4. Covered: the nested pipeline table, workflow
// selection and pairing, per-workflow capability gating, size/fps/
// response_format aliases, the geometry and area ceilings, num_frames = 8k+1,
// first/last-frame indices, the audio-to-video duration rule, real image/audio
// header decoding, MODEL_ROOT containment, per-workflow health readiness,
// single-flight behaviour, and timeout/cancel process-group reaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BACKEND = path.join(ROOT, 'backends', 'ltx-pipelines');
const PY = path.join(BACKEND, 'pipelines.py');

// The only two public gateway model IDs.
const FULL = 'Lightricks/LTX-2.5-Full';
const DISTILLED = 'Lightricks/LTX-2.5-Distilled';
const ALL_IDS = [FULL, DISTILLED];

// Compatibility gateway IDs that no longer exist; every request that names one
// must be rejected with 404 instead of being silently converted.
const REMOVED_IDS = [
  'Lightricks/LTX-2.5-Dev',
  'Lightricks/LTX-2.5-Dev-HQ',
  'Lightricks/LTX-2.5-A2V',
  'Lightricks/LTX-2.5-Keyframes',
  'Lightricks/LTX-2.5-Retake',
  'Lightricks/LTX-2.5-DFR'
];

// Workflow names, one per former gateway ID.
const GENERATE = 'generate';
const GENERATE_HQ = 'generate-hq';
const A2V = 'audio-to-video';
const KEYFRAMES = 'keyframes';
const RETAKE = 'retake';
const REFINE = 'refine';

// A request body for one model+workflow pair. ``workflow`` is an explicit
// string field; omitting it defaults to generate for either model.
function req(model, workflow, fields = {}) {
  const body = { model, prompt: 'x', ...fields };
  if (workflow !== undefined) body.workflow = workflow;
  return body;
}

// Drive pipelines.py in-process and print a JSON result, so every assertion
// below runs against the real validation code.
function py(script) {
  const result = spawnSync(
    'python3',
    ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(BACKEND)}); import pipelines; ${script}`],
    { encoding: 'utf8' }
  );
  return result;
}

// Same as ``py`` but the JSON payload is delivered over stdin, so fixtures can
// be far larger than the process argument limit (a long WAV is tens of MB).
function pyJson(payload, script) {
  const preamble = `import sys, json\nsys.path.insert(0, ${JSON.stringify(BACKEND)})\nimport pipelines\npayload = json.load(sys.stdin)\n`;
  return spawnSync('python3', ['-c', preamble + script], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    maxBuffer: 64 * 1024 * 1024
  });
}

function parseOk(payload) {
  // ``spec`` is the pipeline descriptor and the decode fields carry raw
  // ``bytes``; drop the descriptor key and stringify leftover bytes so the
  // whole parsed dict can round-trip through JSON.
  const result = pyJson(
    payload,
    `spec = pipelines.parse_generation(payload)
spec.pop("spec", None)
print(json.dumps(spec, default=lambda o: "<%d bytes>" % len(o) if isinstance(o, (bytes, bytearray)) else str(o)))`
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function parseErr(payload) {
  const result = pyJson(
    payload,
    `try:
    pipelines.parse_generation(payload)
    print(json.dumps({"ok": True}))
except pipelines.ApiError as e:
    print(json.dumps({"ok": False, "code": e.code, "status": e.status, "message": str(e)}))`
  );
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  // A plain ValueError/TypeError would escape the except clause and leave
  // stdout empty; surface it instead of a confusing TypeError.
  assert.equal(outcome.ok, false, `expected an ApiError, got ${JSON.stringify(outcome)}`);
  return outcome;
}

function argvFor(payload, modelRoot) {
  // ``payload`` must already carry the real ``model`` + ``workflow`` fields
  // (or fall back to the generate default); this helper never injects either.
  const result = py(`
root = ${JSON.stringify(modelRoot)}
raw = json.loads(${JSON.stringify(JSON.stringify(payload))})
gen = pipelines.parse_generation(raw)
assets = pipelines.resolve_assets(root, gen["spec"], gen["temporal_upscalings"])
paths = {i["field"]: "/tmp/" + str(i["frame_idx"]) for i in gen["images"]}
if gen["audio"] is not None:
    paths["audio"] = "/tmp/audio.wav"
print(json.dumps(pipelines.build_argv(gen, assets, paths, "/tmp/out.mp4", python="python3")))
`);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function makeModelRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'ltx-models-'));
  const result = py(`import json; print(json.dumps(pipelines.MODEL_FILES))`);
  const files = JSON.parse(result.stdout);
  for (const rel of Object.values(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, 'stub\n');
  }
  return root;
}

// Same as makeModelRoot but every *optional* component (the refine detailing
// IC-LoRA, the temporal upsampler, the duration head, ...) is omitted, so
// per-workflow readiness can be exercised without the default workflow losing
// its assets.
function makeDefaultOnlyRoot() {
  const root = makeModelRoot();
  for (const key of ['detailing_lora', 'temporal_upsampler']) {
    const result = py(`import json; print(json.dumps(pipelines.MODEL_FILES))`);
    const rel = JSON.parse(result.stdout)[key];
    if (rel && existsSync(path.join(root, rel))) rmSync(path.join(root, rel));
  }
  // The detailing IC-LoRA is also reached through its separate repository dir.
  const icLora = path.join(root, 'Lightricks--LTX-2.5-22b-IC-LoRA-Pixel-Spatial-Upscaler');
  if (existsSync(icLora)) rmSync(icLora, { recursive: true, force: true });
  return root;
}

// --- minimal real PNG / JPEG / WAV / FLAC builders -------------------------
function imageDataUri(format, width, height) {
  const result = py(
    `from PIL import Image; import io, base64; buf=io.BytesIO(); Image.new("RGB", (${width}, ${height}), (80, 100, 120)).save(buf, format="${format}"); print(base64.b64encode(buf.getvalue()).decode())`
  );
  assert.equal(result.status, 0, result.stderr);
  return `data:image/${format.toLowerCase()};base64,${result.stdout.trim()}`;
}
function pngDataUri(width, height) {
  return imageDataUri('PNG', width, height);
}
function jpegDataUri(width, height) {
  return imageDataUri('JPEG', width, height);
}

function wavDataUri(seconds, sampleRate = 16000, channels = 1, bits = 16) {
  const dataLen = Math.round(seconds * sampleRate * channels * (bits / 8));
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buf.writeUInt16LE(channels * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  return 'data:audio/wav;base64,' + buf.toString('base64');
}

function flacDataUri(totalSamples, sampleRate = 16000) {
  const result = py(
    `import soundfile as sf, numpy as np, io, base64; buf=io.BytesIO(); sf.write(buf, np.zeros(${totalSamples}), ${sampleRate}, format="FLAC"); print(base64.b64encode(buf.getvalue()).decode())`
  );
  assert.equal(result.status, 0, result.stderr);
  return 'data:audio/flac;base64,' + result.stdout.trim();
}

// --- fake runner used by the server tests ----------------------------------
function writeFakeRunner(dir, body) {
  const shim = path.join(dir, 'fake_pipeline.py');
  writeFileSync(shim, body);
  chmodSync(shim, 0o755);
  return shim;
}

const FAST_RUNNER = `import sys, base64
out = sys.argv[sys.argv.index("--output-path") + 1]
assert sum(arg.startswith("ltx_pipelines.") or arg == "a2v" for arg in sys.argv) == 1
open(out, "wb").write(b"\\x00\\x00\\x00\\x18ftypmp42")
sys.stderr.write("fake pipeline ok\\n")
`;

async function startServer(env) {
  // The server module needs FastAPI; skip cleanly when it is unavailable.
  const probe = spawnSync('python3', ['-c', 'import fastapi, uvicorn, httpx'], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const proc = spawn(
    'python3',
    [
      '-c',
      `import sys; sys.path.insert(0, ${JSON.stringify(BACKEND)}); import uvicorn, server; uvicorn.run(server.app, host="127.0.0.1", port=0, log_level="info")`
    ],
    {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('server did not announce a port: ' + buf)), 20000);
    proc.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      const match = buf.match(/Uvicorn running on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      reject(new Error('server exited: ' + buf));
    });
  });
  return { proc, port };
}

// ---------------------------------------------------------------------------
test('pipeline table exposes exactly two public model IDs with nested workflows', () => {
  const result = py('print(json.dumps(pipelines.describe()))');
  assert.equal(result.status, 0, result.stderr);
  const table = JSON.parse(result.stdout);
  assert.deepEqual(
    table.map((entry) => entry.id),
    ALL_IDS
  );
  const byId = Object.fromEntries(table.map((entry) => [entry.id, entry]));
  // Discovery is nested: model -> default_workflow -> workflows[name] -> spec.
  assert.equal(byId[FULL].default_workflow, GENERATE);
  assert.equal(byId[DISTILLED].default_workflow, GENERATE);
  assert.deepEqual(Object.keys(byId[FULL].workflows), [GENERATE, GENERATE_HQ, A2V, KEYFRAMES]);
  assert.deepEqual(Object.keys(byId[DISTILLED].workflows), [GENERATE, RETAKE, REFINE]);
  assert.equal(byId[FULL].workflows[GENERATE].module, 'ltx_pipelines.ti2vid_two_stages');
  assert.equal(byId[FULL].workflows[GENERATE_HQ].module, 'ltx_pipelines.ti2vid_two_stages_hq');
  assert.equal(byId[FULL].workflows[A2V].module, 'a2v');
  assert.equal(byId[FULL].workflows[KEYFRAMES].module, 'ltx_pipelines.keyframe_interpolation');
  assert.equal(byId[DISTILLED].workflows[GENERATE].module, 'ltx_pipelines.distilled');
  assert.equal(byId[DISTILLED].workflows[RETAKE].module, 'ltx_pipelines.retake');
  assert.equal(byId[DISTILLED].workflows[REFINE].module, 'ltx_pipelines.dfr_pipeline');
  // Every workflow advertises per-workflow capabilities/defaults/assets.
  for (const entry of table) {
    for (const workflow of Object.values(entry.workflows)) {
      assert.ok(workflow.capabilities && typeof workflow.capabilities === 'object');
      assert.ok(workflow.defaults && typeof workflow.defaults === 'object');
      assert.ok(Array.isArray(workflow.required_assets) && workflow.required_assets.length > 0);
    }
  }
});

test('defaults are the modest GB10 geometry', () => {
  const result = py('print(json.dumps(pipelines.describe()))');
  const table = JSON.parse(result.stdout);
  for (const entry of table) {
    for (const workflow of Object.values(entry.workflows)) {
      assert.equal(workflow.defaults.width, 832);
      assert.equal(workflow.defaults.height, 512);
      assert.equal(workflow.defaults.num_frames, 121);
    }
  }
});

test('unknown model ID is rejected with 404 and no paths are request-selectable', () => {
  const outcome = parseErr({ model: 'Lightricks/LTX-2.5-Anything', prompt: 'x' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 404);
});

test('removed compatibility model IDs are rejected with 404, not converted', () => {
  for (const id of REMOVED_IDS) {
    const outcome = parseErr({ model: id, prompt: 'x' });
    assert.equal(outcome.ok, false, `${id} must be rejected`);
    assert.equal(outcome.status, 404, `${id} must be 404`);
    assert.match(outcome.message, /model must be one of/);
  }
});

test('model ID selects the pipeline; module/path fields are rejected', () => {
  const outcome = parseErr(req(FULL, GENERATE, { module: 'ltx_pipelines.distilled' }));
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /Unsupported fields: module/);
});

test('the explicit workflow field must be a supported non-empty string', () => {
  // Absence defaults to generate for both models.
  assert.equal(parseOk(req(FULL, undefined)).workflow, GENERATE);
  assert.equal(parseOk(req(DISTILLED, undefined)).workflow, GENERATE);
  // A supported workflow is echoed back on the parsed generation.
  assert.equal(parseOk(req(FULL, GENERATE_HQ)).workflow, GENERATE_HQ);
  assert.equal(parseOk(req(DISTILLED, REFINE)).workflow, REFINE);
  // Wrong-family pairs are rejected (retake/refine exist only on Distilled;
  // generate-hq/audio-to-video/keyframes only on Full).
  assert.match(parseErr(req(FULL, RETAKE)).message, /does not support workflow/);
  assert.match(parseErr(req(FULL, REFINE)).message, /does not support workflow/);
  assert.match(parseErr(req(DISTILLED, GENERATE_HQ)).message, /does not support workflow/);
  assert.match(parseErr(req(DISTILLED, A2V)).message, /does not support workflow/);
  assert.match(parseErr(req(DISTILLED, KEYFRAMES)).message, /does not support workflow/);
  // Null, arrays, numbers, booleans, objects, empty and unknown names are all
  // rejected as invalid selector values, never inferred from the payload.
  for (const workflow of [null, [], ['generate'], 7, true, {}, '', 'Generate', 'dev', 'dfr']) {
    const outcome = parseErr(req(FULL, workflow));
    assert.equal(outcome.ok, false, `workflow=${JSON.stringify(workflow)} must be rejected`);
    assert.equal(outcome.status, 400);
    assert.match(outcome.message, /workflow/);
  }
  // A distractor field (audio/video conditioning) must never imply a workflow.
  assert.match(parseErr(req(FULL, undefined, { audio: wavDataUri(1) })).message, /does not accept audio/);
  assert.match(parseErr(req(DISTILLED, undefined, { video: 'data:video/mp4;base64,AAAA' })).message, /video/);
});

test('the model+workflow pair routes to the matching pipeline module', () => {
  const moduleFor = (model, workflow) => {
    const result = pyJson(
      req(model, workflow, workflow === A2V ? { audio: wavDataUri(1) } : {}),
      `g = pipelines.parse_generation(payload)\nprint(g["spec"]["module"])`
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  assert.equal(moduleFor(FULL, GENERATE), 'ltx_pipelines.ti2vid_two_stages');
  assert.equal(moduleFor(FULL, GENERATE_HQ), 'ltx_pipelines.ti2vid_two_stages_hq');
  assert.equal(moduleFor(FULL, A2V), 'a2v');
  assert.equal(moduleFor(FULL, KEYFRAMES), 'ltx_pipelines.keyframe_interpolation');
  assert.equal(moduleFor(DISTILLED, GENERATE), 'ltx_pipelines.distilled');
  // Retake's module is checked below with a real decoded source video.
  assert.equal(moduleFor(DISTILLED, REFINE), 'ltx_pipelines.dfr_pipeline');
});
test('size, fps and response_format aliases are accepted', () => {
  // 960x576 keeps the 64-pixel geometry step while still proving the alias
  // parses WIDTHxHEIGHT from the query string.
  const spec = parseOk(
    req(FULL, GENERATE, {
      prompt: 'a cat',
      size: '960x576',
      fps: 30,
      response_format: 'b64_json',
      duration: 2
    })
  );
  assert.equal(spec.width, 960);
  assert.equal(spec.height, 576);
  assert.equal(spec.frame_rate, 30);
  assert.equal(spec.response_format, 'b64_json');
  assert.equal(spec.num_frames % 8, 1);
});

test('conflicting aliases are rejected early', () => {
  assert.match(parseErr(req(FULL, GENERATE, { size: '832x512', width: 832 })).message, /either size or width\/height/);
  assert.match(parseErr(req(FULL, GENERATE, { fps: 24, frame_rate: 24 })).message, /either fps or frame_rate/);
  assert.match(
    parseErr(req(FULL, GENERATE, { duration: 2, num_frames: 121 })).message,
    /either duration or num_frames/
  );
});

test('an unsupported response_format is rejected', () => {
  assert.match(parseErr(req(FULL, GENERATE, { response_format: 'url' })).message, /response_format/);
});

test('arbitrary 4K-by-4K canvases are refused by area and per-axis ceilings', () => {
  // 4K on either axis trips the per-axis ceiling first...
  const axis4k = parseErr(req(FULL, GENERATE, { width: 4096, height: 4096 }));
  assert.equal(axis4k.ok, false);
  assert.equal(axis4k.status, 400);
  assert.match(axis4k.message, /between 64 and 2048/);
  // ...and a canvas that stays under 2048 per axis but is still far too big is
  // refused by the explicit area ceiling with a 413.
  const area = parseErr(req(FULL, GENERATE, { width: 2048, height: 1152 }));
  assert.equal(area.ok, false);
  assert.equal(area.status, 413);
  const axis = parseErr(req(FULL, GENERATE, { width: 4096, height: 64 }));
  assert.equal(axis.ok, false);
  assert.match(axis.message, /between 64 and 2048/);
});

test('num_frames must be 8k+1 and duration maps onto that grid', () => {
  assert.equal(parseOk(req(FULL, GENERATE, { num_frames: 121 })).num_frames, 121);
  assert.match(parseErr(req(FULL, GENERATE, { num_frames: 120 })).message, /8 \* k \+ 1/);
  const derived = parseOk(req(FULL, GENERATE, { duration: 5, frame_rate: 24 })).num_frames;
  assert.equal((derived - 1) % 8, 0);
});

test('guidance and steps are gated per pipeline capability', () => {
  const guided = argvFor(req(FULL, GENERATE, { guidance_scale: 3.0, stg_scale: 1.0, steps: 25 }), makeModelRoot());
  assert.ok(guided.includes('--video-cfg-guidance-scale'));
  assert.ok(guided.includes('--num-inference-steps'));
  assert.match(parseErr(req(DISTILLED, GENERATE, { steps: 20 })).message, /does not accept steps/);
  assert.match(parseErr(req(DISTILLED, GENERATE, { guidance_scale: 3 })).message, /does not accept guidance_scale/);
  assert.match(
    parseErr(req(DISTILLED, REFINE, { negative_prompt: 'blur' })).message,
    /does not accept negative_prompt/
  );
  assert.match(parseErr(req(FULL, GENERATE, { audio: wavDataUri(1) })).message, /does not accept audio/);
});

test('first and final guidance map to frame 0 and num_frames-1', () => {
  const argv = argvFor(
    req(FULL, GENERATE, { num_frames: 121, image: pngDataUri(64, 64), last_frame: jpegDataUri(64, 64) }),
    makeModelRoot()
  );
  const flags = argv.reduce((acc, token, index) => (token === '--image' ? acc.concat([[argv[index + 2]]]) : acc), []);
  const indices = flags.map((entry) => Number(entry[0])).sort((a, b) => a - b);
  assert.deepEqual(indices, [0, 120]);
});

test('image_strength tunes only the first-frame guide and defaults to 1.0', () => {
  const image = pngDataUri(64, 64);
  const last = jpegDataUri(64, 64);
  // Read back the emitted (field, frame_idx, strength) triples from argv.
  const guides = (payload) =>
    argvFor(payload, makeModelRoot()).reduce(
      (acc, token, index, argv) =>
        token === '--image' ? acc.concat([[argv[index + 1], argv[index + 2], argv[index + 3]]]) : acc,
      []
    );
  const base = guides(req(FULL, GENERATE, { num_frames: 121, image, last_frame: last }));
  assert.deepEqual(base, [
    ['/tmp/0', '0', '1.0'],
    ['/tmp/120', '120', '1.0']
  ]);
  // A single strength rescales ONLY frame 0; last_frame keeps 1.0.
  const tuned = guides(req(FULL, GENERATE, { num_frames: 121, image, last_frame: last, image_strength: 0.4 }));
  assert.equal(tuned[0][2], '0.4');
  assert.equal(tuned[1][2], '1.0');
  // Interior keyframes keep their explicit strength untouched.
  const keyed = guides(
    req(FULL, GENERATE, {
      image,
      image_strength: 0.25,
      keyframes: [{ image: last, frame: 5, strength: 0.9 }]
    })
  );
  assert.deepEqual(keyed, [
    ['/tmp/0', '0', '0.25'],
    ['/tmp/5', '5', '0.9']
  ]);
  // Validation: an image is required, values are finite numeric in [0,1], and
  // a boolean is not a number (it must not silently cast to 0/1).
  assert.match(parseErr(req(FULL, GENERATE, { image_strength: 0.5 })).message, /requires an image/);
  for (const value of [null, true, false, 1.5, -0.1, '0.5'])
    assert.match(
      parseErr(req(FULL, GENERATE, { image, image_strength: value })).message,
      /number between 0.0 and 1.0/,
      `image_strength=${String(value)} must be rejected`
    );
  // Accepted endpoints.
  assert.equal(parseOk(req(FULL, GENERATE, { image, image_strength: 0 })).images[0].strength, 0.0);
  assert.equal(parseOk(req(FULL, GENERATE, { image, image_strength: 1 })).images[0].strength, 1.0);
  // Retake has no image guide and must reject the field instead of dropping it.
  assert.match(parseErr(req(DISTILLED, RETAKE, { image_strength: 0.5 })).message, /does not accept image_strength/);
});

test('audio-to-video duration uses the same explicit frame grid with or without last_frame', () => {
  const root = makeModelRoot();
  const audio = wavDataUri(3);
  const derived = argvFor(req(FULL, A2V, { audio, duration: 3 }), root);
  assert.equal(derived.includes('--audio-max-duration'), false);
  assert.ok(derived.includes('--num-frames'));
  assert.ok(derived.includes('--audio-path'));

  const pinned = argvFor(req(FULL, A2V, { audio, duration: 3, last_frame: pngDataUri(64, 64) }), root);
  assert.equal(pinned.includes('--audio-max-duration'), false);
  const numFrames = Number(pinned[pinned.indexOf('--num-frames') + 1]);
  assert.equal((numFrames - 1) % 8, 0);
  // The endpoint is conditioned at exactly the count that was requested.
  const imageFlagIndex = pinned.indexOf('--image');
  assert.equal(Number(pinned[imageFlagIndex + 2]), numFrames - 1);
});

test('audio-to-video requires audio and rejects a non-audio payload', () => {
  assert.match(parseErr(req(FULL, A2V, { duration: 2 })).message, /requires an inline audio/);
  assert.match(parseErr(req(FULL, A2V, { audio: 'data:audio/wav;base64,bm90YXVkaW8=' })).message, /not a valid WAV/);
});

test('images are really decoded: headers and sizes are checked, base64 alone is not enough', () => {
  assert.match(parseErr(req(FULL, GENERATE, { image: 'data:image/png;base64,AAAA' })).message, /not a PNG or JPEG/);
  assert.match(
    parseErr(req(FULL, GENERATE, { image: 'data:image/jpeg;base64,' + Buffer.from('notjpeg').toString('base64') }))
      .message,
    /not a PNG or JPEG/
  );
  // A PNG magic prefix with a truncated IHDR is not a decodable PNG.
  const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  assert.match(
    parseErr(req(FULL, GENERATE, { image: 'data:image/png;base64,' + truncated.toString('base64') })).message,
    /not a valid PNG/
  );
  const ok = parseOk(req(FULL, GENERATE, { image: pngDataUri(64, 64) }));
  assert.equal(ok.images[0].width_px, 64);
  assert.equal(ok.images[0].height_px, 64);
});

test('audio is really decoded for WAV and FLAC and an absurd duration is refused', () => {
  const wav = parseOk(req(FULL, A2V, { audio: wavDataUri(2) }));
  assert.equal(wav.audio_info.format, 'wav');
  assert.ok(Math.abs(wav.audio_info.duration - 2) < 0.01);
  const flac = parseOk(req(FULL, A2V, { audio: flacDataUri(32000) }));
  assert.equal(flac.audio_info.format, 'flac');
  assert.ok(Math.abs(flac.audio_info.duration - 2) < 0.01);
  assert.equal(parseErr(req(FULL, A2V, { audio: wavDataUri(900) })).status, 413);
});

test('argv only ever references files under MODEL_ROOT and never a URL', () => {
  const root = makeModelRoot();
  const argv = argvFor(req(DISTILLED, REFINE, { temporal_upscalings: 0 }), root);
  const modelFlags = [
    '--transformer-path',
    '--text-encoder-path',
    '--video-vae-path',
    '--audio-vae-path',
    '--spatial-upsampler-path',
    '--detailing-lora'
  ];
  for (const flag of modelFlags) {
    const value = argv[argv.indexOf(flag) + 1];
    assert.ok(value.startsWith(root), `${flag} must live under MODEL_ROOT, got ${value}`);
  }
  assert.equal(
    argv.some((token) => /^https?:\/\//.test(token)),
    false
  );
  assert.equal(argv.includes('--detailing-lora-strength'), false); // strength is upstream-hardcoded
});

test('refine with temporal upscalings includes the temporal upsampler path', () => {
  const argv = argvFor(req(DISTILLED, REFINE, { temporal_upscalings: 1 }), makeModelRoot());
  assert.ok(argv.includes('--temporal-upsampler-path'));
  assert.ok(argv.includes('--temporal-upscalings'));
  assert.equal(Number(argv[argv.indexOf('--temporal-upscalings') + 1]), 1);
});

test('a missing component is reported as model_unavailable (503)', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'ltx-empty-'));
  const result = spawnSync(
    'python3',
    [
      '-c',
      `import sys; sys.path.insert(0, ${JSON.stringify(BACKEND)}); import pipelines\ntry:\n    gen = pipelines.parse_generation({"model": "Lightricks/LTX-2.5-Full", "workflow": "generate", "prompt": "x"})\n    pipelines.resolve_assets(${JSON.stringify(empty)}, gen["spec"])\n    print("resolved")\nexcept pipelines.ApiError as e:\n    print("ERR", e.status, e.code)\n`
    ],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ERR 503 model_unavailable/);
});

test('resolve_assets fails for every optional-but-absent component list too', () => {
  const root = makeModelRoot();
  const result = spawnSync(
    'python3',
    [
      '-c',
      `import sys, json; sys.path.insert(0, ${JSON.stringify(BACKEND)}); import pipelines\nroot = ${JSON.stringify(root)}\nfor mid in pipelines.MODEL_ID_LIST:\n    for wf, spec in pipelines.PIPELINES[mid].items():\n        pipelines.resolve_assets(root, spec)\nprint("ALL_OK")\n`
    ],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ALL_OK/);
});

test('the bundled pipelines CLI documents the two public models', () => {
  const result = spawnSync('python3', [PY, '--list'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const table = JSON.parse(result.stdout);
  assert.deepEqual(
    table.map((entry) => entry.id),
    ALL_IDS
  );
  // --describe prints one nested model entry; --model-files still knows the
  // protected refine detailing component.
  const described = spawnSync('python3', [PY, '--describe', DISTILLED], { encoding: 'utf8' });
  assert.equal(described.status, 0, described.stderr);
  const entry = JSON.parse(described.stdout);
  assert.deepEqual(Object.keys(entry.workflows), [GENERATE, RETAKE, REFINE]);
  const files = spawnSync('python3', [PY, '--model-files'], { encoding: 'utf8' });
  const listed = JSON.parse(files.stdout);
  assert.ok(listed.required.detailing_lora.includes('ic-lora-pixel-spatial-upscaler'));
});

test('install.py hashes its build inputs and tags the image by digest', () => {
  const first = spawnSync('python3', [path.join(BACKEND, 'install.py'), '--print-image'], { encoding: 'utf8' });
  const second = spawnSync('python3', [path.join(BACKEND, 'install.py'), '--print-image'], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(first.stdout.trim(), /^lloom\/ltx-pipelines:source-[0-9a-f]{64}$/);
  assert.equal(first.stdout, second.stdout);
});

test('server serves /health, /v1/models and a real video response through a fake pipeline', async (t) => {
  const root = makeModelRoot();
  const workdir = mkdtempSync(path.join(tmpdir(), 'ltx-runner-'));
  const runner = writeFakeRunner(workdir, FAST_RUNNER);
  const server = await startServer({
    LLOOM_LTX_MODEL_ROOT: root,
    LLOOM_LTX_RUNNER: JSON.stringify(['python3', runner])
  });
  if (!server) return t.skip('fastapi/uvicorn/httpx not installed in this environment');
  t.after(() => {
    server.proc.kill('SIGKILL');
    rmSync(workdir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.port}`;
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.lazy_load, true);
  assert.equal(health.keep_warm, false);
  // When every component (including optional ones) is present all workflows
  // report ready and both public models are available.
  assert.deepEqual(health.available_models, ALL_IDS);
  assert.deepEqual(health.unavailable_models, []);
  assert.deepEqual(health.workflow_ready[FULL], {
    [GENERATE]: true,
    [GENERATE_HQ]: true,
    [A2V]: true,
    [KEYFRAMES]: true
  });
  assert.deepEqual(health.workflow_ready[DISTILLED], {
    [GENERATE]: true,
    [RETAKE]: true,
    [REFINE]: true
  });

  const models = await (await fetch(`${base}/v1/models`)).json();
  assert.deepEqual(
    models.data.map((item) => item.id),
    ALL_IDS
  );
  for (const item of models.data) {
    assert.equal(item.default_workflow, GENERATE);
    assert.ok(item.workflows && typeof item.workflows === 'object');
  }

  const response = await fetch(`${base}/v1/videos/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req(FULL, GENERATE, { prompt: 'a lighthouse at dawn', num_frames: 121 }))
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(Array.isArray(body.data), true);
  assert.equal(body.data[0].mime_type, 'video/mp4');
  // The response preserves the model and the selected workflow in metadata.
  assert.equal(body.model, FULL);
  assert.equal(body.workflow, GENERATE);
  const decoded = Buffer.from(body.data[0].b64_json, 'base64');
  assert.ok(decoded.length > 0);
  assert.equal(decoded.slice(4, 8).toString('ascii'), 'ftyp');
});

test('health reports per-workflow readiness: a missing refine asset leaves distilled available', async (t) => {
  const root = makeDefaultOnlyRoot();
  const server = await startServer({ LLOOM_LTX_MODEL_ROOT: root });
  if (!server) return t.skip('fastapi/uvicorn/httpx not installed in this environment');
  t.after(() => {
    server.proc.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });
  const health = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
  assert.equal(health.status, 'ok');
  // Both public models remain available because only the *default* workflow has
  // to be ready for availability; the missing detailing IC-LoRA is optional.
  assert.deepEqual(health.available_models, ALL_IDS);
  assert.deepEqual(health.unavailable_models, []);
  assert.equal(health.workflow_ready[DISTILLED][GENERATE], true);
  assert.equal(health.workflow_ready[DISTILLED][RETAKE], true);
  assert.equal(health.workflow_ready[DISTILLED][REFINE], false);
});

test('the server validates before spawning and returns 404/400/413 without touching the runner', async (t) => {
  const root = makeModelRoot();
  const workdir = mkdtempSync(path.join(tmpdir(), 'ltx-runner-'));
  const marker = path.join(workdir, 'spawned');
  const runner = writeFakeRunner(workdir, `import sys\nopen(${JSON.stringify(marker)}, "w").write("x")\n`);
  const server = await startServer({
    LLOOM_LTX_MODEL_ROOT: root,
    LLOOM_LTX_RUNNER: JSON.stringify(['python3', runner])
  });
  if (!server) return t.skip('fastapi/uvicorn/httpx not installed in this environment');
  t.after(() => {
    server.proc.kill('SIGKILL');
    rmSync(workdir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.port}`;
  const post = (payload) =>
    fetch(`${base}/v1/videos/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

  assert.equal((await post({ model: 'Lightricks/LTX-2.5-Nope', prompt: 'x' })).status, 404);
  // Removed gateway IDs and an invalid workflow selector are refused here too,
  // and never reach the runner.
  for (const id of REMOVED_IDS) assert.equal((await post({ model: id, prompt: 'x' })).status, 404);
  assert.equal((await post(req(FULL, RETAKE))).status, 400);
  assert.equal((await post(req(FULL, ''))).status, 400);
  assert.equal((await post(req(FULL, GENERATE, { width: 2048, height: 1152 }))).status, 413);
  assert.equal((await post(req(FULL, GENERATE, { num_frames: 120 }))).status, 400);
  assert.equal(existsSync(marker), false, 'no subprocess may start for an invalid request');
});

async function waitFor(predicate, message) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}
function pidGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}
for (const trigger of ['timeout', 'disconnect']) {
  test(`generation ${trigger} reaps its process and permits a valid retry`, async (t) => {
    const root = makeModelRoot();
    const workdir = mkdtempSync(path.join(tmpdir(), 'ltx-lifecycle-'));
    const marker = path.join(workdir, 'pid');
    const runner = writeFakeRunner(
      workdir,
      `import os, sys, time\nopen(${JSON.stringify(marker)}, "w").write(str(os.getpid()))\nif sys.argv[sys.argv.index("--prompt")+1] == "slow": time.sleep(60)\n` +
        FAST_RUNNER
    );
    const server = await startServer({
      LLOOM_LTX_MODEL_ROOT: root,
      LLOOM_LTX_RUNNER: JSON.stringify(['python3', runner]),
      LLOOM_LTX_TIMEOUT_SECONDS: trigger === 'timeout' ? '1' : '30'
    });
    t.after(() => {
      server.proc.kill('SIGKILL');
      rmSync(workdir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.port}`;
    const post = (prompt, signal) =>
      fetch(`${base}/v1/videos/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req(DISTILLED, GENERATE, { prompt })),
        signal
      });
    const controller = new AbortController();
    const pending = post('slow', controller.signal).catch((e) => e);
    await waitFor(() => existsSync(marker), 'runner must start');
    const pid = Number(readFileSync(marker, 'utf8'));
    assert.equal((await post('busy')).status, 409);
    if (trigger === 'disconnect') controller.abort();
    const result = await pending;
    if (trigger === 'timeout') assert.equal(result.status, 504);
    else assert.equal(result.name, 'AbortError');
    await waitFor(() => pidGone(pid), 'child must exit after cancellation');
    await waitFor(async () => !(await (await fetch(`${base}/health`)).json()).busy, 'lock must be released');
    assert.equal((await post('retry')).status, 200);
  });
}

test('review regressions reject malformed keyframes, zero size, refine grid and ignored audio controls', () => {
  assert.match(
    parseErr(req(FULL, GENERATE, { keyframes: [{ image: pngDataUri(64, 64) }] })).message,
    /frame is required/
  );
  assert.equal(parseErr(req(FULL, GENERATE, { size: '0x64' })).status, 400);
  assert.match(parseErr(req(DISTILLED, REFINE, { width: 832, spatial_upscalings: 2 })).message, /128/);
  assert.match(parseErr(req(FULL, GENERATE, { audio_start_time: 1 })).message, /does not accept/);
  for (const field of ['audio_guidance_scale', 'v2a_guidance_scale']) {
    assert.match(parseErr(req(FULL, A2V, { audio: wavDataUri(1), [field]: 1 })).message, /frozen audio/);
  }
  assert.match(parseErr(req(FULL, A2V, { audio: wavDataUri(1), audio_start_time: 1 })).message, /before the end/);
});
test('truncated encoded media fails before inference', () => {
  for (const [field, uri, model, workflow] of [
    ['image', pngDataUri(64, 64), FULL, GENERATE],
    ['image', jpegDataUri(64, 64), FULL, GENERATE],
    ['audio', wavDataUri(1), FULL, A2V],
    ['audio', flacDataUri(16000), FULL, A2V]
  ]) {
    const [prefix, b64] = uri.split(',');
    const bytes = Buffer.from(b64, 'base64');
    assert.equal(
      parseErr(
        req(model, workflow, {
          [field]: prefix + ',' + bytes.subarray(0, Math.floor(bytes.length / 2)).toString('base64')
        })
      ).status,
      400
    );
  }
});
test('structured LTX prompts preserve each explicit instruction', () => {
  const g = parseOk(
    req(FULL, GENERATE, {
      prompt: {
        description: 'Quiet room.',
        dialogue: 'Hello, world.',
        camera: 'Slow dolly.',
        timeline: [{ start: 0, end: 2, action: 'Blink once.' }]
      }
    })
  );
  for (const part of ['Quiet room.', 'Hello, world.', 'Slow dolly.', 'Blink once.']) assert.ok(g.prompt.includes(part));
  assert.equal(parseErr(req(FULL, GENERATE, { prompt: { unknown: 'ignored?' } })).status, 400);
  assert.equal(parseErr(req(FULL, GENERATE, { video: 'data:video/mp4;base64,AAAA' })).status, 400);
});
test('Retake derives geometry from a decoded MP4 and emits only editing CLI flags', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ltx-retake-fixture-'));
  try {
    const video = path.join(dir, 'input.mp4');
    const made = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=256x256:r=24',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=24000:duration=1.041667',
        '-c:a',
        'aac',
        '-frames:v',
        '25',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        video
      ],
      { encoding: 'utf8' }
    );
    assert.equal(made.status, 0, made.stderr);
    const uri = 'data:video/mp4;base64,' + readFileSync(video).toString('base64');
    const payload = req(DISTILLED, RETAKE, {
      prompt: 'Make the fox turn its head.',
      video: uri,
      start_time: 0.1,
      end_time: 0.8
    });
    const g = parseOk(payload);
    const normalized = pyJson(
      payload,
      `import tempfile, subprocess
g=pipelines.parse_generation(payload)
with tempfile.NamedTemporaryFile(suffix='.mp4') as f:
 f.write(g['video']['bytes']); f.flush()
 p=subprocess.run(['ffprobe','-v','error','-select_streams','a:0','-show_entries','stream=channels','-of','json',f.name],capture_output=True,text=True,check=True)
 print(p.stdout)`
    );
    assert.equal(normalized.status, 0, normalized.stderr);
    assert.equal(JSON.parse(normalized.stdout).streams[0].channels, 2);
    assert.equal(g.width, 256);
    assert.equal(g.num_frames, 25);
    const root = makeModelRoot();
    const result = pyJson(
      payload,
      `g=pipelines.parse_generation(payload)\na=pipelines.resolve_assets(${JSON.stringify(root)},g["spec"])\nprint(json.dumps(pipelines.build_argv(g,a,{"video":"/tmp/input.mp4"},"/tmp/output.mp4")))`
    );
    assert.equal(result.status, 0, result.stderr);
    const argv = JSON.parse(result.stdout);
    assert.ok(argv.includes('ltx_pipelines.retake'));
    assert.ok(argv.includes('--video-path'));
    for (const flag of ['--frame-rate', '--num-frames', '--height', '--width', '--spatial-upsampler-path'])
      assert.ok(!argv.includes(flag));
    assert.equal(parseErr({ ...payload, fps: 24 }).status, 400);
    assert.equal(parseErr(req(DISTILLED, GENERATE, { num_frames: 9, generated_keyframes: 8 })).status, 400);
    assert.equal(parseErr({ ...payload, end_time: 10 }).status, 400);
    assert.equal(parseErr({ ...payload, video: 'data:video/mp4;base64,AAAA' }).status, 400);
    rmSync(root, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A2V duplicates mono into stereo and pads the frame grid without replacing samples', async (t) => {
  const root = makeModelRoot();
  const workdir = mkdtempSync(path.join(tmpdir(), 'ltx-mono-'));
  const runner = writeFakeRunner(
    workdir,
    `import sys, soundfile as sf, numpy as np
p=sys.argv[sys.argv.index('--audio-path')+1]
a,rate=sf.read(p,always_2d=True)
assert a.shape==(25000,2), a.shape
assert np.array_equal(a[:,0],a[:,1])
assert a[0,0]==0.5
assert np.all(a[24000:]==0)
` + FAST_RUNNER
  );
  const server = await startServer({
    LLOOM_LTX_MODEL_ROOT: root,
    LLOOM_LTX_RUNNER: JSON.stringify(['python3', runner])
  });
  if (!server) throw new Error('Python test dependencies are required');
  t.after(() => {
    server.proc.kill('SIGKILL');
    rmSync(workdir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${server.port}/v1/videos/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      req(FULL, A2V, {
        prompt: 'x',
        audio: (() => {
          const b = Buffer.from(wavDataUri(1, 24000).split(',')[1], 'base64');
          b.writeInt16LE(16384, 44);
          return 'data:audio/wav;base64,' + b.toString('base64');
        })(),
        num_frames: 25,
        fps: 24
      })
    )
  });
  assert.equal(response.status, 200, await response.text());
});

test('A2V sampler defaults reach native CLI; overrides are gated and preserved', () => {
  const root = makeModelRoot();
  const body = req(FULL, A2V, { prompt: 'A person speaks.', audio: wavDataUri(3), image: pngDataUri(64, 64) });
  const argv = argvFor(body, root);
  const value = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(value(argv, '-m'), 'a2v');
  assert.equal(value(argv, '--sampler'), 'euler_ancestral');
  assert.equal(value(argv, '--video-cfg-guidance-scale'), '3.0');
  assert.equal(value(argv, '--video-stg-guidance-scale'), '0.0');
  assert.equal(value(argv, '--video-rescale-scale'), '0.0');
  assert.equal(value(argv, '--a2v-guidance-scale'), '1.0');
  assert.equal(parseOk(body).images[0].strength, 0.7);
  const explicit = argvFor(
    { ...body, sampler: 'euler', stg_scale: 1, rescale_scale: 0.7, a2v_guidance_scale: 3, image_strength: 1 },
    root
  );
  assert.equal(value(explicit, '--sampler'), 'euler');
  assert.equal(value(explicit, '--video-stg-guidance-scale'), '1.0');
  assert.equal(value(explicit, '--a2v-guidance-scale'), '3.0');
  for (const sampler of [null, true, 2, 'typo', {}]) assert.match(parseErr({ ...body, sampler }).message, /sampler/);
  const samplerFree = [
    [FULL, GENERATE],
    [FULL, GENERATE_HQ],
    [FULL, KEYFRAMES],
    [DISTILLED, GENERATE],
    [DISTILLED, RETAKE],
    [DISTILLED, REFINE]
  ];
  for (const [model, workflow] of samplerFree)
    assert.match(parseErr(req(model, workflow, { sampler: 'euler' })).message, /sampler/);
});
