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
  const request = async (url, method = 'GET', payload) => {
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
    if (!r.ok) throw new Error(`Video provider returned HTTP ${r.status}`);
    return r.json();
  };
  let job;
  if (provider === 'replicate') {
    if (!/^[\w-]+\/[\w.-]+$/.test(body.model)) throw new Error('Invalid Replicate model');
    // Data URIs avoid local paths and cross-host file access. No client URL fetches.
    for (const name of ['image', 'audio']) {
      if (!String(body[name] || '').startsWith(`data:${name}/`)) throw new Error(`${name} data URI required`);
    }
    job = await request(`${base}/models/${body.model}/predictions`, 'POST', {
      input: { image: body.image, audio: body.audio, prompt: body.prompt, fast_mode: body.fast_mode === true }
    });
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
    if (['failed', 'canceled', 'cancelled', 'expired'].includes(job.status)) throw new Error(`Video job ${job.status}`);
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
    headers: url.origin === origin ? { Authorization: `Bearer ${key}` } : {}
  });
  if (!r.ok) throw new Error(`Video download returned HTTP ${r.status}`);
  return r;
}
