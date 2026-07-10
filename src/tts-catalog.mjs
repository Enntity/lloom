/**
 * TTS / STT discovery descriptors for LLooM clients.
 *
 * Models may embed an explicit `tts` / `stt` object in config. When missing,
 * descriptors are inferred from known model id patterns (Qwen3-TTS, Whisper, …).
 */

export const QWEN3_CUSTOM_VOICES = [
  { id: 'serena', name: 'Serena', gender: 'female', languages: ['en', 'zh'] },
  { id: 'vivian', name: 'Vivian', gender: 'female', languages: ['en', 'zh'] },
  { id: 'uncle_fu', name: 'Uncle Fu', gender: 'male', languages: ['zh', 'en'] },
  { id: 'ryan', name: 'Ryan', gender: 'male', languages: ['en'] },
  { id: 'aiden', name: 'Aiden', gender: 'male', languages: ['en'] },
  { id: 'ono_anna', name: 'Ono Anna', gender: 'female', languages: ['ja', 'en'] },
  { id: 'sohee', name: 'Sohee', gender: 'female', languages: ['ko', 'en'] },
  { id: 'eric', name: 'Eric', gender: 'male', languages: ['en'] },
  { id: 'dylan', name: 'Dylan', gender: 'male', languages: ['en'] }
];

export const OPENAI_VOICE_ALIASES = {
  alloy: 'serena',
  echo: 'aiden',
  fable: 'ryan',
  onyx: 'uncle_fu',
  nova: 'vivian',
  shimmer: 'sohee',
  coral: 'serena',
  verse: 'ryan',
  ballad: 'vivian',
  ash: 'aiden',
  sage: 'eric',
  marin: 'sohee',
  cedar: 'dylan',
  chelsie: 'serena',
  ethan: 'ryan',
  default: 'serena'
};

export const SPEECH_RESPONSE_FORMATS = ['wav', 'mp3', 'flac', 'opus', 'aac', 'pcm'];

function modelText(model = {}) {
  return [model.id, model.upstreamModel, model.name, ...(model.tags ?? [])].filter(Boolean).join(' ').toLowerCase();
}

function param(spec) {
  return { ...spec };
}

export function inferTtsMode(model) {
  if (model?.tts?.mode) return model.tts.mode;
  const text = modelText(model);
  if (text.includes('voicedesign') || text.includes('voice-design') || text.includes('voice_design')) {
    return 'voice_design';
  }
  if (text.includes('customvoice') || text.includes('custom-voice') || text.includes('custom_voice')) {
    return 'custom_voice';
  }
  if (
    text.includes('base') ||
    text.includes('clone') ||
    text.includes('icl') ||
    (text.includes('qwen3-tts') && !text.includes('custom') && !text.includes('design'))
  ) {
    return 'voice_clone';
  }
  if (text.includes('kokoro') || text.includes('kitten')) return 'preset_voice';
  if (text.includes('tts') || model?.kind === 'audio_speech') return 'generic';
  return null;
}

function qwenCustomVoiceDescriptor(model) {
  const voices = QWEN3_CUSTOM_VOICES.map((voice) => ({ ...voice }));
  return {
    family: 'qwen3-tts',
    mode: 'custom_voice',
    modes: ['custom_voice'],
    description: 'Qwen3-TTS CustomVoice: pick a built-in speaker and optionally style it with instructions.',
    voices,
    defaultVoice: 'serena',
    voiceAliases: { ...OPENAI_VOICE_ALIASES },
    languages: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it'],
    sampleRate: 24000,
    responseFormats: [...SPEECH_RESPONSE_FORMATS],
    params: {
      input: param({
        type: 'string',
        required: true,
        description: 'Text to synthesize.',
        maxLength: 4096
      }),
      voice: param({
        type: 'string',
        required: true,
        enum: voices.map((voice) => voice.id),
        description: 'Built-in CustomVoice speaker id (or OpenAI voice alias).',
        default: 'serena'
      }),
      instructions: param({
        type: 'string',
        required: false,
        aliases: ['instruct'],
        role: 'style',
        description: 'Optional speaking style / emotion / delivery instructions.'
      }),
      language: param({
        type: 'string',
        required: false,
        aliases: ['lang_code'],
        description: 'Language hint (e.g. English, Chinese, auto).'
      }),
      speed: param({ type: 'number', required: false, minimum: 0.5, maximum: 2, default: 1 }),
      response_format: param({
        type: 'string',
        required: false,
        enum: SPEECH_RESPONSE_FORMATS,
        default: 'wav'
      })
    },
    examples: [
      {
        title: 'Preset speaker',
        body: {
          model: model.id,
          input: 'Hello from LLooM.',
          voice: 'serena',
          response_format: 'wav'
        }
      },
      {
        title: 'Styled delivery',
        body: {
          model: model.id,
          input: 'We shipped voice discovery.',
          voice: 'ryan',
          instructions: 'Speak cheerfully, with light enthusiasm.',
          response_format: 'wav'
        }
      }
    ]
  };
}

function qwenVoiceDesignDescriptor(model) {
  return {
    family: 'qwen3-tts',
    mode: 'voice_design',
    modes: ['voice_design'],
    description: 'Qwen3-TTS VoiceDesign: describe the desired voice in natural language via instructions.',
    voices: [],
    defaultVoice: null,
    voiceAliases: {},
    languages: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it'],
    sampleRate: 24000,
    responseFormats: [...SPEECH_RESPONSE_FORMATS],
    params: {
      input: param({
        type: 'string',
        required: true,
        description: 'Text to synthesize.',
        maxLength: 4096
      }),
      instructions: param({
        type: 'string',
        required: true,
        aliases: ['instruct'],
        role: 'voice_description',
        description: 'Natural-language description of the target voice (age, gender, accent, tone, character).'
      }),
      language: param({
        type: 'string',
        required: false,
        aliases: ['lang_code'],
        description: 'Language hint for the spoken text.'
      }),
      speed: param({ type: 'number', required: false, minimum: 0.5, maximum: 2, default: 1 }),
      response_format: param({
        type: 'string',
        required: false,
        enum: SPEECH_RESPONSE_FORMATS,
        default: 'wav'
      })
    },
    examples: [
      {
        title: 'Describe a voice',
        body: {
          model: model.id,
          input: 'Welcome to the local voice lab.',
          instructions: 'A warm middle-aged female narrator with a slight British accent, calm and clear.',
          response_format: 'wav'
        }
      }
    ]
  };
}

function qwenVoiceCloneDescriptor(model) {
  return {
    family: 'qwen3-tts',
    mode: 'voice_clone',
    modes: ['voice_clone'],
    description: 'Qwen3-TTS Base: zero-shot clone from a short reference clip (ref_audio + ref_text).',
    voices: [],
    defaultVoice: null,
    voiceAliases: {},
    languages: ['en', 'zh', 'ja', 'ko', 'de', 'fr', 'ru', 'pt', 'es', 'it'],
    sampleRate: 24000,
    responseFormats: [...SPEECH_RESPONSE_FORMATS],
    acceptsMultipart: true,
    params: {
      input: param({
        type: 'string',
        required: true,
        description: 'Text to synthesize in the cloned voice.',
        maxLength: 4096
      }),
      ref_audio: param({
        type: 'audio',
        required: true,
        description: 'Reference audio for cloning. JSON: local path or data URL. Multipart: file field ref_audio.',
        contentTypes: ['audio/wav', 'audio/mpeg', 'audio/flac', 'audio/ogg']
      }),
      ref_text: param({
        type: 'string',
        required: true,
        description: 'Exact transcript of the reference audio (strongly improves clone quality).'
      }),
      language: param({
        type: 'string',
        required: false,
        aliases: ['lang_code'],
        description: 'Language hint for the synthesized text.'
      }),
      speed: param({ type: 'number', required: false, minimum: 0.5, maximum: 2, default: 1 }),
      response_format: param({
        type: 'string',
        required: false,
        enum: SPEECH_RESPONSE_FORMATS,
        default: 'wav'
      })
    },
    examples: [
      {
        title: 'Clone from reference (JSON path)',
        body: {
          model: model.id,
          input: 'This sentence uses the reference speaker.',
          ref_audio: '/path/to/reference.wav',
          ref_text: 'Transcript of the reference clip.',
          response_format: 'wav'
        }
      },
      {
        title: 'Clone via multipart',
        multipart: true,
        fields: {
          model: model.id,
          input: 'This sentence uses the reference speaker.',
          ref_text: 'Transcript of the reference clip.',
          response_format: 'wav'
        },
        files: {
          ref_audio: 'reference.wav'
        }
      }
    ]
  };
}

function genericTtsDescriptor(model) {
  return {
    family: 'generic',
    mode: 'generic',
    modes: ['generic'],
    description: 'Generic OpenAI-compatible text-to-speech model.',
    voices: [
      { id: 'alloy', name: 'Alloy' },
      { id: 'echo', name: 'Echo' },
      { id: 'fable', name: 'Fable' },
      { id: 'onyx', name: 'Onyx' },
      { id: 'nova', name: 'Nova' },
      { id: 'shimmer', name: 'Shimmer' }
    ],
    defaultVoice: 'alloy',
    voiceAliases: {},
    responseFormats: [...SPEECH_RESPONSE_FORMATS],
    params: {
      input: param({ type: 'string', required: true }),
      voice: param({ type: 'string', required: false, default: 'alloy' }),
      instructions: param({
        type: 'string',
        required: false,
        aliases: ['instruct'],
        role: 'style'
      }),
      speed: param({ type: 'number', required: false, minimum: 0.25, maximum: 4, default: 1 }),
      response_format: param({
        type: 'string',
        required: false,
        enum: SPEECH_RESPONSE_FORMATS,
        default: 'wav'
      })
    },
    examples: [
      {
        title: 'Basic speech',
        body: {
          model: model.id,
          input: 'Hello.',
          voice: 'alloy',
          response_format: 'wav'
        }
      }
    ]
  };
}

function capabilitiesForTts(descriptor) {
  const caps = new Set(['audio-speech', 'tts', 'audio-output']);
  if (descriptor.mode === 'custom_voice' || descriptor.modes?.includes('custom_voice')) {
    caps.add('tts-custom-voice');
    caps.add('tts-style-instruct');
  }
  if (descriptor.mode === 'voice_design' || descriptor.modes?.includes('voice_design')) {
    caps.add('tts-voice-design');
  }
  if (descriptor.mode === 'voice_clone' || descriptor.modes?.includes('voice_clone')) {
    caps.add('tts-voice-clone');
  }
  if (descriptor.family === 'qwen3-tts') caps.add('qwen3-tts');
  return [...caps];
}

/**
 * Resolve full TTS descriptor for a model registry entry.
 */
export function resolveTtsDescriptor(model) {
  if (!model || (model.kind ?? 'chat') !== 'audio_speech') return null;

  const mode = inferTtsMode(model);
  let inferred;
  const text = modelText(model);
  if (text.includes('qwen3-tts') || text.includes('qwen3_tts')) {
    if (mode === 'voice_design') inferred = qwenVoiceDesignDescriptor(model);
    else if (mode === 'voice_clone') inferred = qwenVoiceCloneDescriptor(model);
    else inferred = qwenCustomVoiceDescriptor(model);
  } else if (mode === 'voice_design') {
    inferred = qwenVoiceDesignDescriptor(model);
  } else if (mode === 'voice_clone') {
    inferred = qwenVoiceCloneDescriptor(model);
  } else if (mode === 'custom_voice') {
    inferred = qwenCustomVoiceDescriptor(model);
  } else {
    inferred = genericTtsDescriptor(model);
  }

  const explicit = model.tts && typeof model.tts === 'object' ? model.tts : {};
  const merged = {
    ...inferred,
    ...explicit,
    params: {
      ...(inferred.params ?? {}),
      ...(explicit.params ?? {})
    },
    voiceAliases: {
      ...(inferred.voiceAliases ?? {}),
      ...(explicit.voiceAliases ?? {})
    },
    voices: explicit.voices ?? inferred.voices,
    examples: explicit.examples ?? inferred.examples,
    modes: explicit.modes ?? inferred.modes,
    responseFormats: explicit.responseFormats ?? inferred.responseFormats
  };

  merged.capabilities = [
    ...new Set([...(model.capabilities ?? []), ...capabilitiesForTts(merged), ...(explicit.capabilities ?? [])])
  ];
  return merged;
}

export function resolveSttDescriptor(model) {
  if (!model || (model.kind ?? 'chat') !== 'audio_transcription') return null;
  const text = modelText(model);
  const family = text.includes('whisper')
    ? 'whisper'
    : text.includes('qwen3-asr') || text.includes('qwen3_asr')
      ? 'qwen3-asr'
      : text.includes('parakeet')
        ? 'parakeet'
        : 'generic';

  const inferred = {
    family,
    description: 'OpenAI-compatible speech-to-text / transcription model.',
    acceptsMultipart: true,
    languages: family === 'whisper' ? ['auto', 'en', 'zh', 'ja', 'ko', 'es', 'fr', 'de'] : ['auto'],
    responseFormats: ['json', 'text', 'verbose_json'],
    params: {
      file: param({
        type: 'audio',
        required: true,
        description: 'Audio file to transcribe (multipart field file).'
      }),
      language: param({
        type: 'string',
        required: false,
        description: 'Language code (e.g. en) or omit for auto-detect.'
      }),
      response_format: param({
        type: 'string',
        required: false,
        enum: ['json', 'text', 'verbose_json'],
        default: 'json'
      }),
      prompt: param({
        type: 'string',
        required: false,
        description: 'Optional vocabulary / context hint when supported.'
      })
    },
    examples: [
      {
        title: 'Transcribe WAV',
        multipart: true,
        fields: {
          model: model.id,
          language: 'en',
          response_format: 'json'
        },
        files: { file: 'speech.wav' }
      }
    ]
  };

  const explicit = model.stt && typeof model.stt === 'object' ? model.stt : {};
  return {
    ...inferred,
    ...explicit,
    params: { ...(inferred.params ?? {}), ...(explicit.params ?? {}) },
    capabilities: [
      ...new Set([
        ...(model.capabilities ?? []),
        'audio-transcription',
        'stt',
        'audio-input',
        ...(explicit.capabilities ?? [])
      ])
    ]
  };
}

/**
 * Build OpenAI-style /v1/models metadata including tts/stt discovery blocks.
 */
export function modelDiscoveryMetadata(model) {
  const tts = resolveTtsDescriptor(model);
  const stt = resolveSttDescriptor(model);
  const capabilities = [
    ...new Set([...(model.capabilities ?? []), ...(tts?.capabilities ?? []), ...(stt?.capabilities ?? [])])
  ];

  const metadata = {
    name: model.name ?? model.id,
    kind: model.kind ?? 'chat',
    input: model.input ?? ['text'],
    output: model.output ?? ['text'],
    capabilities,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    aliasTarget: model.aliasTarget,
    tags: model.tags ?? []
  };

  if (tts) {
    metadata.tts = tts;
    metadata.speech = {
      endpoint: '/v1/audio/speech',
      voicesEndpoint: '/v1/audio/voices',
      schemaEndpoint: '/v1/audio/speech/schema',
      mode: tts.mode,
      family: tts.family
    };
  }
  if (stt) {
    metadata.stt = stt;
    metadata.transcription = {
      endpoint: '/v1/audio/transcriptions',
      schemaEndpoint: '/v1/audio/transcriptions/schema',
      family: stt.family
    };
  }
  return metadata;
}

export function listVoicesForModel(model) {
  const tts = resolveTtsDescriptor(model);
  if (!tts) return null;
  const voices = (tts.voices ?? []).map((voice) =>
    typeof voice === 'string' ? { id: voice, name: voice, object: 'voice' } : { object: 'voice', ...voice }
  );
  return {
    object: 'list',
    model: model.id,
    mode: tts.mode,
    family: tts.family,
    defaultVoice: tts.defaultVoice ?? null,
    voiceAliases: tts.voiceAliases ?? {},
    data: voices
  };
}

export function speechSchemaForModel(model) {
  const tts = resolveTtsDescriptor(model);
  if (!tts) return null;
  return {
    object: 'speech.schema',
    model: model.id,
    endpoint: 'POST /v1/audio/speech',
    contentTypes: tts.acceptsMultipart ? ['application/json', 'multipart/form-data'] : ['application/json'],
    ...tts
  };
}

export function transcriptionSchemaForModel(model) {
  const stt = resolveSttDescriptor(model);
  if (!stt) return null;
  return {
    object: 'transcription.schema',
    model: model.id,
    endpoint: 'POST /v1/audio/transcriptions',
    contentTypes: ['multipart/form-data', 'application/json'],
    ...stt
  };
}

/**
 * Normalize speech request body for upstream backends (OpenAI + Qwen/mlx-audio).
 */
export function normalizeSpeechRequestBody(body = {}, { upstreamModel } = {}) {
  const next = { ...body };
  if (upstreamModel) next.model = upstreamModel;

  // OpenAI uses `instructions`; mlx-audio / Qwen use `instruct`.
  if (next.instructions != null && next.instruct == null) {
    next.instruct = next.instructions;
  }
  if (next.instruct != null && next.instructions == null) {
    next.instructions = next.instruct;
  }

  if (next.language != null && next.lang_code == null) {
    next.lang_code = next.language;
  }
  if (next.lang_code != null && next.language == null) {
    next.language = next.lang_code;
  }

  if (typeof next.voice === 'string') {
    const alias = OPENAI_VOICE_ALIASES[next.voice.toLowerCase()];
    if (alias) next.voice = alias;
  }

  if (!next.response_format) next.response_format = 'wav';
  return next;
}

export function buildSpeechModelsSummary(models = []) {
  return models
    .filter((model) => (model.kind ?? 'chat') === 'audio_speech')
    .map((model) => {
      const tts = resolveTtsDescriptor(model);
      return {
        id: model.id,
        name: model.name ?? model.id,
        mode: tts?.mode,
        family: tts?.family,
        capabilities: tts?.capabilities ?? model.capabilities ?? [],
        defaultVoice: tts?.defaultVoice ?? null,
        voicesEndpoint: `/v1/audio/voices?model=${encodeURIComponent(model.id)}`,
        schemaEndpoint: `/v1/audio/speech/schema?model=${encodeURIComponent(model.id)}`
      };
    });
}
