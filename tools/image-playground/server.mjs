import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const host = '127.0.0.1';
const port = Number(process.env.PORT ?? 8188);
const remoteHost = process.env.LLOOM_REMOTE_HOST?.trim();
const remoteEnvFile = process.env.LLOOM_REMOTE_ENV_FILE?.trim() || '$HOME/.config/lloom/env';
const enhancerModel =
  process.env.LLOOM_ENHANCER_MODEL?.trim() || 'unsloth/Qwen3.6-35B-A3B-NVFP4-Froggeric-vLLM025';
const page = await readFile(new URL('./index.html', import.meta.url));

function send(res, status, body, contentType = 'application/json') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function remoteRequest(path, { method = 'GET', payload } = {}) {
  return new Promise((resolve, reject) => {
    if (!remoteHost) {
      reject(new Error('Set LLOOM_REMOTE_HOST to the LLooM SSH host.'));
      return;
    }
    const remote = [
      'set -a;',
      `. "${remoteEnvFile}";`,
      'set +a;',
      'exec curl -sS --fail-with-body --max-time 7200',
      `-X ${method}`,
      '-H "Authorization: Bearer $LLOOM_API_KEY"',
      '-H "Content-Type: application/json"',
      payload === undefined ? '' : '--data-binary @-',
      `http://127.0.0.1:8100${path}`
    ]
      .filter(Boolean)
      .join(' ');
    const child = spawn('ssh', [remoteHost, remote], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      if (code === 0) resolve(output);
      else reject(new Error(Buffer.concat(stderr).toString('utf8') || output || `ssh exited ${code}`));
    });
    child.stdin.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}

async function generationRequest(path, payload) {
  try {
    return await remoteRequest(path, { method: 'POST', payload });
  } catch (error) {
    if (!String(error?.message ?? error).includes('429')) throw error;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return remoteRequest(path, { method: 'POST', payload });
  }
}

async function mediaModels() {
  const response = JSON.parse(await remoteRequest('/v1/models'));
  return (response.data ?? [])
    .filter((model) => ['image', 'video'].includes(model.metadata?.kind))
    .map((model) => ({
      id: model.id,
      name: model.metadata?.name || model.id,
      kind: model.metadata.kind,
      capabilities: model.metadata?.capabilities ?? [],
      tags: model.metadata?.tags ?? []
    }));
}

function enhancerInstructions(model) {
  const identity = `${model.id} ${model.name} ${model.capabilities.join(' ')} ${model.tags.join(' ')}`.toLowerCase();
  if (model.kind === 'video' || identity.includes('ltx')) {
    return `/no_think Rewrite the user's idea as one literal, flowing LTX-2 video prompt of at most 180 words. Start directly with the main visible action. Describe events chronologically, including precise subject appearance, gestures and movement, environment, camera angle and continuous camera movement, lighting and color changes, and synchronized audible ambience or sounds. Prefer one coherent shot, concrete cinematic language, and physically plausible motion. Do not use headings, bullets, negative prompts, meta-commentary, quotation marks, or parameters. Preserve the user's intent.`;
  }
  if (identity.includes('flux')) {
    return `/no_think Rewrite the user's idea as a polished FLUX.2 image prompt in natural language. Organize it as subject, action, style, then context. Be concrete about composition, spatial relationships, lighting, atmosphere, materials and colors. For photorealism include an appropriate camera and lens reference. Describe only what should appear; FLUX.2 does not use negative prompts, so convert exclusions into positive desired states. Return only the final prompt, with no headings, bullets, quotation marks, parameters, or commentary. Preserve the user's intent.`;
  }
  return `/no_think Rewrite the user's idea for CyberRealistic Pony, a photorealistic Pony XL image model. Return one comma-separated positive prompt. Begin with: score_9, score_8_up, score_7_up, source_photo. Then order tags and concise phrases as subject count and identity, explicitly provided appearance, action and pose, wardrobe or key objects, environment, composition and camera angle, lighting, lens or depth of field, and fine photographic detail. Never change, guess, or invent a subject's age, ethnicity, skin color, gender, identity, anatomy, or other personal attributes. Do not sexualize the request. Do not add a negative prompt, headings, BREAK, quotation marks, parameters, or commentary. Preserve every explicit detail and the user's intent.`;
}

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      send(res, 200, page, 'text/html; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && req.url === '/models') {
      send(res, 200, JSON.stringify({ data: await mediaModels() }));
      return;
    }
    if (req.method === 'POST' && req.url === '/enhance') {
      const input = JSON.parse(await readBody(req));
      const prompt = String(input.prompt ?? '').trim();
      if (!prompt) {
        send(res, 400, JSON.stringify({ error: 'Prompt is required.' }));
        return;
      }
      const model = (await mediaModels()).find((item) => item.id === input.model);
      if (!model) {
        send(res, 400, JSON.stringify({ error: 'Select an available image or video model.' }));
        return;
      }
      const output = JSON.parse(
        await remoteRequest('/v1/chat/completions', {
          method: 'POST',
          payload: {
            model: enhancerModel,
            messages: [
              { role: 'system', content: enhancerInstructions(model) },
              { role: 'user', content: prompt }
            ],
            temperature: 0.35,
            max_tokens: 800,
            chat_template_kwargs: { enable_thinking: false },
            stream: false
          }
        })
      );
      const enhanced = String(output.choices?.[0]?.message?.content ?? '').trim();
      if (!enhanced) throw new Error('The prompt enhancer returned no text.');
      send(res, 200, JSON.stringify({ prompt: enhanced, model: enhancerModel }));
      return;
    }
    if (req.method === 'POST' && req.url === '/generate') {
      const input = JSON.parse(await readBody(req));
      const prompt = String(input.prompt ?? '').trim();
      if (!prompt) {
        send(res, 400, JSON.stringify({ error: 'Prompt is required.' }));
        return;
      }
      const model = (await mediaModels()).find((item) => item.id === input.model);
      if (!model) {
        send(res, 400, JSON.stringify({ error: 'Select an available image or video model.' }));
        return;
      }
      if (model.kind === 'video') {
        const videoSizes = new Map([
          ['512x320', [512, 320]],
          ['640x384', [640, 384]],
          ['768x512', [768, 512]]
        ]);
        const [width, height] = videoSizes.get(input.size) ?? videoSizes.get('640x384');
        const allowedFrames = [49, 97, 193, 241];
        const numFrames = allowedFrames.includes(Number(input.num_frames)) ? Number(input.num_frames) : 97;
        const isDevQuality = model.capabilities.includes('two-stage');
        const output = await generationRequest('/v1/videos/generations', {
            model: model.id,
            prompt,
            width,
            height,
            num_frames: numFrames,
            frame_rate: 24,
            seed: Number.isInteger(Number(input.seed)) ? Number(input.seed) : 42,
            lora_strength: 0.7,
            quantization: 'fp8-cast',
            response_format: 'b64_json',
            ...(isDevQuality
              ? {
                  distilled_lora_strength: Math.min(0.35, Math.max(0.25, Number(input.distilled_lora_strength) || 0.3)),
                  num_inference_steps: Math.min(50, Math.max(20, Number(input.num_inference_steps) || 30)),
                  video_cfg_guidance_scale: Math.min(5, Math.max(1, Number(input.video_cfg_guidance_scale) || 3))
                }
              : {})
        });
        send(res, 200, output);
        return;
      }
      const imageSizes = ['512x512', '768x1024', '832x1216', '896x1152', '1024x768', '1024x1024'];
      const size = imageSizes.includes(input.size) ? input.size : '832x1216';
      const output = await generationRequest('/v1/images/generations', {
        model: model.id,
        prompt,
        size,
        n: 1,
        response_format: 'b64_json'
      });
      send(res, 200, output);
      return;
    }
    send(res, 404, JSON.stringify({ error: 'Not found.' }));
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error?.message ?? String(error) }));
  }
}).listen(port, host, () => {
  console.log(`LLooM media playground: http://${host}:${port}`);
});
