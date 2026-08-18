import assert from 'node:assert/strict';
import {
  inferTtsMode,
  listVoicesForModel,
  modelDiscoveryMetadata,
  normalizeSpeechRequestBody,
  resolveTtsDescriptor,
  speechSchemaForModel
} from '../src/tts-catalog.mjs';
import { createRegistry } from '../src/registry.mjs';

const customModel = {
  id: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-4bit',
  kind: 'audio_speech',
  capabilities: ['audio-speech', 'tts'],
  tts: { family: 'qwen3-tts', mode: 'custom_voice' }
};

const designModel = {
  id: 'mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-4bit',
  kind: 'audio_speech',
  tts: { mode: 'voice_design' }
};

const cloneModel = {
  id: 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit',
  kind: 'audio_speech',
  tts: { mode: 'voice_clone' }
};

assert.equal(inferTtsMode(customModel), 'custom_voice');
assert.equal(inferTtsMode(designModel), 'voice_design');
assert.equal(inferTtsMode(cloneModel), 'voice_clone');

const custom = resolveTtsDescriptor(customModel);
assert.equal(custom.mode, 'custom_voice');
assert.ok(custom.voices.some((v) => v.id === 'serena'));
assert.equal(custom.params.voice.required, true);
assert.equal(custom.params.instructions.role, 'style');
assert.ok(custom.capabilities.includes('tts-custom-voice'));

const design = resolveTtsDescriptor(designModel);
assert.equal(design.mode, 'voice_design');
assert.equal(design.params.instructions.required, true);
assert.equal(design.params.instructions.role, 'voice_description');
assert.ok(design.capabilities.includes('tts-voice-design'));

const clone = resolveTtsDescriptor(cloneModel);
assert.equal(clone.mode, 'voice_clone');
assert.equal(clone.acceptsMultipart, true);
assert.equal(clone.params.ref_audio.required, true);
assert.equal(clone.params.ref_text.required, true);
assert.ok(clone.capabilities.includes('tts-voice-clone'));

const voices = listVoicesForModel(customModel);
assert.equal(voices.object, 'list');
assert.ok(voices.data.length >= 5);
assert.equal(voices.voiceAliases.alloy, 'serena');

const schema = speechSchemaForModel(cloneModel);
assert.equal(schema.object, 'speech.schema');
assert.ok(schema.contentTypes.includes('multipart/form-data'));

const meta = modelDiscoveryMetadata(customModel);
assert.equal(meta.speech.endpoint, '/v1/audio/speech');
assert.equal(meta.tts.mode, 'custom_voice');

const normalized = normalizeSpeechRequestBody(
  {
    model: 'qwen3-tts',
    input: 'hi',
    voice: 'alloy',
    instructions: 'Be bright.'
  },
  { upstreamModel: customModel.id }
);
assert.equal(normalized.model, customModel.id);
assert.equal(normalized.voice, 'serena');
assert.equal(normalized.instruct, 'Be bright.');
assert.equal(normalized.instructions, 'Be bright.');
assert.equal(normalized.response_format, 'wav');

const registry = createRegistry({
  defaults: {
    speechModel: customModel.id,
    transcriptionModel: 'whisper'
  },
  backends: {
    audio: { type: 'openai', baseUrl: 'http://127.0.0.1:8220/v1' }
  },
  runtimes: {
    audio: { enabled: true }
  },
  models: [
    { ...customModel, backend: 'audio', runtime: 'audio', advertise: true },
    { ...designModel, backend: 'audio', runtime: 'audio', advertise: true },
    { ...cloneModel, backend: 'audio', runtime: 'audio', advertise: true },
    {
      id: 'whisper',
      kind: 'audio_transcription',
      backend: 'audio',
      runtime: 'audio',
      advertise: true,
      capabilities: ['audio-transcription', 'stt']
    }
  ],
  aliases: {
    'qwen3-tts-design': { target: designModel.id, advertise: true }
  }
});

const openAI = registry.openAIModels();
const designEntry = openAI.find((m) => m.id === designModel.id);
assert.ok(designEntry);
assert.equal(designEntry.metadata.tts.mode, 'voice_design');
assert.ok(designEntry.metadata.capabilities.includes('tts-voice-design'));

const catalog = registry.speechCatalog();
assert.equal(catalog.object, 'speech.catalog');
assert.ok(catalog.models.some((m) => m.mode === 'voice_clone'));

const voiceList = registry.voices('qwen3-tts-design');
assert.equal(voiceList.mode, 'voice_design');
assert.deepEqual(voiceList.data, []);

const cloneSchema = registry.speechSchema(cloneModel.id);
assert.equal(cloneSchema.params.ref_audio.required, true);

const chatterboxModel = {
  id: 'ResembleAI/chatterbox',
  kind: 'audio_speech',
  tts: { family: 'chatterbox', mode: 'voice_clone', variant: 'english' }
};
const chatterbox = resolveTtsDescriptor(chatterboxModel);
assert.equal(chatterbox.family, 'chatterbox');
assert.equal(chatterbox.mode, 'voice_clone');
assert.equal(chatterbox.variant, 'english');
assert.equal(chatterbox.params.ref_audio.required, false);
assert.equal(chatterbox.params.exaggeration.default, 0.5);
assert.equal(chatterbox.params.cfg_weight.default, 0.5);
assert.ok(chatterbox.capabilities.includes('chatterbox'));
assert.ok(chatterbox.capabilities.includes('tts-exaggeration'));

const chatterboxMtl = resolveTtsDescriptor({
  id: 'ResembleAI/chatterbox-multilingual',
  kind: 'audio_speech'
});
assert.equal(chatterboxMtl.variant, 'multilingual');
assert.equal(chatterboxMtl.params.language.required, true);
assert.ok(chatterboxMtl.capabilities.includes('tts-multilingual'));

const chatterboxTurbo = resolveTtsDescriptor({
  id: 'ResembleAI/chatterbox-turbo',
  kind: 'audio_speech'
});
assert.equal(chatterboxTurbo.variant, 'turbo');
assert.ok(!chatterboxTurbo.capabilities.includes('tts-exaggeration'));

const chatterboxNormalized = normalizeSpeechRequestBody({
  model: 'chatterbox',
  input: 'hi',
  ref_audio: '/tmp/ref.wav',
  language: 'en',
  cfgWeight: 0.4,
  exaggeration: 0.7
});
assert.equal(chatterboxNormalized.audio_prompt_path, '/tmp/ref.wav');
assert.equal(chatterboxNormalized.language_id, 'en');
assert.equal(chatterboxNormalized.cfg_weight, 0.4);

console.log('tts-catalog tests passed');
