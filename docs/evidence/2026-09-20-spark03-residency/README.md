# Spark 3 resident essentials and shared Qwen image service

This rollout makes residency a normal LLooM configuration concern. Embeddings
and the speech pipeline are pinned; one Qwen Image 2.1 Diffusers process serves
both generation and editing. Image is preferred resident and may yield to
on-demand music or video when predictive memory admission requires it.

## Runtime policy

| Runtime | Model | Residency | Admission estimate |
| --- | --- | --- | --- |
| qwen3-embedding-4b | Qwen3-Embedding-4B | keepWarm | 12 GiB |
| spark03-tts-custom | Qwen3-TTS CustomVoice | keepWarm | 10 GiB |
| spark03-tts-clone | Qwen3-TTS Base | keepWarm | 10 GiB |
| spark03-tts-design | Qwen3-TTS VoiceDesign | keepWarm | 10 GiB |
| spark03-stt | Whisper large v3 turbo | keepWarm | 6 GiB |
| qwen-image-diffusers | Qwen-Image-2.1, official BF16 | preferredWarm | 70 GiB |
| spark03-music | ACE-Step 1.5 XL SFT | on demand | 35 GiB |
| spark03-ltx-video | LTX-2.5 | on demand | 70 GiB |

These are conservative admission estimates, not summed measured allocations.
The Spark has approximately 121.7 GiB of host memory. The existing 95% maximum
memory utilization and 120-second admission wait remain configured. Preferred
restoration runs inside LLooM every 30 seconds, after a 30-second idle grace.
It protects pins, active work, queued work, maintenance state and ownership.
It retains idle ordinary runtimes when the preferred model fits alongside them.

See [the runtime policy contract](../../runtime-policy.md) for the small JSON
configuration and observability fields. No external restoration watcher is used.

## Comfy caching and readiness

The old premium launcher used `--cache-none`. Comfy's ability to retain reusable
workflow nodes was therefore disabled. Dedicated music and video runtimes now
set `LLOOM_COMFY_CACHE_MODE=classic`. A new save prefix on every request prevents
cached output nodes from returning files removed by the bridge's cleanup.

The runtimes warm their own model before accepting user work. Live testing
found that a successful HTTP health check could previously admit a request
while warmup still occupied the backend. LLooM now keeps that runtime in the
startup state until warmup finishes. A process-only health endpoint is not
sufficient proof that model weights have been loaded.

The old premium runtime remains available for explicitly named legacy models;
image, music and video defaults no longer depend on that shared 95 GiB runtime.
Separate services allow LLooM to account for and evict each workload independently.

## Qwen performance and remaining quality boundary

One paired 1024-square, 25-step, seed-42 generation sample took 26.297 seconds
through Comfy with INT8 weights and 37.756 seconds through Diffusers with the
original BF16 weights. This compares complete serving configurations with
different precision; it does not isolate framework speed. A warmed 40-step
Diffusers edit took 60.803 seconds. Cold weight loads took roughly 160–196 seconds.
The shared process avoids that load when switching between generation and edit.

The original teapot and cottage reference canaries edit cleanly through
Diffusers. A newly generated teapot reference still develops severe texture
and contrast artifacts when edited. The following bounded controls did not
resolve it:

- Restarting the process and editing the new reference first produced the same
  bad output byte for byte.
- Editing the original reference afterward still produced the clean result.
- Removing the alpha channel from the new reference produced the same bad result.
- Generating the reference with 40 steps instead of 25 still produced a bad edit.

This is a remaining quality limitation of the tested path on some inputs. It is
not evidence of stale state caused by sharing generation and editing weights,
and it does not establish the exact model or implementation cause. The known
working Edit-2511 model remains configured for explicit fallback calls.
Generation retains 25 steps; the extra generation steps did not resolve this issue.

## Source and validation

The managed gateway release is `67045de2fee8e4ae02b263cffbac1a03fe6cf275`, artifact
SHA-256 `033ee10a3b0eff3c1234882ce795cdcb2bcf5c9e68fda2d62125f111fd33c20c`.
Deployment preserved existing routes before applying the narrow residency and
media-default changes.

- Qwen backend image: `lloom/qwen-image-diffusers:source-709d9a713b1a7340fd1cba799e45fc51690ef9a040c11e6c4457ac603c4a2d6d`.
- Comfy music/video image: `lloom/comfyui-media:source-b812f8cb1852f0360dd98b439f2e2ffc3039ae7d3d98482c07508a40319d9f34`.
- Qwen checkpoint: `b3179ad355be050328e483a9dfdd9e60cd62adfa`.
- Diffusers: `80c7ed262aeffbeb43ef13ae04baeb9b84515a69`.
- ComfyUI: `5ba116a40f1944f64e2e4a8ace826656e6293bf4`.

Validation covered residency/health/ownership/admission and shutdown races,
full unit/cluster/entity-stagger tests, smoke and community checks, syntax,
lint, interchange and package installation. A stale smoke recipe count was
updated to the actual 35 bundled recipes. The Comfy bridge's 90 CPU tests pass;
the Qwen backend's 69 CPU tests passed during the shared-pipeline change.
The rebuilt Comfy image verifies the dynamic reference-input contract without
initializing CUDA. Independent Codex review findings were repaired and covered
by focused tests before deployment.

## Live transition results

The video request evicted Qwen at 19:27:28 UTC and completed in 122.377 seconds,
including startup and warmup. At 19:30:20, LLooM stopped the now-idle video
runtime and restored Qwen with reason `preferred-warm-reconcile`. Qwen was
healthy by 19:33:25: approximately 237 seconds after the video request finished,
including the idle grace, periodic reconciliation and cold weight load.

Spark 3's default generation request then returned in 38.639 seconds. The
separate cache checks returned music in 28.822 seconds and video in 111.439
seconds including startup/warmup. Identical repeats returned in 1.055 and
1.051 seconds respectively. Those repeats reuse completed graph computation;
they are artifact-cache correctness checks, not fresh inference benchmarks.

The first residency observer used an incorrect health-field assertion and was
stopped before its canary phase. The observer was corrected to accept the
backend's actual `{ "status": "ok" }` response. Before continuation, the parent
independently verified that the observer and its shell were gone, the managed
model was ready, and no inference request remained active, then ran the
supervisor's verified-cleanup release. This was a verification-script error.

Live receipts and final transition evidence are recorded alongside this report.
Generated PNG, WAV and MP4 payloads stay in private artifact storage.

Owner default editing returned in 62.138 seconds. Fleet default generation
(`image-quality`) returned in 33.883 seconds and `image-edit` in 59.566 seconds.
Both fleet calls resolved to `ennspark03/Qwen/Qwen-Image-2.1-Diffusers`, returned
HTTP 200 without failover, and matched the corresponding owner PNG byte for
byte. All five pinned container PIDs and start times were unchanged across the
transition. Embeddings returned 2560 dimensions, and all three TTS outputs
transcribed to “The resident speech pipeline is ready.”

Evidence: [live residency](live-residency.json),
[restoration transitions](restoration-transitions.json),
[canaries and attribution](canaries.json), [fleet defaults](fleet-defaults.json),
[quality controls](image-quality-controls.json), and
[artifact hashes](artifact-hashes.json).
