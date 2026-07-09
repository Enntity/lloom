/**
 * LLooM voice profiles — named voices (especially ICL clones) installed under
 * ~/.lloom/voices/<id>/ so clients can call:
 *
 *   POST /v1/audio/speech { "voice": "jinx", "input": "Hello" }
 *
 * without supplying ref_audio / ref_text / model.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { defaultLloomHome } from './config.mjs';

export const VOICE_PROFILE_SCHEMA_VERSION = 1;

export function defaultVoicesRoot(env = process.env) {
  if (env.LLOOM_VOICES_ROOT) return env.LLOOM_VOICES_ROOT;
  return path.join(defaultLloomHome(env), 'voices');
}

function slugifyVoiceId(value) {
  return (
    String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'voice'
  );
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Normalize profile document (accept camelCase or snake_case).
 */
export function normalizeVoiceProfile(raw, { directory } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('voice profile must be an object');
  const id = slugifyVoiceId(raw.id ?? path.basename(directory ?? 'voice'));
  const kind = raw.kind ?? 'voice_clone';
  if (kind !== 'voice_clone') {
    throw new Error(`unsupported voice profile kind: ${kind} (only voice_clone is implemented)`);
  }
  const model = raw.model ?? raw.modelId ?? raw.upstreamModel;
  if (!model) throw new Error(`voice profile ${id} is missing model`);
  const refAudioRel = raw.refAudio ?? raw.ref_audio ?? 'reference.wav';
  const refText = raw.refText ?? raw.ref_text;
  if (!refText || !String(refText).trim()) {
    throw new Error(`voice profile ${id} is missing refText / ref_text`);
  }
  const defaults = asObject(raw.defaults);
  return {
    schemaVersion: Number(raw.schemaVersion ?? VOICE_PROFILE_SCHEMA_VERSION),
    id,
    name: raw.name ?? id,
    description: raw.description ?? null,
    kind,
    model,
    refAudio: refAudioRel,
    refText: String(refText).trim(),
    defaults: {
      temperature: defaults.temperature ?? 1.05,
      top_p: defaults.top_p ?? defaults.topP ?? 0.9,
      top_k: defaults.top_k ?? defaults.topK ?? 40,
      repetition_penalty: defaults.repetition_penalty ?? defaults.repetitionPenalty ?? 1.7,
      response_format: defaults.response_format ?? defaults.responseFormat ?? 'wav'
    },
    tags: Array.isArray(raw.tags) ? raw.tags : ['clone'],
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    directory: directory ?? null
  };
}

export function profileRefAudioPath(profile) {
  if (!profile?.directory) {
    throw new Error(`voice profile ${profile?.id ?? '?'} has no directory`);
  }
  const rel = profile.refAudio ?? 'reference.wav';
  if (path.isAbsolute(rel)) return rel;
  return path.join(profile.directory, rel);
}

export async function loadVoiceProfileFromDir(directory) {
  const profilePath = path.join(directory, 'profile.json');
  const raw = JSON.parse(await fs.readFile(profilePath, 'utf8'));
  const profile = normalizeVoiceProfile(raw, { directory });
  const refPath = profileRefAudioPath(profile);
  if (!existsSync(refPath)) {
    throw new Error(`voice profile ${profile.id} missing reference audio: ${refPath}`);
  }
  return {
    ...profile,
    refAudioPath: refPath,
    profilePath
  };
}

export async function listVoiceProfiles({ voicesRoot = defaultVoicesRoot() } = {}) {
  let entries;
  try {
    entries = await fs.readdir(voicesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(voicesRoot, entry.name);
    try {
      profiles.push(await loadVoiceProfileFromDir(directory));
    } catch {
      // skip broken / incomplete installs
    }
  }
  return profiles.sort((a, b) => a.id.localeCompare(b.id));
}

export async function getVoiceProfile(voiceId, { voicesRoot = defaultVoicesRoot() } = {}) {
  if (!voiceId) return null;
  const id = slugifyVoiceId(voiceId);
  const directory = path.join(voicesRoot, id);
  try {
    return await loadVoiceProfileFromDir(directory);
  } catch {
    return null;
  }
}

/**
 * If body.voice names an installed profile, expand into a full clone speech request.
 * Client fields (input, temperature, …) override profile defaults.
 */
export function applyVoiceProfileToSpeechBody(body = {}, profile) {
  if (!profile) return { body, profile: null, applied: false };

  const client = { ...body };
  const voiceKey = client.voice != null ? slugifyVoiceId(client.voice) : null;
  if (voiceKey && voiceKey !== profile.id) {
    // caller asked for a different voice string; still allow explicit profile pass
  }

  const defaults = asObject(profile.defaults);
  // Named clone profiles always bind to their Base/ICL model. Client overrides
  // apply to sampling / text only — not to switching away from the profile recipe.
  const next = {
    ...defaults,
    ...client,
    model: profile.model,
    voice: profile.id,
    ref_audio: client.ref_audio ?? client.refAudio ?? profile.refAudioPath,
    ref_text: client.ref_text ?? client.refText ?? profile.refText,
    response_format: client.response_format ?? client.responseFormat ?? defaults.response_format ?? 'wav'
  };

  // Sampling: profile defaults under client overrides (already merged via ...defaults then ...client)
  for (const key of ['temperature', 'top_p', 'top_k', 'repetition_penalty']) {
    if (client[key] == null && defaults[key] != null) next[key] = defaults[key];
  }

  return {
    body: next,
    profile,
    applied: true
  };
}

export function voiceProfileDiscoveryEntry(profile) {
  return {
    object: 'voice',
    id: profile.id,
    name: profile.name,
    source: 'profile',
    mode: profile.kind,
    kind: profile.kind,
    model: profile.model,
    family: 'qwen3-tts',
    description: profile.description,
    tags: profile.tags ?? [],
    defaults: profile.defaults,
    hasReference: true
  };
}

export function listVoicesDiscovery({ profiles = [], modelVoices = null, modelId = null } = {}) {
  const data = [];
  if (modelVoices?.data) {
    for (const voice of modelVoices.data) {
      data.push({
        object: 'voice',
        source: 'model',
        model: modelId ?? modelVoices.model,
        mode: modelVoices.mode ?? 'custom_voice',
        ...voice
      });
    }
  }
  for (const profile of profiles) {
    if (modelId && profile.model !== modelId && !modelMatchesProfile(modelId, profile)) {
      // when filtering by model, only show profiles targeting that model (or aliases)
      // if model is custom_voice, still show profiles for discovery of available character voices
      if (modelId && !String(modelId).toLowerCase().includes('base') && modelId !== profile.model) {
        // still include all profiles when listing for a specific non-clone model? Better include all profiles always as first-class voices
      }
    }
    data.push(voiceProfileDiscoveryEntry(profile));
  }
  // Always include all installed profiles as first-class voices (character pack).
  // Dedupe by id preferring profile entries.
  const byId = new Map();
  for (const entry of data) {
    const existing = byId.get(entry.id);
    if (!existing || entry.source === 'profile') byId.set(entry.id, entry);
  }
  return {
    object: 'list',
    model: modelId ?? null,
    defaultVoice: modelVoices?.defaultVoice ?? profiles[0]?.id ?? null,
    voiceAliases: modelVoices?.voiceAliases ?? {},
    profiles: profiles.map((p) => p.id),
    data: [...byId.values()]
  };
}

function modelMatchesProfile(modelId, profile) {
  return modelId === profile.model || modelId === profile.id;
}

export async function createVoiceInstallPlan({
  id,
  name,
  ref,
  refText,
  model = 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-4bit',
  description = null,
  tags = ['character', 'clone'],
  defaults = {},
  voicesRoot = defaultVoicesRoot(),
  force = false
} = {}) {
  const voiceId = slugifyVoiceId(id);
  if (!voiceId) throw new Error('voice id is required');
  if (!ref) throw new Error('--ref path to reference audio is required');
  if (!refText || !String(refText).trim()) throw new Error('--ref-text is required (transcript of the reference clip)');

  const directory = path.join(voicesRoot, voiceId);
  const profilePath = path.join(directory, 'profile.json');
  const refDest = path.join(directory, 'reference.wav');
  const refSource = path.resolve(String(ref).replace(/^~(?=\/|$)/, process.env.HOME ?? ''));
  if (!existsSync(refSource)) throw new Error(`reference audio not found: ${refSource}`);

  const exists = existsSync(profilePath);
  if (exists && !force) {
    throw new Error(`voice ${voiceId} already exists (use --force to overwrite)`);
  }

  const profile = normalizeVoiceProfile(
    {
      schemaVersion: VOICE_PROFILE_SCHEMA_VERSION,
      id: voiceId,
      name: name ?? voiceId,
      description,
      kind: 'voice_clone',
      model,
      refAudio: 'reference.wav',
      refText: String(refText).trim(),
      defaults: {
        temperature: 1.05,
        top_p: 0.9,
        top_k: 40,
        repetition_penalty: 1.7,
        response_format: 'wav',
        ...asObject(defaults)
      },
      tags,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    { directory }
  );

  return {
    dryRun: true,
    voiceId,
    directory,
    profilePath,
    refSource,
    refDest,
    exists,
    profile,
    next: {
      apply: `lloom voice-install ${voiceId} --ref ${shellArg(refSource)} --ref-text ${shellArg(profile.refText)} --model ${shellArg(model)} --apply --yes${force ? ' --force' : ''}`,
      speechExample: {
        model: profile.model,
        voice: voiceId,
        input: 'Hello from a named LLooM voice.'
      }
    }
  };
}

function shellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function copyFile(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await pipeline(createReadStream(src), createWriteStream(dest));
}

export async function installVoiceProfile(options = {}) {
  const plan = await createVoiceInstallPlan(options);
  if (options.dryRun !== false && !options.apply) {
    return plan;
  }
  if (!options.yes && options.apply) {
    throw new Error('Refusing to install voice without --yes (or yes: true)');
  }

  await fs.mkdir(plan.directory, { recursive: true });
  await copyFile(plan.refSource, plan.refDest);

  const toWrite = {
    schemaVersion: plan.profile.schemaVersion,
    id: plan.profile.id,
    name: plan.profile.name,
    description: plan.profile.description,
    kind: plan.profile.kind,
    model: plan.profile.model,
    refAudio: 'reference.wav',
    refText: plan.profile.refText,
    defaults: plan.profile.defaults,
    tags: plan.profile.tags,
    createdAt: plan.profile.createdAt,
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(plan.profilePath, `${JSON.stringify(toWrite, null, 2)}\n`);

  const loaded = await loadVoiceProfileFromDir(plan.directory);
  return {
    ...plan,
    dryRun: false,
    installed: true,
    profile: loaded
  };
}

export async function removeVoiceProfile(voiceId, { voicesRoot = defaultVoicesRoot(), yes = false } = {}) {
  if (!yes) throw new Error('Refusing to remove voice without yes=true / --yes');
  const id = slugifyVoiceId(voiceId);
  const directory = path.join(voicesRoot, id);
  if (!existsSync(directory)) {
    return { removed: false, voiceId: id, reason: 'not-found' };
  }
  await fs.rm(directory, { recursive: true, force: true });
  return { removed: true, voiceId: id, directory };
}

/**
 * Resolve speech request voice field against installed profiles.
 */
export async function resolveSpeechVoice(body = {}, { voicesRoot = defaultVoicesRoot() } = {}) {
  const voice = body.voice ?? body.Voice;
  if (voice == null || voice === '') {
    return { body, profile: null, applied: false };
  }
  const profile = await getVoiceProfile(voice, { voicesRoot });
  if (!profile) {
    return { body, profile: null, applied: false, unknownVoice: false };
  }
  return applyVoiceProfileToSpeechBody(body, profile);
}
