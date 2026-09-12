/**
 * Parse a provider JSON body without echoing any of it back. `response.json()`
 * failures embed the first bytes of the body in the error message, and gateway
 * errors forward `error.message` verbatim to callers.
 */
async function providerJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned a non-JSON response`);
  }
}

/** Read-only recovery of an accepted job whose failure response lost attribution.
 * Filter inside LLooM; never return input media, prompts, or provider credentials.
 */
export async function findRecentVideoJob({ backend, model, prompt, fetchFn = fetch }) {
  if (backend.videoProvider !== 'replicate') throw new Error('Job recovery currently supports Replicate');
  if (!/^[\w-]+\/[\w.-]+$/.test(model) || typeof prompt !== 'string' || !prompt.trim())
    throw new Error('Exact model and prompt required for job recovery');
  const key = backend.apiKeyEnv ? process.env[backend.apiKeyEnv] : backend.apiKey;
  if (!key) throw new Error('Video backend credential is not configured');
  const response = await fetchFn('https://api.replicate.com/v1/predictions', {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Token ${key}` }
  });
  if (!response.ok) throw new Error(`Video job lookup returned HTTP ${response.status}`);
  const body = await providerJson(response, 'Video job lookup');
  return (body.results || [])
    .filter((job) => job.model === model && job.input?.prompt === prompt)
    .map((job) => ({
      provider: 'replicate',
      jobId: job.id,
      model: job.model,
      status: job.status,
      createdAt: job.created_at,
      completedAt: job.completed_at,
      error:
        typeof job.error === 'string'
          ? job.error
              .replace(/data:[^\s]+/g, '[media]')
              .replace(/https?:\/\/[^\s]+/g, '[URL]')
              .slice(0, 2000)
          : null,
      inputFields: Object.keys(job.input || {}),
      hasOutput: Boolean(job.output),
      metrics: job.metrics || null
    }));
}

/** Provider jobs terminate inside LLooM. Callers receive media, never credentials. */
export async function generateProviderVideo({
  backend,
  body,
  signal,
  fetchFn = fetch,
  sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 8000,
  timeoutMs = 600000
}) {
  const provider = backend.videoProvider;
  if (!['replicate', 'openrouter'].includes(provider)) throw new Error('Unsupported video provider');
  const origin = provider === 'replicate' ? 'https://api.replicate.com' : 'https://openrouter.ai';
  const base = provider === 'replicate' ? `${origin}/v1` : `${origin}/api/v1`;
  const key = backend.apiKeyEnv ? process.env[backend.apiKeyEnv] : backend.apiKey;
  if (!key) throw new Error('Video backend credential is not configured');
  const deadline = Date.now() + timeoutMs;
  const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  const request = async (url, method = 'GET', payload, attempt = 0) => {
    if (new URL(url).origin !== origin) throw new Error('Unexpected video provider API origin');
    const r = await fetchFn(url, {
      method,
      signal: boundedSignal,
      redirect: 'error',
      headers: {
        Authorization: `${provider === 'replicate' ? 'Token' : 'Bearer'} ${key}`,
        'User-Agent': 'Mozilla/5.0 (compatible; LLooM/0.2)',
        'Content-Type': 'application/json'
      },
      ...(payload ? { body: JSON.stringify(payload) } : {})
    });
    // Retry only an explicit rate-limit rejection, never a network ambiguity.
    // Poll retries keep the accepted job ID; POST 429 means no job was accepted.
    if (r.status === 429 && attempt < 5) {
      const header = r.headers.get('retry-after');
      const numeric = Number(header);
      const retryMs =
        header && Number.isFinite(numeric)
          ? numeric * 1000
          : header && Number.isFinite(Date.parse(header))
            ? Date.parse(header) - Date.now()
            : 60000;
      const delay = Math.max(1000, retryMs);
      if (Date.now() + delay < deadline && !boundedSignal.aborted) {
        await r.body?.cancel();
        await sleepFn(delay);
        return request(url, method, payload, attempt + 1);
      }
    }
    if (!r.ok) {
      const error = new Error(`Video provider ${provider} returned HTTP ${r.status}`);
      error.statusCode = r.status;
      throw error;
    }
    return providerJson(r, `Video provider ${provider}`);
  };
  let job;
  if (provider === 'replicate') {
    if (!/^[\w-]+\/[\w.-]+$/.test(body.model)) throw new Error('Invalid Replicate model');
    // Keep each provider contract explicit. Never forward arbitrary caller input.
    let input;
    let predictionVersion;
    if (body.model === 'topazlabs/video-upscale') {
      if (!/^data:video\/mp4;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.video || ''))
        throw new Error('video MP4 data URI required');
      if (!['720p', '1080p', '4k'].includes(body.target_resolution)) throw new Error('Invalid target_resolution');
      if (!Number.isInteger(body.target_fps) || body.target_fps < 15 || body.target_fps > 60)
        throw new Error('Invalid target_fps');
      input = { video: body.video, target_resolution: body.target_resolution, target_fps: body.target_fps };
    } else if (body.model === 'kwaivgi/kling-v3-video') {
      const frames = body.frame_images;
      if (
        !Array.isArray(frames) ||
        (frames.length !== 1 && frames.length !== 2) ||
        frames.some((f) => !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(f.image_url?.url || '')) ||
        frames.filter((f) => f.frame_type === 'first_frame').length !== 1 ||
        frames.filter((f) => f.frame_type === 'last_frame').length !== frames.length - 1
      )
        throw new Error('First frame and optional last frame image data URIs required');
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 2500)
        throw new Error('Valid video prompt required');
      if (!Number.isInteger(body.duration) || body.duration < 3 || body.duration > 15)
        throw new Error('Invalid video duration');
      if (!['standard', 'pro', '4k'].includes(body.mode || 'standard')) throw new Error('Invalid video mode');
      input = {
        start_image: frames.find((f) => f.frame_type === 'first_frame').image_url.url,
        ...(frames.length === 2 ? { end_image: frames.find((f) => f.frame_type === 'last_frame').image_url.url } : {}),
        prompt: body.prompt,
        duration: body.duration,
        mode: body.mode || 'standard',
        generate_audio: body.generate_audio === true
      };
    } else if (body.model === 'vidu/q3-pro') {
      const frames = body.frame_images;
      if (
        !Array.isArray(frames) ||
        frames.length !== 2 ||
        frames.some((f) => !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(f.image_url?.url || '')) ||
        frames.filter((f) => f.frame_type === 'first_frame').length !== 1 ||
        frames.filter((f) => f.frame_type === 'last_frame').length !== 1
      )
        throw new Error('First and last frame image data URIs required');
      if (!Number.isInteger(body.duration) || body.duration < 1 || body.duration > 16)
        throw new Error('Invalid Vidu duration');
      if (!['540p', '720p', '1080p'].includes(body.resolution || '1080p')) throw new Error('Invalid resolution');
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 5000)
        throw new Error('Valid video prompt required');
      if (body.seed !== undefined && (!Number.isInteger(body.seed) || body.seed < 0 || body.seed > 2147483647))
        throw new Error('Invalid seed');
      input = {
        start_image: frames.find((f) => f.frame_type === 'first_frame').image_url.url,
        end_image: frames.find((f) => f.frame_type === 'last_frame').image_url.url,
        prompt: body.prompt,
        duration: body.duration,
        resolution: body.resolution || '1080p',
        audio: false,
        ...(body.seed !== undefined ? { seed: body.seed } : {})
      };
    } else if (body.model === 'lucataco/wan-2.2-first-last-frame') {
      const frames = body.frame_images;
      if (
        !Array.isArray(frames) ||
        frames.length !== 2 ||
        frames.some((f) => !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(f.image_url?.url || '')) ||
        frames.filter((f) => f.frame_type === 'first_frame').length !== 1 ||
        frames.filter((f) => f.frame_type === 'last_frame').length !== 1
      )
        throw new Error('First and last frame image data URIs required');
      const count = body.duration * 16;
      if (!Number.isInteger(count) || count < 9 || count > 121 || (count - 1) % 4 !== 0)
        throw new Error('Invalid short-join duration: use 9–121 frames at 16 fps, with frame count 4n+1');
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 2500)
        throw new Error('Valid video prompt required');
      if (body.seed !== undefined && (!Number.isInteger(body.seed) || body.seed < 0 || body.seed > 2147483647))
        throw new Error('Invalid seed');
      input = {
        start_image: frames.find((f) => f.frame_type === 'first_frame').image_url.url,
        end_image: frames.find((f) => f.frame_type === 'last_frame').image_url.url,
        prompt: body.prompt,
        duration_seconds: body.duration,
        ...(body.seed !== undefined ? { seed: body.seed } : {})
      };
      predictionVersion = '003fd8a38ff17cb6022c3117bb90f7403cb632062ba2b098710738d116847d57';
    } else if (body.model === 'lightricks/ltx-2.3-pro') {
      // Retake preserves video context outside the requested interval. This is
      // not extend + last_frame_image; the provider only supports that image in I2V.
      if (body.task !== 'retake') throw new Error('LTX route currently requires task retake');
      if (!/^data:video\/mp4;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.video || ''))
        throw new Error('video MP4 data URI required');
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 5000)
        throw new Error('Valid retake prompt required');
      if (!Number.isFinite(body.retake_start_time) || body.retake_start_time < 0)
        throw new Error('Invalid retake_start_time');
      if (!Number.isFinite(body.retake_duration) || body.retake_duration < 2 || body.retake_duration > 20)
        throw new Error('Invalid retake_duration: expected 2–20 seconds');
      if (!['16:9', '9:16'].includes(body.aspect_ratio || '16:9')) throw new Error('Invalid aspect_ratio');
      if (![24, 25, 48, 50].includes(body.fps ?? 24)) throw new Error('Invalid retake fps');
      if (body.resolution !== undefined && body.resolution !== '1080p') throw new Error('Retake requires 1080p');
      if (body.retake_mode !== undefined && body.retake_mode !== 'replace_video')
        throw new Error('This retake route requires replace_video');
      if (['frame_images', 'image', 'last_frame_image', 'reference_images'].some((key) => body[key] !== undefined))
        throw new Error('Retake uses surrounding video context, not frame image inputs');
      input = {
        task: 'retake',
        video: body.video,
        prompt: body.prompt,
        retake_start_time: body.retake_start_time,
        retake_duration: body.retake_duration,
        retake_mode: 'replace_video',
        resolution: '1080p',
        aspect_ratio: body.aspect_ratio || '16:9',
        fps: body.fps ?? 24
      };
    } else if (body.model === 'kwaivgi/kling-o1') {
      if (!/^data:video\/mp4;base64,[A-Za-z0-9+/]+={0,2}$/.test(body.video || ''))
        throw new Error('video MP4 data URI required');
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('Editing prompt required');
      if (!['std', 'pro'].includes(body.mode || 'pro')) throw new Error('Invalid editing mode');
      const images = body.reference_images || [];
      if (
        !Array.isArray(images) ||
        images.length > 4 ||
        images.some((image) => !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(image))
      )
        throw new Error('Up to four reference image data URIs required');
      if (body.frame_images !== undefined)
        throw new Error('Kling O1 editing cannot combine a last frame with video input; use reference_images');
      input = {
        reference_video: body.video,
        video_reference_type: 'base',
        prompt: body.prompt,
        mode: body.mode || 'pro',
        keep_original_sound: body.keep_original_sound !== false,
        reference_images: images
      };
    } else {
      // Data URIs avoid local paths and cross-host file access. No client URL fetches.
      for (const name of ['image', 'audio']) {
        if (!String(body[name] || '').startsWith(`data:${name}/`)) throw new Error(`${name} data URI required`);
      }
      input = { image: body.image, audio: body.audio, prompt: body.prompt, fast_mode: body.fast_mode === true };
    }
    job = await request(
      predictionVersion ? `${base}/predictions` : `${base}/models/${body.model}/predictions`,
      'POST',
      {
        input,
        ...(predictionVersion ? { version: predictionVersion } : {})
      }
    );
  } else {
    const { model, prompt, duration, resolution, aspect_ratio, frame_images } = body;
    if (
      !Array.isArray(frame_images) ||
      !frame_images.length ||
      frame_images.some((f) => !String(f.image_url?.url || '').startsWith('data:image/'))
    )
      throw new Error('Frame image data URIs required');
    job = await request(`${base}/videos`, 'POST', {
      model,
      prompt,
      duration,
      resolution,
      aspect_ratio,
      frame_images,
      generate_audio: false
    });
  }
  if (!job.id) throw new Error('Video provider returned no job ID');
  const jobUrl =
    provider === 'replicate'
      ? `${base}/predictions/${encodeURIComponent(job.id)}`
      : `${base}/videos/${encodeURIComponent(job.id)}`;
  while (!['succeeded', 'completed'].includes(job.status)) {
    if (['failed', 'canceled', 'cancelled', 'expired'].includes(job.status)) {
      const error = new Error(`Video job ${job.id} ${job.status}`);
      error.providerJobId = job.id;
      error.providerStatus = job.status;
      throw error;
    }
    if (Date.now() >= deadline || boundedSignal.aborted) throw new Error('Video job timed out or was cancelled');
    await sleepFn(pollMs);
    job = await request(jobUrl);
  }
  const output =
    provider === 'replicate'
      ? Array.isArray(job.output)
        ? job.output[0]
        : job.output
      : job.unsigned_urls?.[0] || `${jobUrl}/content?index=0`;
  const url = new URL(output);
  const replicateOutput = url.hostname === 'replicate.delivery' || url.hostname.endsWith('.replicate.delivery');
  const openrouterOutput = url.hostname === 'openrouter.ai' || url.hostname.endsWith('.openrouter.ai');
  if (
    url.protocol !== 'https:' ||
    !(url.origin === origin || (provider === 'replicate' ? replicateOutput : openrouterOutput))
  )
    throw new Error('Untrusted video output origin');
  const r = await fetchFn(url.href, {
    signal: boundedSignal,
    redirect: 'error',
    headers: url.origin === origin ? { Authorization: `${provider === 'replicate' ? 'Token' : 'Bearer'} ${key}` } : {}
  });
  if (!r.ok) throw new Error(`Video download returned HTTP ${r.status}`);
  const headers = new Headers(r.headers);
  headers.set('x-lloom-provider', provider);
  headers.set('x-lloom-provider-job-id', job.id);
  headers.set('x-lloom-upstream-model', body.model);
  return new Response(r.body, { status: r.status, headers });
}
