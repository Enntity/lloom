/**
 * OpenRouter audio-generation (Lyria) adapter.
 *
 * `POST /v1/audio/generations` normally proxies an OpenAI-compatible media
 * backend that streams finished audio bytes. A backend configured with
 * `audioProvider: "openrouter"` instead runs the provider's SSE chat-style
 * audio generation inside LLooM and returns the assembled audio artifact.
 *
 * Official contract:
 *   POST https://openrouter.ai/api/v1/chat/completions
 *   { model, messages: [{ role: 'user', content }], modalities: ['text', 'audio'],
 *     audio: { format: 'wav' | 'mp3' }, stream: true }
 *
 * Audio arrives as SSE `choices[0].delta.audio.data` base64 chunks, terminated
 * by `data: [DONE]` (a successful `stop` followed by clean EOF is also accepted). The
 * provider API origin is fixed, redirects are rejected, credentials come from
 * the backend only, and unknown caller fields are refused rather than
 * forwarded. Nothing is returned until a complete, validated stream has been
 * aggregated, and billable generations are never retried automatically.
 */

import { spawn } from 'node:child_process';
import { fetch as undiciFetch } from 'undici';
import { applyOpenRouterProviderPolicy } from './protocol/openrouter-provider.mjs';

const OPENROUTER_ORIGIN = 'https://openrouter.ai';
const CHAT_COMPLETIONS_URL = `${OPENROUTER_ORIGIN}/api/v1/chat/completions`;
const AUDIO_FORMATS = new Set(['wav', 'mp3']);
// Caller fields that map to the provider contract. Everything else is refused
// so a caller cannot believe local generation controls (steps, cfg, seeds)
// were honored when the provider never received them.
const ALLOWED_FIELDS = new Set([
  'model',
  'prompt',
  'instructions',
  'lyrics',
  'input',
  'duration',
  'format',
  'response_format',
  'image',
  'reference_image'
]);
const MAX_TEXT_CHARS = 8000;
const MAX_IMAGE_CHARS = 8 * 1024 * 1024;
const MAX_DURATION_SECONDS = 600;
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 16 * 1024 * 1024;
const BASE64_CHUNK = /^[A-Za-z0-9+/]+={0,2}$/;
const IMAGE_DATA_URI = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

function boundedText(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(`Audio generation ${label} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > MAX_TEXT_CHARS) throw invalid(`Audio generation ${label} is too long`);
  return text;
}

/** Drain the provider body without echoing it into the error message. */
async function closeBody(body) {
  try {
    await boundedCleanup(() => body?.cancel());
  } catch {
    // The stream may already be errored or released; nothing to cancel.
  }
}

export async function generateProviderAudio({
  backend,
  body,
  signal,
  // Match the installed undici dispatcher contract.
  fetchFn = undiciFetch,
  dispatcher,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES
}) {
  if (backend?.audioProvider !== 'openrouter') throw new Error('Unsupported audio provider');
  const key = backend.apiKeyEnv ? process.env[backend.apiKeyEnv] : backend.apiKey;
  if (!key) throw new Error('Audio backend credential is not configured');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid audio provider timeout');
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error('Invalid audio provider size limit');
  if (!Number.isFinite(maxEventBytes) || maxEventBytes <= 0) throw new Error('Invalid audio provider event limit');
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw invalid('Audio generation request body is required');

  for (const field of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(field)) throw invalid(`Audio provider does not support field "${field}"`);
  }
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model || model.length > 200 || /\s/.test(model)) throw invalid('A valid audio generation model is required');
  if (body.format && body.response_format && body.format !== body.response_format)
    throw invalid('Conflicting audio formats');
  const format = body.response_format ?? body.format ?? 'wav';
  if (typeof format !== 'string' || !AUDIO_FORMATS.has(format)) throw invalid('Audio format must be wav or mp3');

  const prompt = boundedText(body.prompt, 'prompt');
  const instructions = boundedText(body.instructions, 'instructions');
  if (!prompt && !instructions) throw invalid('Audio generation requires a prompt or instructions');
  const lyrics = boundedText(body.lyrics, 'lyrics');
  const input = boundedText(body.input, 'input');

  let durationLine = null;
  if (body.duration !== undefined && body.duration !== null) {
    if (!Number.isFinite(body.duration) || body.duration <= 0 || body.duration > MAX_DURATION_SECONDS)
      throw invalid(`Audio duration must be between 0 and ${MAX_DURATION_SECONDS} seconds`);
    durationLine = `Duration: ${body.duration} seconds.`;
  }

  const referenceImage = body.image ?? body.reference_image;
  let image = null;
  if (referenceImage !== undefined && referenceImage !== null && referenceImage !== '') {
    if (
      typeof referenceImage !== 'string' ||
      referenceImage.length > MAX_IMAGE_CHARS ||
      !IMAGE_DATA_URI.test(referenceImage)
    )
      throw invalid('Reference image must be an inline PNG or JPEG data URI');
    image = referenceImage;
  }

  // Local music controls have no provider equivalent, so they are folded into
  // the prompt text instead of being faked as provider parameters.
  const text = [prompt, instructions, lyrics, input, durationLine].filter(Boolean).join('\n');
  const content = image
    ? [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: image } }
      ]
    : text;

  const payload = applyOpenRouterProviderPolicy(
    {
      model,
      messages: [{ role: 'user', content }],
      modalities: ['text', 'audio'],
      audio: { format },
      stream: true
    },
    { ...backend, baseUrl: OPENROUTER_ORIGIN }
  );

  const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  let response;
  try {
    response = await fetchFn(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      signal: boundedSignal,
      redirect: 'error',
      ...(dispatcher ? { dispatcher } : {}),
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': 'LLooM'
      },
      body: JSON.stringify(payload)
    });
  } catch {
    if (boundedSignal.aborted) throw new Error('Audio generation timed out or was cancelled');
    throw new Error('Audio provider request failed');
  }
  if (boundedSignal.aborted) {
    await closeBody(response?.body);
    throw new Error('Audio generation timed out or was cancelled');
  }

  if (!response.ok) {
    await closeBody(response.body);
    const error = new Error(`Audio provider openrouter returned HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType && !contentType.toLowerCase().includes('text/event-stream')) {
    await closeBody(response.body);
    throw new Error('Audio provider returned a non-SSE response');
  }

  let audio;
  try {
    audio = await collectAudio(response.body, boundedSignal, maxBytes, maxEventBytes);
  } catch (error) {
    await closeBody(response.body);
    throw error;
  }
  const actualFormat = identifyAudio(audio);
  validateAudio(audio, actualFormat);
  if (!actualFormat) throw new Error('Audio provider returned unrecognized audio');
  if (actualFormat !== format) audio = await convertAudio(audio, format, boundedSignal, maxBytes);
  return new Response(audio, {
    status: 200,
    headers: {
      'content-type': format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
      'content-length': String(audio.length),
      'x-lloom-provider': 'openrouter',
      'x-lloom-provider-origin': OPENROUTER_ORIGIN,
      'x-lloom-audio-format': format,
      'x-lloom-upstream-model': model
    }
  });
}

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function identifyAudio(audio) {
  if (audio.length >= 44 && audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE')
    return 'wav';
  if (
    audio.length >= 10 &&
    (audio.toString('ascii', 0, 3) === 'ID3' || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0))
  )
    return 'mp3';
  return null;
}

async function collectAudio(body, signal, maxBytes, maxEventBytes) {
  if (!body) throw new Error('Audio provider returned no audio');
  const chunks = [];
  let decodedBytes = 0,
    rawBytes = 0,
    pending = '',
    sawDone = false,
    sawFinish = false;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const ingest = (data) => {
    if (data.trim() === '[DONE]') {
      sawDone = true;
      return;
    }
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error('Audio provider sent a malformed event');
    }
    if (event?.error) throw new Error('Audio provider returned an error event');
    const choice = event?.choices?.find((value) => value.index === 0);
    if (choice?.finish_reason != null) {
      if (choice.finish_reason !== 'stop') throw new Error('Audio provider generation did not finish successfully');
      sawFinish = true;
    }
    const data64 = choice?.delta?.audio?.data;
    if (data64 === undefined || data64 === '') return;
    if (typeof data64 !== 'string' || data64.length % 4 || !BASE64_CHUNK.test(data64))
      throw new Error('Audio provider sent an invalid audio chunk');
    const chunk = Buffer.from(data64, 'base64');
    if (chunk.toString('base64') !== data64) throw new Error('Audio provider sent an invalid audio chunk');
    decodedBytes += chunk.length;
    if (decodedBytes > maxBytes) throw new Error('Audio generation exceeded the size limit');
    chunks.push(chunk);
  };
  // Race reads against cancellation even if an upstream stream stalls forever.
  const reader = body.getReader?.();
  const iterator = reader ? null : body[Symbol.asyncIterator]();
  let abort;
  const aborted = new Promise((_, reject) => {
    abort = () => reject(new Error('Audio generation timed out or was cancelled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    while (!sawDone) {
      if (signal.aborted) throw new Error('Audio generation timed out or was cancelled');
      let next;
      try {
        next = await Promise.race([reader ? reader.read() : iterator.next(), aborted]);
      } catch {
        throw new Error(
          signal.aborted ? 'Audio generation timed out or was cancelled' : 'Audio provider stream failed'
        );
      }
      if (next.done) break;
      rawBytes += next.value.byteLength;
      if (rawBytes > maxBytes * 2 + maxEventBytes) throw new Error('Audio provider stream exceeded the size limit');
      try {
        pending += decoder.decode(next.value, { stream: true });
      } catch {
        throw new Error('Audio provider sent a malformed event');
      }
      // Match CRLF without rewriting chunks: a split CR/LF remains intact.
      let match;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const block = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        if (Buffer.byteLength(block) > maxEventBytes) throw new Error('Audio provider event exceeded the size limit');
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) ingest(data);
        if (sawDone) break;
      }
      if (Buffer.byteLength(pending) > maxEventBytes) throw new Error('Audio provider event exceeded the size limit');
    }
    try {
      pending += decoder.decode();
    } catch {
      throw new Error('Audio provider stream ended mid-event');
    }
    if (!sawDone && pending.trim()) throw new Error('Audio provider stream ended mid-event');
    if (!sawDone && !sawFinish) throw new Error('Audio provider stream ended without a completion marker');
    if (!decodedBytes) throw new Error('Audio provider returned no audio');
    return Buffer.concat(chunks, decodedBytes);
  } finally {
    signal.removeEventListener('abort', abort);
    await boundedCleanup(() => (reader ? reader.cancel() : (body.cancel?.() ?? iterator.return?.())));
    reader?.releaseLock();
  }
}

async function convertAudio(input, format, signal, maxBytes) {
  // Provider formats are best effort (Lyria currently returns MP3 for WAV).
  // Decode only buffered audio, with no shell, URLs, files or network protocols.
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-xerror',
        '-err_detect',
        'explode',
        '-protocol_whitelist',
        'pipe',
        '-i',
        'pipe:0',
        '-map',
        '0:a:0',
        '-vn',
        '-acodec',
        format === 'wav' ? 'pcm_s16le' : 'libmp3lame',
        '-f',
        format,
        'pipe:1'
      ],
      { stdio: ['pipe', 'pipe', 'ignore'], signal }
    );
    const parts = [];
    let length = 0,
      failure;
    child.on('error', () => {
      failure = new Error('Audio conversion requires a working ffmpeg executable');
    });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (part) => {
      length += part.length;
      if (length > maxBytes) {
        failure = new Error('Audio conversion exceeded the size limit');
        child.kill('SIGKILL');
      } else parts.push(part);
    });
    child.on('close', (code) => {
      if (signal.aborted) reject(new Error('Audio generation timed out or was cancelled'));
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error('Audio conversion failed'));
      else resolve(Buffer.concat(parts, length));
    });
    child.stdin.end(input);
  });
  if (identifyAudio(output) !== format) throw new Error('Audio conversion returned an invalid format');
  if (format === 'wav') {
    // ffmpeg writes unknown sizes to pipes; make the completed WAV seekable.
    output.writeUInt32LE(output.length - 8, 4);
    for (let at = 12; at + 8 <= output.length;) {
      const size = output.readUInt32LE(at + 4);
      if (output.toString('ascii', at, at + 4) === 'data') {
        output.writeUInt32LE(output.length - at - 8, at + 4);
        break;
      }
      at += 8 + size + (size % 2);
    }
  }
  return output;
}

// Resource cleanup is bounded even for injected or broken upstream bodies.
async function boundedCleanup(cleanup) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve()
        .then(cleanup)
        .catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 250);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function validateAudio(audio, format) {
  const malformed = () => {
    throw new Error('Audio provider returned truncated or malformed audio');
  };
  if (format === 'wav') {
    if (audio.readUInt32LE(4) + 8 !== audio.length) malformed();
    let at = 12,
      data = false,
      fmt = false;
    while (at + 8 <= audio.length) {
      const size = audio.readUInt32LE(at + 4),
        end = at + 8 + size;
      if (end > audio.length) malformed();
      const id = audio.toString('ascii', at, at + 4);
      if (id === 'fmt ') {
        if (size < 16) malformed();
        fmt = true;
      }
      if (id === 'data') {
        if (size === 0) malformed();
        data = true;
      }
      at = end + (size % 2);
    }
    if (at !== audio.length || !fmt || !data) malformed();
  } else if (format === 'mp3') {
    let at = 0,
      frames = 0;
    if (audio.toString('ascii', 0, 3) === 'ID3') {
      if ([6, 7, 8, 9].some((i) => audio[i] & 0x80)) malformed();
      at = 10 + ((audio[6] << 21) | (audio[7] << 14) | (audio[8] << 7) | audio[9]) + (audio[5] & 0x10 ? 10 : 0);
    }
    while (at < audio.length) {
      if (audio.length - at === 128 && audio.toString('ascii', at, at + 3) === 'TAG') {
        at += 128;
        break;
      }
      if (at + 4 > audio.length || audio[at] !== 255 || (audio[at + 1] & 0xe0) !== 0xe0) malformed();
      const version = (audio[at + 1] >> 3) & 3,
        layer = (audio[at + 1] >> 1) & 3;
      const rateIndex = (audio[at + 2] >> 2) & 3,
        bitrateIndex = audio[at + 2] >> 4;
      if (version === 1 || layer !== 1 || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) malformed();
      const bitrate = (
        version === 3
          ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
          : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
      )[bitrateIndex];
      const sampleRate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
      const size = Math.floor(((version === 3 ? 144 : 72) * bitrate * 1000) / sampleRate) + ((audio[at + 2] >> 1) & 1);
      if (at + size > audio.length) malformed();
      at += size;
      frames++;
    }
    if (!frames || at !== audio.length) malformed();
  }
}
