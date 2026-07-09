import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyVoiceProfileToSpeechBody,
  installVoiceProfile,
  listVoiceProfiles,
  listVoicesDiscovery,
  loadVoiceProfileFromDir,
  removeVoiceProfile
} from '../src/voice-profiles.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lloom-voices-'));
const refPath = path.join(tmp, 'sample.wav');
// Minimal RIFF header-ish bytes are enough for copy; install only checks exists.
await fs.writeFile(refPath, Buffer.from('RIFFxxxxWAVEfmt '));

const installed = await installVoiceProfile({
  id: 'Jinx Demo',
  name: 'Jinx',
  ref: refPath,
  refText: 'slow, teasing every edge. You boys like that?',
  model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit',
  defaults: { temperature: 1.05, top_p: 0.9, top_k: 40, repetition_penalty: 1.7 },
  voicesRoot: tmp,
  apply: true,
  yes: true,
  force: true
});

assert.equal(installed.installed, true);
assert.equal(installed.profile.id, 'jinx-demo');
assert.ok(installed.profile.refAudioPath.endsWith('reference.wav'));

const listed = await listVoiceProfiles({ voicesRoot: tmp });
assert.equal(listed.length, 1);
assert.equal(listed[0].id, 'jinx-demo');

const loaded = await loadVoiceProfileFromDir(path.join(tmp, 'jinx-demo'));
const expanded = applyVoiceProfileToSpeechBody(
  { voice: 'jinx-demo', input: 'Hello Player One.' },
  loaded
);
assert.equal(expanded.applied, true);
assert.equal(expanded.body.model, 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit');
assert.equal(expanded.body.ref_text, 'slow, teasing every edge. You boys like that?');
assert.equal(expanded.body.temperature, 1.05);
assert.equal(expanded.body.input, 'Hello Player One.');
// Client override sampling
const overridden = applyVoiceProfileToSpeechBody(
  { voice: 'jinx-demo', input: 'Hi', temperature: 1.2 },
  loaded
);
assert.equal(overridden.body.temperature, 1.2);

const discovery = listVoicesDiscovery({
  profiles: listed,
  modelVoices: {
    model: 'custom',
    mode: 'custom_voice',
    defaultVoice: 'serena',
    voiceAliases: { alloy: 'serena' },
    data: [{ id: 'serena', name: 'Serena' }]
  },
  modelId: 'custom'
});
assert.ok(discovery.data.some((v) => v.id === 'serena' && v.source === 'model'));
assert.ok(discovery.data.some((v) => v.id === 'jinx-demo' && v.source === 'profile'));

const removed = await removeVoiceProfile('jinx-demo', { voicesRoot: tmp, yes: true });
assert.equal(removed.removed, true);
assert.equal((await listVoiceProfiles({ voicesRoot: tmp })).length, 0);

await fs.rm(tmp, { recursive: true, force: true });
console.log('voice-profiles tests passed');
