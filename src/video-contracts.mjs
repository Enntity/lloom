/** Local video workflow contracts. Unknown providers retain their own contract. */
const base = [
  'model',
  'prompt',
  'image',
  'width',
  'height',
  'size',
  'duration',
  'num_frames',
  'fps',
  'frame_rate',
  'seed',
  'steps',
  'response_format'
];
const guidance = [
  'guidance_scale',
  'stg_scale',
  'rescale_scale',
  'a2v_guidance_scale',
  'video_skip_step',
  'audio_guidance_scale',
  'audio_stg_scale',
  'audio_rescale_scale',
  'v2a_guidance_scale',
  'audio_skip_step'
];
const nativeBase = [
  ...base,
  'image_strength',
  'sampler',
  'negative_prompt',
  'last_frame',
  'keyframes',
  'audio',
  'audio_start_time',
  'generated_keyframes',
  'temporal_upscalings',
  'spatial_upscalings',
  'offload',
  'quantization',
  'max_batch_size',
  ...guidance
];
const sharedTiming = { frameGrid: '8k+1', minFrames: 9, maxFrames: 481, defaultFrames: 121, defaultFps: 24 };
function nativeWorkflow(name, { guided = false, generatedKeyframes = false, steps = null } = {}) {
  const editing = name === 'retake';
  const audio = name === 'audio-to-video';
  const fields = editing
    ? [
        'model',
        'prompt',
        'video',
        'start_time',
        'end_time',
        'seed',
        'offload',
        'quantization',
        'max_batch_size',
        'response_format'
      ]
    : nativeBase.filter((field) => {
        if (['audio', 'audio_start_time', 'sampler'].includes(field)) return audio;
        if (['temporal_upscalings', 'spatial_upscalings'].includes(field)) return name === 'refine';
        if (field === 'generated_keyframes') return generatedKeyframes;
        if (['steps', 'negative_prompt', ...guidance].includes(field))
          return guided && !(audio && (field.startsWith('audio_') || field.startsWith('v2a_')));
        return true;
      });
  return {
    fields: ['workflow', ...fields],
    promptFormats: ['text', 'structured'],
    references: {
      image: !editing,
      audio: audio ? 'driving audio preserved; silence appended if needed' : false,
      video: editing ? 'source video; edit start_time to end_time' : false,
      last_frame: !editing,
      keyframes: !editing
    },
    timing: editing ? { source: 'video', constantIntegerFps: true, frameGrid: '8k+1' } : sharedTiming,
    defaults: {
      ...(editing ? {} : { width: 832, height: 512, num_frames: 121, fps: 24, steps }),
      ...(audio
        ? {
            sampler: 'euler_ancestral',
            image_strength: 0.7,
            guidance_scale: 3,
            stg_scale: 0,
            rescale_scale: 0,
            a2v_guidance_scale: 1
          }
        : {})
    },
    notes: editing
      ? ['Retake regenerates both video and audio latents inside the selected interval.']
      : audio
        ? ['Native Euler ancestral sampling with frozen supplied speech; explicit overrides are preserved.']
        : name === 'refine'
          ? ['Requires the separate pixel-spatial detailing IC-LoRA.']
          : ['BF16 native workflow; guided workflows use upstream settings unless overridden.']
  };
}
const nativeModels = {
  'Lightricks/LTX-2.5-Full': {
    defaultWorkflow: 'generate',
    workflows: {
      generate: nativeWorkflow('generate', { guided: true, generatedKeyframes: true, steps: 30 }),
      'generate-hq': nativeWorkflow('generate-hq', { guided: true, generatedKeyframes: true, steps: 15 }),
      'audio-to-video': nativeWorkflow('audio-to-video', { guided: true, steps: 30 }),
      keyframes: nativeWorkflow('keyframes', { guided: true, steps: 30 })
    }
  },
  'Lightricks/LTX-2.5-Distilled': {
    defaultWorkflow: 'generate',
    workflows: {
      generate: nativeWorkflow('generate', { generatedKeyframes: true }),
      retake: nativeWorkflow('retake'),
      refine: nativeWorkflow('refine')
    }
  }
};
for (const [id, model] of Object.entries(nativeModels)) {
  for (const [name, contract] of Object.entries(model.workflows)) {
    Object.assign(contract, { family: 'ltx-native', model: id, workflow: name });
  }
}

function reject(message) {
  const e = new Error(message);
  e.statusCode = 400;
  e.code = 'invalid_video_parameter';
  throw e;
}

/**
 * Resolve the contract for a public model ID and workflow.
 *
 * @param {string} id Public gateway/upstream model ID.
 * @param {string} [workflow] Explicit workflow name. Omitted defaults to the
 *   model's default workflow. Present-but-invalid values are rejected.
 */
export function videoContractForModel(id, workflow) {
  const native = Object.hasOwn(nativeModels, id) ? nativeModels[id] : null;
  if (native) {
    if (workflow === undefined) workflow = native.defaultWorkflow;
    else if (workflow === null || typeof workflow !== 'string' || !workflow.trim())
      reject('workflow must be a non-empty string');
    if (!Object.prototype.hasOwnProperty.call(native.workflows, workflow))
      reject(`${id} does not support workflow '${workflow}'`);
    return {
      ...native.workflows[workflow],
      defaultWorkflow: native.defaultWorkflow,
      workflows: native.workflows
    };
  }
  // The per-workflow native IDs were removed with no compatibility aliases.
  // Reject them explicitly instead of letting them fall through as unknown
  // providers, which would silently pass an unsupported model to a backend.
  if (typeof id === 'string' && /^Lightricks\/LTX-2\.5-(?:Dev-HQ|Dev|A2V|Keyframes|Retake|DFR)$/.test(id))
    reject(
      `${id} is no longer a public model; use Lightricks/LTX-2.5-Full or Lightricks/LTX-2.5-Distilled with a workflow`
    );
  if (id === 'MiniMaxAI/MiniMax-H3' || id === 'MiniMaxAI/MiniMax-H3-Turbo') {
    const turbo = id.endsWith('Turbo');
    return {
      family: 'minimax-h3',
      workflow: turbo ? 'turbo' : 'auto frames/reference',
      fields: [
        ...base,
        'frames',
        'n',
        'transcript',
        'first_frame',
        'last_frame',
        ...(turbo ? [] : ['audio', 'video', 'workflow', 'ref_image_size', 'video_audio'])
      ],
      promptFormats: ['text', 'structured JSON'],
      references: {
        image: true,
        audio: turbo ? false : 'voice/timbre reference; supply transcript for requested words',
        video: !turbo,
        last_frame: true
      },
      timing: { frameGrid: '17k+5', minFrames: 124, maxFrames: 362, defaultFrames: 124, defaultFps: 24, fixedFps: 24 },
      steps: turbo ? { min: 8, max: 8, default: 8 } : { min: 10, max: 50, default: 20 },
      notes: [
        'Use <Picture 1>, <Video 1>, and <Audio 1> in reference prompts.',
        'H3 generates speech; transcript adherence must be auditioned.'
      ]
    };
  }
  if (id === 'Lightricks/LTX-2.5' || id === 'Lightricks/LTX-2.5-Comfy-Full')
    return {
      family: 'ltx-comfy',
      workflow: id.endsWith('Comfy-Full') ? 'full' : 'distilled',
      fields: [
        ...(id.endsWith('Comfy-Full') ? ['guidance_scale'] : []),
        ...base,
        'frames',
        'n',
        'first_frame',
        'last_frame',
        'audio',
        'negative_prompt',
        'image_strength',
        'voice_reference',
        'voice_identity',
        'voice_start',
        'voice_end'
      ],
      promptFormats: ['text', 'structured'],
      references: { image: true, last_frame: true, audio: 'driving audio', video: false },
      timing: { frameGrid: '8k+1', minFrames: 25, maxFrames: 241, defaultFrames: 121, defaultFps: 24, fixedFps: 24 },
      steps: id.endsWith('Comfy-Full') ? { min: 10, max: 60, default: 30 } : { min: 8, max: 8, default: 8 }
    };
  if (id === 'Wan-AI/Wan2.2-TI2V-5B-Diffusers')
    return {
      family: 'wan',
      fields: [
        'model',
        'prompt',
        'negative_prompt',
        'size',
        'num_frames',
        'fps',
        'seed',
        'steps',
        'image',
        'response_format'
      ],
      promptFormats: ['text', 'structured'],
      references: { image: true, audio: false, video: false, last_frame: false },
      timing: { frameGrid: '4k+1', minFrames: 9, maxFrames: 121, defaultFrames: 49, defaultFps: 24 },
      steps: { min: 4, max: 50, default: 30 }
    };
  return null;
}
export function normalizeStructuredVideoPrompt(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (!prompt || typeof prompt !== 'object' || Array.isArray(prompt) || !Object.keys(prompt).length)
    reject('prompt must be text or a non-empty structured object');
  const allowed = [
    'description',
    'subject',
    'action',
    'camera',
    'lighting',
    'environment',
    'style',
    'dialogue',
    'motion',
    'audio',
    'timeline'
  ];
  return Object.entries(prompt)
    .map(([key, value]) => {
      if (!allowed.includes(key)) reject(`Unsupported structured prompt field: ${key}`);
      if (!value || !['string', 'object'].includes(typeof value)) reject(`Invalid prompt.${key}`);
      return `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
    })
    .join('\n');
}
export function prepareVideoRequest(id, body) {
  const native = Object.hasOwn(nativeModels, id) ? nativeModels[id] : null;
  // Only native LTX and the Comfy LTX routes understand a workflow selector.
  const suppliedWorkflow = native || id === 'Lightricks/LTX-2.5-Comfy-Full' ? body.workflow : undefined;
  const contract = videoContractForModel(id, native ? suppliedWorkflow : undefined);
  if (!contract) return body;
  const p = { ...body };
  for (const key of Object.keys(p)) if (!contract.fields.includes(key)) reject(`${id} does not support '${key}'`);
  if (contract.family === 'wan' || contract.family === 'ltx-comfy') p.prompt = normalizeStructuredVideoPrompt(p.prompt);
  else if (typeof p.prompt !== 'string' && (!p.prompt || typeof p.prompt !== 'object' || Array.isArray(p.prompt)))
    reject('prompt must be text or a structured object');
  if (typeof p.prompt === 'string' && !p.prompt.trim()) reject('prompt must not be empty');
  if (contract.family === 'ltx-comfy') {
    if ('guidance_scale' in p && (!Number.isFinite(p.guidance_scale) || p.guidance_scale < 1 || p.guidance_scale > 20))
      reject('guidance_scale must be a number between 1 and 20');
    if ('image_strength' in p && !(p.image || p.first_frame)) reject('image_strength requires an image');
    const voice = ['voice_reference', 'voice_identity', 'voice_start', 'voice_end'];
    if (voice.some((k) => k in p) && !p.audio) reject('voice controls require audio');
    if (p.voice_reference === 0 && voice.slice(1).some((k) => k in p))
      reject('voice guidance requires voice_reference=1');
  }
  if (contract.family === 'ltx-native' && contract.workflow !== 'retake' && 'image_strength' in p) {
    if (!p.image) reject('image_strength requires an image');
    if (typeof p.image_strength === 'boolean' || !Number.isFinite(p.image_strength))
      reject('image_strength must be a number between 0 and 1');
    if (p.image_strength < 0 || p.image_strength > 1) reject('image_strength must be between 0 and 1');
  }
  if (contract.family === 'ltx-native' && contract.workflow === 'audio-to-video' && 'sampler' in p) {
    if (!['euler', 'euler_ancestral'].includes(p.sampler)) reject('sampler must be euler or euler_ancestral');
  }
  if ('size' in p && ('width' in p || 'height' in p)) reject('Provide size or width/height, not both');
  if ('fps' in p && 'frame_rate' in p) reject('Provide fps or frame_rate, not both');
  const fps = p.fps ?? p.frame_rate;
  if (
    fps != null &&
    (!Number.isFinite(fps) || fps < 1 || fps > 60 || (contract.timing.fixedFps && fps !== contract.timing.fixedFps))
  )
    reject(`Invalid fps for ${id}`);
  if ('frames' in p && 'num_frames' in p) reject('Provide frames or num_frames, not both');
  if ('duration' in p && ('frames' in p || 'num_frames' in p)) reject('Provide duration or frame count, not both');
  if ('first_frame' in p && 'image' in p) reject('Provide image or first_frame, not both');
  const frames = p.num_frames ?? p.frames;
  if (frames != null) {
    const modulus = contract.timing.frameGrid === '17k+5' ? 17 : contract.timing.frameGrid === '4k+1' ? 4 : 8;
    const offset = modulus === 17 ? 5 : 1;
    if (
      !Number.isInteger(frames) ||
      frames < contract.timing.minFrames ||
      frames > contract.timing.maxFrames ||
      (frames - offset) % modulus
    )
      reject(`num_frames must follow ${contract.timing.frameGrid} within this model's bounds`);
  }
  if (
    p.steps != null &&
    (!Number.isInteger(p.steps) ||
      p.steps < 1 ||
      p.steps > 100 ||
      (contract.steps && (p.steps < contract.steps.min || p.steps > contract.steps.max)))
  )
    reject(`Invalid steps for ${id}`);
  if (
    p.generated_keyframes != null &&
    (!Number.isInteger(p.generated_keyframes) ||
      p.generated_keyframes < 0 ||
      p.generated_keyframes > Math.min(8, (frames ?? 121) - 2))
  )
    reject('generated_keyframes must fit inside the video frame count');
  if (contract.family === 'ltx-native' && contract.workflow === 'audio-to-video' && !p.audio)
    reject('LTX audio-to-video requires audio');
  if (
    contract.family === 'ltx-native' &&
    contract.workflow === 'retake' &&
    (!p.video ||
      !Number.isFinite(p.start_time) ||
      !Number.isFinite(p.end_time) ||
      p.start_time < 0 ||
      p.end_time <= p.start_time)
  )
    reject('Retake requires video and 0 <= start_time < end_time');
  for (const key of ['image', 'first_frame', 'last_frame', 'audio', 'video'])
    if (p[key] != null && (typeof p[key] !== 'string' || !p[key].startsWith('data:')))
      reject(`${key} must be an inline data URI`);
  return p;
}
export function videoCatalog(models) {
  return {
    object: 'list',
    endpoint: '/v1/videos/generations',
    data: models
      .filter((m) => m.kind === 'video')
      .map((m) => {
        const contract = videoContractForModel(m.upstreamModel ?? m.id);
        if (!contract) return { id: m.id, object: 'video.model', runtime: m.runtime ?? null };
        if (contract.family !== 'ltx-native') {
          return { id: m.id, object: 'video.model', runtime: m.runtime ?? null, ...contract };
        }
        return {
          id: m.id,
          object: 'video.model',
          runtime: m.runtime ?? null,
          family: 'ltx-native',
          model: contract.model,
          default_workflow: contract.defaultWorkflow,
          workflows: Object.fromEntries(
            Object.entries(contract.workflows).map(([name, wf]) => [
              name,
              {
                fields: wf.fields,
                promptFormats: wf.promptFormats,
                references: wf.references,
                timing: wf.timing,
                defaults: wf.defaults,
                notes: wf.notes
              }
            ])
          )
        };
      })
  };
}
