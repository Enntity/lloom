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
  id: 'Character Demo',
  name: 'Character',
  ref: refPath,
  refText: 'This is a clear reference sentence for the local voice demo.',
  model: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit',
  defaults: { temperature: 1.05, top_p: 0.9, top_k: 40, repetition_penalty: 1.7 },
  voicesRoot: tmp,
  apply: true,
  yes: true,
  force: true
});

assert.equal(installed.installed, true);
assert.equal(installed.profile.id, 'character-demo');
assert.ok(installed.profile.refAudioPath.endsWith('reference.wav'));

const listed = await listVoiceProfiles({ voicesRoot: tmp });
assert.equal(listed.length, 1);
assert.equal(listed[0].id, 'character-demo');

const loaded = await loadVoiceProfileFromDir(path.join(tmp, 'character-demo'));
const expanded = applyVoiceProfileToSpeechBody({ voice: 'character-demo', input: 'Hello there.' }, loaded);
assert.equal(expanded.applied, true);
assert.equal(expanded.body.model, 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit');
assert.equal(expanded.body.ref_text, 'This is a clear reference sentence for the local voice demo.');
assert.equal(expanded.body.temperature, 1.05);
assert.equal(expanded.body.input, 'Hello there.');
// Client override sampling
const overridden = applyVoiceProfileToSpeechBody({ voice: 'character-demo', input: 'Hi', temperature: 1.2 }, loaded);
assert.equal(overridden.body.temperature, 1.2);

const retargeted = applyVoiceProfileToSpeechBody(
  {
    voice: 'character-demo',
    input: 'Hi from Chatterbox.',
    model: 'ResembleAI/chatterbox',
    exaggeration: 0.75,
    cfg_weight: 0.5
  },
  loaded
);
assert.equal(retargeted.body.model, 'ResembleAI/chatterbox');
assert.equal(retargeted.body.ref_audio, loaded.refAudioPath);
assert.equal(retargeted.body.exaggeration, 0.75);
assert.equal(retargeted.body.cfg_weight, 0.5);

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
assert.ok(discovery.data.some((v) => v.id === 'character-demo' && v.source === 'profile'));

const removed = await removeVoiceProfile('character-demo', { voicesRoot: tmp, yes: true });
assert.equal(removed.removed, true);
assert.equal((await listVoiceProfiles({ voicesRoot: tmp })).length, 0);

await fs.rm(tmp, { recursive: true, force: true });
console.log('voice-profiles tests passed');
