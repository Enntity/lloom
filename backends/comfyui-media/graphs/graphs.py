"""Fixed native ComfyUI graphs, derived from pinned official workflow templates."""
import json
import math
import re
import secrets

MODELS = {
    "black-forest-labs/FLUX.2-klein-4B": {"kind": "image", "family": "flux2"},
    "Qwen/Qwen-Image-2512": {"kind": "image", "family": "qwen-image"},
    "Qwen/Qwen-Image-2512-Lightning": {"kind": "image", "family": "qwen-image-lightning"},
    "Qwen/Qwen-Image-Edit-2511": {"kind": "image", "family": "qwen-image-edit"},
    "Qwen/Qwen-Image-2.1": {"kind": "image", "family": "qwen-image-21"},
    "BennyDaBall/Qwen-Image-2.1-NVFP4": {"kind": "image", "family": "qwen-image-21"},
    "Comfy-Org/Ideogram-4": {"kind": "image", "family": "ideogram4"},
    "Comfy-Org/Krea-2-Turbo": {"kind": "image", "family": "krea2"},
    "MiniMaxAI/MiniMax-H3": {"kind": "video"},
    "MiniMaxAI/MiniMax-H3-Turbo": {"kind": "video"},
    "Lightricks/LTX-2.5": {"kind": "video"},
    "Lightricks/LTX-2.5-Comfy-Full": {"kind": "video"},
    "MiniMaxAI/MiniMax-Music3": {"kind": "audio"},
    "ACE-Step/ACE-Step-1.5-XL-SFT": {"kind": "audio"},
    "ACE-Step/ACE-Step-1.5-XL-Turbo": {"kind": "audio"},
    "Comfy-Org/YuE2-3B": {"kind": "audio", "family": "yue2"},
}


# LLooM presets: upstream recommends 40 steps; 25 and 12 are lower-cost options.
# Explicit steps override the preset. Live quality varies by prompt and reference.
QWEN_IMAGE_21_QUALITY_STEPS = {"auto": 40, "high": 40, "medium": 25, "low": 12}

# Server-owned checkpoint names for the qwen-image-21 lane. Both IDs share one
# graph contract, but each loads a fixed, pinned set of files. A request can
# never name a checkpoint: the model ID selects one of these entries and the
# filenames below are the only values that reach the loaders.
QWEN_IMAGE_21_CHECKPOINTS = {
    "Qwen/Qwen-Image-2.1": {
        "diffusion": "qwen_image_2.1_int8_convrot.safetensors",
        "encoder": "qwen3vl_8b_int8_convrot.safetensors",
        "vae": "qwen_image_2.1_vae_bf16.safetensors",
    },
    "BennyDaBall/Qwen-Image-2.1-NVFP4": {
        "diffusion": "qwen_image_2.1_nvfp4.safetensors",
        "encoder": "qwen3vl_8b_nvfp4.safetensors",
        "vae": "qwen_image_2.1_vae_bf16.safetensors",
    },
}

# Model lanes whose bridge contract includes a reference-image edit. Both have a
# text-encode node that splices a LoadImage latent, so the endpoint may serve
# them while every other image lane stays generation-only.
IMAGE_EDIT_FAMILIES = frozenset({"qwen-image-21", "qwen-image-edit"})


def supports_image_edit(model_id: str) -> bool:
    """True when the family's pinned graph consumes a reference image."""
    metadata = MODELS.get(model_id)
    return isinstance(metadata, dict) and metadata.get("kind") == "image" and metadata.get("family") in IMAGE_EDIT_FAMILIES


def qwen_image_21_steps(p):
    """Resolve the 2.1 step count from ``quality`` unless steps are explicit.

    An explicitly supplied, valid ``steps`` always wins over ``quality``. An
    invalid ``quality`` is rejected outright: silently dropping it would render
    at the default and hide the typo that mattered.
    """
    if "quality" in p:
        quality = p["quality"]
        if not isinstance(quality, str) or quality not in QWEN_IMAGE_21_QUALITY_STEPS:
            allowed = ", ".join(sorted(QWEN_IMAGE_21_QUALITY_STEPS))
            raise ValueError(f"quality must be one of {allowed}")
    if "steps" in p:
        return number(p, "steps", QWEN_IMAGE_21_QUALITY_STEPS["auto"], 1, 60, True)
    return QWEN_IMAGE_21_QUALITY_STEPS[p["quality"]] if "quality" in p else QWEN_IMAGE_21_QUALITY_STEPS["auto"]


def number(p, name, default, low, high, integer=False, describe=None):
    """Read a bounded numeric field.

    ``describe`` names the subject of the range in the error, because a rejection
    has to say what was wrong and what is allowed. A bare "outside the supported
    range" is indistinguishable from a model that cannot do the thing at all.
    """
    v = p.get(name, default)
    # Only qualify the field when the subject adds information; "width for width"
    # is noise.
    subject = describe if describe and describe != name else None
    qualifier = f" for {subject}" if subject else ""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ValueError(f"{name}{qualifier} must be a finite number")
    if integer and int(v) != v:
        raise ValueError(f"{name}{qualifier} must be a whole number")
    if not low <= v <= high:
        if low == high:
            raise ValueError(f"{name}{qualifier} must be exactly {low}")
        raise ValueError(f"{name}{qualifier} must be between {low} and {high}")
    return int(v) if integer else float(v)


def text(p, name, default="", limit=8000):
    v = p.get(name, default)
    if not isinstance(v, str) or len(v) > limit:
        raise ValueError(f"{name} must be bounded text")
    return v


class Graph:
    def __init__(self):
        self.nodes = {}

    def add(self, cls, **inputs):
        key = str(len(self.nodes) + 1)
        self.nodes[key] = {"class_type": cls, "inputs": inputs}
        return [key, 0]

    def sample(self, model, positive, negative, latent, seed, steps, cfg):
        return self.add("KSampler", model=model, positive=positive, negative=negative,
                        latent_image=latent, seed=seed, steps=steps, cfg=cfg,
                        sampler_name="euler", scheduler="simple", denoise=1.0)

    def advanced(self, model, positive, negative, latent, seed, sigmas,
                 video_cfg=1.0, audio_cfg=1.0, schedule=None):
        guider = self.add("LTXVDualCFGGuider", model=model, positive=positive,
                          negative=negative, video_cfg=video_cfg, audio_cfg=audio_cfg)
        noise = self.add("RandomNoise", noise_seed=seed)
        sampler = self.add("KSamplerSelect", sampler_name="euler_ancestral")
        schedule = schedule if schedule is not None else self.add("ManualSigmas", sigmas=sigmas)
        return self.add("SamplerCustomAdvanced", noise=noise, guider=guider,
                        sampler=sampler, sigmas=schedule, latent_image=latent)


def geometry(p, ltx=False):
    w, h = 832, 480
    if p.get("size") is not None:
        m = re.fullmatch(r"(\d{3,4})x(\d{3,4})", str(p["size"]))
        if not m:
            raise ValueError("size must be WIDTHxHEIGHT")
        w, h = map(int, m.groups())
    # LTX's first pass runs at half resolution; its upscaler restores the
    # requested geometry. Both passes require a compatible spatial grid.
    floor = 128 if ltx else 256
    w = number(p, "width", w, floor, 1344, True)
    h = number(p, "height", h, floor, 1344, True)
    multiple = 64 if ltx else 32
    if ltx and "height" not in p and "size" not in p:
        h = 512
    if w % multiple or h % multiple:
        raise ValueError(f"Dimensions must be a multiple of {multiple} for this model")
    if w * h > 1344 * 768:
        raise ValueError("Dimensions must stay within 1344x768 pixels")
    if number(p, "fps", 24, 24, 24) != 24:
        raise ValueError("Only 24 fps is supported")
    return w, h


def frame_count(p, default, low, high, block, offset):
    value = p.get("num_frames", p.get("frames", default))
    n = number({"num_frames": value}, "num_frames", default, low, high, True)
    if (n - offset) % block:
        raise ValueError("Frame count does not match this model's temporal grid")
    if "frames" in p and "num_frames" in p and p["frames"] != n:
        raise ValueError("Conflicting frame counts")
    if "duration" in p and n != default:
        raise ValueError("duration and frame count disagree")
    return n


def normalize_video_payload(model_id, payload):
    p = dict(payload)
    common = {"model", "prompt", "image", "first_frame", "last_frame", "audio", "video", "width", "height", "size", "duration", "num_frames", "frames", "fps", "frame_rate", "seed", "steps", "n", "response_format"}
    if model_id.startswith("MiniMaxAI/MiniMax-H3"):
        allowed = common | {"transcript", "workflow", "ref_image_size", "video_audio"}
        if p.get("workflow", "auto") not in ("auto", "frames", "reference"):
            raise ValueError("workflow must be auto, frames or reference")
        if p.get("workflow") == "frames" and (p.get("audio") or p.get("video")):
            raise ValueError("audio/video references require the reference workflow")
        if "video_audio" in p and (not isinstance(p["video_audio"], bool) or not p.get("video")):
            raise ValueError("video_audio requires a video and a boolean")
        if p.get("ref_image_size") is not None and not (p.get("audio") or p.get("video") or p.get("workflow") == "reference"):
            raise ValueError("ref_image_size applies only to the reference workflow")
        prompt = p.get("prompt")
        if isinstance(prompt, dict):
            prompt = json.dumps(prompt, ensure_ascii=False, separators=(",", ":"))
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("prompt must be non-empty text or a structured object")
        if "transcript" in p:
            transcript = p["transcript"]
            if not isinstance(transcript, str) or not transcript.strip() or len(transcript) > 4000:
                raise ValueError("transcript must be non-empty text of at most 4000 characters")
            audio_index = 2 if p.get("video") and p.get("video_audio") else 1
            voice = f" Use <Audio {audio_index}> as the voice reference." if p.get("audio") else ""
            prompt += "\nSpoken dialogue, exactly: " + json.dumps(transcript, ensure_ascii=False) + voice
            p.pop("transcript")
        p["prompt"] = prompt
    elif model_id in ("Lightricks/LTX-2.5", "Lightricks/LTX-2.5-Comfy-Full"):
        allowed = common | {"negative_prompt", "image_strength", "voice_reference", "voice_identity", "voice_start", "voice_end"}
        if model_id.endswith("Comfy-Full"):
            allowed.add("guidance_scale")
    else:
        return p
    unknown = set(p) - allowed
    if unknown:
        raise ValueError("Unsupported video fields: " + ", ".join(sorted(unknown)))
    if "size" in p and ("width" in p or "height" in p):
        raise ValueError("Use size or width/height, not both")
    if "frame_rate" in p:
        if "fps" in p:
            raise ValueError("Use fps or frame_rate, not both")
        p["fps"] = p.pop("frame_rate")
    if "first_frame" in p:
        if "image" in p:
            raise ValueError("Use image or first_frame, not both")
        p["image"] = p.pop("first_frame")
    return p


def build_graph(model_id, payload, image_filename=None, last_image_filename=None,
                audio_filename=None, video_filename=None, prefix="lloom"):
    if model_id not in MODELS or not isinstance(payload, dict):
        raise ValueError("Unsupported model or request")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", prefix):
        raise ValueError("Invalid output prefix")
    for name, filename in (("first frame", image_filename), ("last frame", last_image_filename)):
        if filename is not None and not re.fullmatch(r"[A-Za-z0-9_-]{1,80}\.(png|jpg)", filename):
            raise ValueError(f"Invalid generated {name} name")
    if audio_filename is not None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}\.(wav|flac|mp3)", audio_filename):
            raise ValueError("Invalid generated audio name")
        if not model_id.startswith("Lightricks/") and model_id != "MiniMaxAI/MiniMax-H3":
            # H3's conditioning node takes frames only. Only the LTX graph carries
            # an audio latent that a real clip can replace and a reference-audio
            # conditioner to hold its timbre.
            raise ValueError(f"Audio conditioning is not supported by {model_id}")
    if video_filename is not None:
        if model_id != "MiniMaxAI/MiniMax-H3":
            raise ValueError(f"{model_id} does not support reference video")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}\.mp4", video_filename):
            raise ValueError("Invalid generated video name")
    for forbidden in ("graph", "checkpoint", "model_path", "output_path", "image_url"):
        # H3 exposes a bounded named workflow, never an arbitrary graph.
        if forbidden in payload:
            raise ValueError("Arbitrary graphs, paths and URLs are not supported")
    if "workflow" in payload and model_id != "MiniMaxAI/MiniMax-H3":
        raise ValueError("workflow selection is supported only for MiniMax-H3")
    # The 2.1 lane derives a fresh cryptographic seed when none is supplied.
    # Reusing one seed across a generate-then-edit pair is the confirmed cause of
    # severe artifacts (native repro + upstream issue 14824); every other lane
    # keeps the fixed default it has always built with.
    if "seed" not in payload and MODELS[model_id].get("family") == "qwen-image-21":
        seed = secrets.randbits(53)
    else:
        seed = number(payload, "seed", 42, 0, (2**53 if MODELS[model_id].get("family") == "qwen-image-21" else 2**63) - 1, True)
    if number(payload, "n", 1, 1, 1, True) != 1:
        raise ValueError("Only one output per request is supported")
    g = Graph()
    if MODELS[model_id]["kind"] == "image":
        prompt = text(payload, "prompt")
        if not prompt.strip():
            raise ValueError("prompt is required")
        family = MODELS[model_id]["family"]
        if family == "qwen-image-21":
            result = qwen_image_21(g, payload, prompt, seed, image_filename, model_id)
        elif family == "qwen-image-edit":
            if image_filename is None:
                raise ValueError("Qwen image editing requires an image")
            result = qwen_image_edit(g, payload, prompt, seed, image_filename)
        elif family.startswith("qwen-image"):
            if image_filename is not None:
                raise ValueError("Qwen image generation does not accept a reference image")
            result = qwen_image(g, payload, prompt, seed, lightning=family.endswith("lightning"))
        elif family in ("krea2", "ideogram4"):
            if image_filename is not None or payload.get("image") is not None:
                # Like every other text-to-image family here, these have no
                # image input; a reference image would be silently dropped.
                raise ValueError(f"{model_id} does not accept a reference image")
            if family == "krea2":
                result = krea2(g, payload, prompt, seed)
            else:
                result = ideogram4(g, payload, prompt, seed)
        else:
            result = flux2_klein(g, payload, prompt, seed, image_filename)
        output = g.add("SaveImage", images=result, filename_prefix=prefix)
        return g.nodes, output[0], "image"
    if MODELS[model_id]["kind"] == "video":
        payload = normalize_video_payload(model_id, payload)
        prompt = text(payload, "prompt")
        if not prompt.strip():
            raise ValueError("prompt is required")
        if model_id.startswith("MiniMaxAI/MiniMax-H3"):
            result = h3(g, payload, prompt, seed, image_filename,
                        last_image_filename, model_id.endswith("Turbo"), audio_filename, video_filename)
        else:
            result = ltx(g, payload, prompt, seed, image_filename, last_image_filename,
                        audio_filename, full=model_id.endswith("Comfy-Full"))
        output = g.add("SaveVideo", video=result, filename_prefix=prefix, format="mp4", codec="h264")
        return g.nodes, output[0], "video"
    if image_filename is not None or last_image_filename is not None or payload.get("image") is not None:
        raise ValueError("Music models do not accept images")
    caption = text(payload, "instructions", text(payload, "prompt", "Instrumental music"))
    lyrics = text(payload, "lyrics", text(payload, "input", "[Instrumental]", 20000), 20000)
    if payload.get("duration") is not None and payload.get("max_duration") is not None:
        if payload["duration"] != payload["max_duration"]:
            # Two names for one value: accept them only when they agree, so a
            # request cannot half-apply in a way the caller cannot predict. The
            # value itself is range-checked by whichever model consumes it.
            raise ValueError("duration and max_duration must agree when both are set")
    family = MODELS[model_id].get("family")
    if family == "yue2":
        # YuE2 writes full songs, so it runs much longer than the clip-length
        # music models; ``max_duration`` is its native field name for the same
        # value, indexed from the widget name on the template's music node.
        requested = payload.get("duration", payload.get("max_duration", 120))
        duration = number({"duration": requested}, "duration", 120, 15, 360, True,
                          describe="Comfy-Org/YuE2-3B")
        result = yue2(g, payload, caption, lyrics, duration, seed)
    elif model_id == "MiniMaxAI/MiniMax-Music3":
        duration = number(payload, "duration", 30, 10, 300)
        result = music3(g, payload, caption, lyrics, duration, seed)
    else:
        duration = number(payload, "duration", 30, 10, 300)
        result = ace(g, payload, caption, lyrics, duration, seed, model_id.endswith("Turbo"))
    # Native SaveAudio writes lossless FLAC. The bridge returns a bounded PCM WAV.
    output = g.add("SaveAudio", audio=result, filename_prefix=prefix)
    return g.nodes, output[0], "audio"


def h3(g, p, prompt, seed, image_filename, last_image_filename, turbo, audio_filename=None, video_filename=None):
    label = "MiniMax-H3-Turbo" if turbo else "MiniMax-H3"
    width, height = geometry(p)
    duration = number(p, "duration", 5, 5, 15, describe=label)
    length = frame_count(p, math.ceil((duration * 24 - 5) / 17) * 17 + 5, 124, 362, 17, 5)
    steps = number(p, "steps", 8 if turbo else 20, 8 if turbo else 10, 8 if turbo else 50,
                   True, describe=label)
    if audio_filename is not None or video_filename is not None or p.get("workflow") == "reference":
        if turbo:
            raise ValueError("MiniMax-H3-Turbo does not accept reference audio")
        if not any((image_filename, audio_filename, video_filename)):
            raise ValueError("H3 reference workflow requires image, audio or video")
        return h3_ref2va(g, p, prompt, seed, image_filename, audio_filename,
                         last_image_filename,
                         width, height, length, steps, video_filename)
    model = g.add("UNETLoader", unet_name="minimax_h3_fl2va_pruned_int8_convrot.safetensors", weight_dtype="default")
    if turbo:
        model = g.add("LoraLoaderModelOnly", model=model, lora_name="minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors", strength_model=1.0)
    clip = g.add("CLIPLoader", clip_name="qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", type="minimax", device="default")
    vae = g.add("VAELoader", vae_name="minimax_h3_video_vae_fp16.safetensors")
    audio_vae = g.add("VAELoader", vae_name="minimax_h3_audio_vae_fp32.safetensors")
    kwargs = dict(clip=clip, vae=vae, prompt=prompt, width=width, height=height, length=length)
    if image_filename:
        kwargs["first_frame"] = g.add("LoadImage", image=image_filename)
    if last_image_filename:
        # Pinning the end frame is what makes a shot-to-shot join exact: the
        # clip lands on the frame the next clip starts from.
        kwargs["last_frame"] = g.add("LoadImage", image=last_image_filename)
    condition = g.add("MiniMaxH3ImageToVideo", **kwargs)
    latent = [condition[0], 1]
    guider = g.add("BasicGuider", model=model, conditioning=condition)
    noise = g.add("RandomNoise", noise_seed=seed)
    sampler = g.add("KSamplerSelect", sampler_name="res_multistep")
    sigmas = g.add("BasicScheduler", model=model, scheduler="simple", steps=steps, denoise=1.0)
    sample = g.add("SamplerCustomAdvanced", noise=noise, guider=guider, sampler=sampler, sigmas=sigmas, latent_image=latent)
    images = g.add("VAEDecode", samples=sample, vae=vae)
    audio = g.add("VAEDecodeAudio", samples=sample, vae=audio_vae)
    return g.add("CreateVideo", images=images, audio=audio, fps=24.0)


def h3_ref2va(g, p, prompt, seed, image_filename, audio_filename, last_image_filename,
              width, height, length, steps, video_filename=None):
    """Generate H3 video from a portrait and voice reference (Ref2VA)."""
    model = g.add("UNETLoader", unet_name="minimax_h3_ref2va_pruned_int8_convrot.safetensors",
                  weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name="qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
                 type="minimax", device="default")
    vae = g.add("VAELoader", vae_name="minimax_h3_video_vae_fp16.safetensors")
    audio_vae = g.add("VAELoader", vae_name="minimax_h3_audio_vae_fp32.safetensors")
    refs = {}
    if image_filename:
        refs["ref_images.ref_image_1"] = g.add("LoadImage", image=image_filename)
    if audio_filename:
        refs["ref_audios.ref_audio_1"] = g.add("LoadAudio", audio=audio_filename)
    if video_filename:
        loaded = g.add("LoadVideo", file=video_filename)
        components = g.add("GetVideoComponents", video=loaded)
        refs["ref_videos.ref_video_1"] = components
        # A standalone audio reference is explicit; source-video sound is only
        # included when requested and verified present during preflight.
        if p.get("video_audio", False):
            refs["ref_video_audios.ref_video_audio_1"] = [components[0], 1]
    ref_size = p.get("ref_image_size", "match")
    if ref_size not in ("match", "max"):
        raise ValueError("ref_image_size must be match or max")
    condition = g.add(
        "MiniMaxH3ReferenceToVideo", clip=clip, vae=vae, audio_vae=audio_vae,
        prompt=prompt, width=width, height=height, length=length,
        ref_image_size=ref_size, **refs,
    )
    positive = condition
    if last_image_filename:
        # Ref2VA has no last_frame input. The native guide node adds a pinned
        # endpoint to the same conditioning while retaining image/audio refs.
        endpoint = g.add("LoadImage", image=last_image_filename)
        positive = g.add("MiniMaxH3AddGuide", positive=condition,
                         latent=[condition[0], 1], vae=vae,
                         image=endpoint, frame_idx=-1)
    guider = g.add("BasicGuider", model=model, conditioning=positive)
    noise = g.add("RandomNoise", noise_seed=seed)
    sampler = g.add("KSamplerSelect", sampler_name="res_multistep")
    sigmas = g.add("BasicScheduler", model=model, scheduler="simple", steps=steps, denoise=1.0)
    sample = g.add("SamplerCustomAdvanced", noise=noise, guider=guider,
                   sampler=sampler, sigmas=sigmas, latent_image=[condition[0], 1])
    images = g.add("VAEDecode", samples=sample, vae=vae)
    audio_out = g.add("VAEDecodeAudio", samples=sample, vae=audio_vae)
    return g.add("CreateVideo", images=images, audio=audio_out, fps=24.0)


def ltx(g, p, prompt, seed, image_filename, last_image_filename=None, audio_filename=None, full=False):
    if "image_strength" in p and image_filename is None:
        raise ValueError("image_strength requires image or first_frame")
    voice_controls = {"voice_reference", "voice_identity", "voice_start", "voice_end"} & set(p)
    if voice_controls and audio_filename is None:
        raise ValueError("voice controls require audio")
    if p.get("voice_reference") == 0 and voice_controls - {"voice_reference"}:
        raise ValueError("voice guidance controls require voice_reference=1")
    if number(p, "voice_start", 0, 0, 1) > number(p, "voice_end", 1, 0, 1):
        raise ValueError("voice_start must not exceed voice_end")
    # The first pass uses half the requested dimensions; the latent spatial
    # upscaler restores the requested output geometry for the second pass.
    width, height = geometry(p, ltx=True)
    duration = number(p, "duration", 5, 1, 10, describe="Lightricks/LTX-2.5")
    steps = number(p, "steps", 30 if full else 8, 10 if full else 8, 60 if full else 8, True, describe="Lightricks/LTX-2.5")
    cfg = number(p, "guidance_scale", 3.0, 1.0, 20.0) if full else 1.0
    # How hard the first frame is held. Higher keeps the opening closer to the
    # conditioning image; lower lets the shot move further from it.
    strength = number(p, "image_strength", 0.7, 0.0, 1.0, describe="Lightricks/LTX-2.5")
    length = frame_count(p, math.ceil(duration * 24 / 8) * 8 + 1, 25, 241, 8, 1)
    model = g.add("UNETLoader", unet_name=("ltx-2.5-22b-dev-transformer-bf16.safetensors" if full else
                  "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"), weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name="gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", type="ltxv", device="default")
    vae = g.add("VAELoader", vae_name="ltx-2.5-video-vae-bf16.safetensors")
    audio_vae = g.add("VAELoader", vae_name="ltx-2.5-audio-vae-bf16.safetensors")
    pos = g.add("CLIPTextEncode", clip=clip, text=prompt)
    neg = g.add("CLIPTextEncode", clip=clip, text=text(p, "negative_prompt", "pc game, console game, video game, cartoon, childish, ugly"))
    cond = g.add("LTXVConditioning", positive=pos, negative=neg, frame_rate=24.0)
    pos, neg = cond, [cond[0], 1]
    latent = g.add("EmptyLTXVLatentVideo", width=width//2, height=height//2, length=length, batch_size=1)
    image = None
    if image_filename:
        image = g.add("LoadImage", image=image_filename)
        image = g.add("LTXVPreprocess", image=image, img_compression=18)
        latent = g.add("LTXVImgToVideoInplace", vae=vae, image=image, latent=latent, strength=strength, bypass=False)
    endpoint = g.add("LoadImage", image=last_image_filename) if last_image_filename else None
    if endpoint is not None:
        # Guides require a video-only latent. Pin the endpoint before AV concat
        # in both stages so the spatial upscaler does not soften the last frame.
        guide = g.add("LTXVAddGuide", positive=pos, negative=neg, vae=vae,
                      latent=latent, image=endpoint, frame_idx=-1, strength=1.0)
        pos, neg, latent = guide, [guide[0], 1], [guide[0], 2]
    # Audio. Keep a supplied clip fixed in the joint latent; visual synchronization
    # remains model-dependent. Optional reference conditioning can reinforce
    # timbre. Without a clip, the model generates both streams as before.
    if audio_filename:
        loaded = g.add("LoadAudio", audio=audio_filename)
        audio = g.add("LTXVAudioVAEEncode", audio=loaded, audio_vae=audio_vae)
        # Condition video on supplied speech without asking the sampler to
        # rewrite its words. The output also uses this original waveform.
        quiet_mask = g.add("SolidMask", value=0.0, width=1, height=1)
        audio = g.add("SetLatentNoiseMask", samples=audio, mask=quiet_mask)
        if number(p, "voice_reference", 1, 0, 1, True):
            # identity_guidance_scale sets how hard the reference timbre is held;
            # start/end_percent bound the window it applies over.
            guided = g.add(
                "LTXVReferenceAudio",
                model=model, positive=pos, negative=neg,
                reference_audio=loaded, audio_vae=audio_vae,
                identity_guidance_scale=number(p, "voice_identity", 3.0, 0.0, 20.0),
                start_percent=number(p, "voice_start", 0.0, 0.0, 1.0),
                end_percent=number(p, "voice_end", 1.0, 0.0, 1.0),
            )
            model = [guided[0], 0]
            pos = [guided[0], 1]
            neg = [guided[0], 2]
    else:
        audio = g.add("LTXVEmptyLatentAudio", frames_number=length, frame_rate=24.0, batch_size=1, audio_vae=audio_vae)
    av = g.add("LTXVConcatAVLatent", video_latent=latent, audio_latent=audio)
    if full:
        # The full checkpoint needs a guided schedule, not distilled's eight steps.
        # Compute token-dependent shifting from the video latent before AV concat.
        schedule = g.add("LTXVScheduler", steps=steps, max_shift=2.05,
                         base_shift=0.95, stretch=True, terminal=0.1, latent=latent)
        sampled = g.advanced(model, pos, neg, av, seed, None, video_cfg=cfg,
                             audio_cfg=1.0 if audio_filename else 7.0, schedule=schedule)
    else:
        sampled = g.advanced(model, pos, neg, av, seed, "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0")
    separate = g.add("LTXVSeparateAVLatent", av_latent=sampled)
    video_latent = separate
    if endpoint is not None:
        # Native guides append reference tokens beyond the requested frames.
        # Crop them before upscaling, then reapply the endpoint at full size.
        cropped = g.add("LTXVCropGuides", positive=pos, negative=neg, latent=video_latent)
        pos, neg, video_latent = cropped, [cropped[0], 1], [cropped[0], 2]
    upscaler = g.add("LatentUpscaleModelLoader", model_name="ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors")
    upscaled = g.add("LTXVLatentUpsampler", samples=video_latent, upscale_model=upscaler, vae=vae)
    if image is not None:
        upscaled = g.add("LTXVImgToVideoInplace", vae=vae, image=image, latent=upscaled, strength=1.0, bypass=False)
    if endpoint is not None:
        guide = g.add("LTXVAddGuide", positive=pos, negative=neg, vae=vae,
                      latent=upscaled, image=endpoint, frame_idx=-1, strength=1.0)
        pos, neg, upscaled = guide, [guide[0], 1], [guide[0], 2]
    av = g.add("LTXVConcatAVLatent", video_latent=upscaled, audio_latent=[separate[0], 1])
    if full:
        # Match native full's distilled refinement adapter, only on stage two.
        model = g.add("LoraLoaderModelOnly", model=model,
                      lora_name="ltx-2.5-22b-distilled-lora-450-bf16.safetensors", strength_model=1.0)
    sampled = g.advanced(model, pos, neg, av, seed+1, "0.85, 0.7250, 0.4219, 0.0")
    separate = g.add("LTXVSeparateAVLatent", av_latent=sampled)
    video_latent = separate
    if endpoint is not None:
        video_latent = g.add("LTXVCropGuides", positive=pos, negative=neg, latent=video_latent)
        video_latent = [video_latent[0], 2]
    frames = g.add("VAEDecodeTiled", samples=video_latent, vae=vae, tile_size=512, overlap=64, temporal_size=64, temporal_overlap=16)
    output_audio = loaded if audio_filename else g.add(
        "LTXVAudioVAEDecode", samples=[separate[0], 1], audio_vae=audio_vae)
    return g.add("CreateVideo", images=frames, audio=output_audio, fps=24.0)


def music3(g, p, caption, lyrics, duration, seed):
    model = g.add("UNETLoader", unet_name="minimax_music3_dit_fp16.safetensors", weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name="minimax_music3_text_encoder_pruned_int8_convrot.safetensors", type="minimax", device="default")
    vae = g.add("VAELoader", vae_name="minimax_music3_dav.safetensors")
    cond = g.add("MiniMaxMusic3TextEncode", clip=clip, caption=caption, lyrics=lyrics, seed=seed, max_duration=duration, cfg_scale=1.7, top_k=50)
    neg = g.add("ConditioningZeroOut", conditioning=cond)
    latent = g.add("EmptyMiniMaxMusic3LatentAudio", seconds=[cond[0], 1], batch_size=1)
    sample = g.sample(model, cond, neg, latent, seed, number(p, "steps", 30, 20, 50, True), 1.7)
    return g.add("VAEDecodeAudioTiled", samples=sample, vae=vae, tile_size=1536, overlap=64)


def ace(g, p, caption, lyrics, duration, seed, turbo):
    variant = "turbo" if turbo else "sft"
    model = g.add("UNETLoader", unet_name=f"acestep_v1.5_xl_{variant}_bf16.safetensors", weight_dtype="default")
    model = g.add("ModelSamplingAuraFlow", model=model, shift=3.0)
    clip = g.add("DualCLIPLoader", clip_name1="qwen_0.6b_ace15.safetensors", clip_name2="qwen_4b_ace15.safetensors", type="ace", device="default")
    vae = g.add("VAELoader", vae_name="ace_1.5_vae.safetensors")
    language = text(p, "language", "en", 16)
    if language not in "ar az bg bn ca cs da de el en es fa fi fr he hi hr ht hu id is it ja ko la lt ms ne nl no pa pl pt ro ru sa sk sr sv sw ta te th tl tr uk ur vi yue zh unknown".split():
        raise ValueError("Unsupported music language")
    cond = g.add("TextEncodeAceStepAudio1.5", clip=clip, tags=caption, lyrics=lyrics, seed=seed,
                 bpm=number(p, "bpm", 100, 10, 300, True), duration=duration, timesignature="4",
                 language=language, keyscale="C major", generate_audio_codes=True, cfg_scale=2.0,
                 temperature=0.85, top_p=0.9 if turbo else 1.0, top_k=0, min_p=0.0)
    neg = g.add("ConditioningZeroOut", conditioning=cond)
    latent = g.add("EmptyAceStep1.5LatentAudio", seconds=duration, batch_size=1)
    steps = number(p, "steps", 8 if turbo else 50, 8 if turbo else 20, 8 if turbo else 100, True)
    sample = g.sample(model, cond, neg, latent, seed, steps, 1.0 if turbo else 7.0)
    return g.add("VAEDecodeAudio", samples=sample, vae=vae)


def image_geometry(p):
    width, height = 1024, 1024
    if p.get("size") is not None:
        match = re.fullmatch(r"(\d{3,4})x(\d{3,4})", str(p["size"]))
        if not match:
            raise ValueError("size must be WIDTHxHEIGHT")
        width, height = map(int, match.groups())
    width = number(p, "width", width, 512, 1536, True)
    height = number(p, "height", height, 512, 1536, True)
    if width % 32 or height % 32 or width * height > 2_000_000:
        raise ValueError("Image dimensions must be multiples of 32 and at most 2 megapixels")
    return width, height


def ideogram_geometry(p):
    """Ideogram 4 geometry: its own rule, not the shared image one.

    The scheduler's mean term scales with pixel area, so this native-2K model
    gets a 4 MP ceiling instead of the 1536 / 2 MP image_geometry rule. The
    template rounds each side up to a multiple of 16 with a floor of 256.
    """
    width, height = 1024, 1024
    if p.get("size") is not None:
        match = re.fullmatch(r"(\d{3,4})x(\d{3,4})", str(p["size"]))
        if not match:
            raise ValueError("size must be WIDTHxHEIGHT")
        width, height = map(int, match.groups())
    width = number(p, "width", width, 256, 2048, True, describe="Comfy-Org/Ideogram-4")
    height = number(p, "height", height, 256, 2048, True, describe="Comfy-Org/Ideogram-4")
    if width % 16 or height % 16 or width * height > 4_000_000:
        raise ValueError("Image dimensions must be multiples of 16 and at most 4 megapixels")
    return width, height


def aspect_ratio(width, height):
    """Reduced W:H, so a 2048x1152 request is reported as 16:9."""
    divisor = math.gcd(width, height) or 1
    return f"{width // divisor}:{height // divisor}"


def ideogram_caption(prompt, width, height):
    """Pass a structured JSON caption through; wrap plain text.

    The model is trained on structured JSON captions and its official inference
    validates prompts against that schema, so a plain-text prompt is wrapped
    rather than handed over as-is.
    """
    try:
        parsed = json.loads(prompt)
    except (TypeError, ValueError):
        parsed = None
    if isinstance(parsed, dict) and parsed.get("high_level_description"):
        return prompt
    return json.dumps({
        "aspect_ratio": aspect_ratio(width, height),
        "high_level_description": prompt,
    })


# Ideogram 4's preset table, copied from the template. ``steps``/``mu``/``std``
# may each be overridden explicitly on the request.
IDEOGRAM4_PRESETS = {
    "Quality": (48, 0.0, 1.5),
    "Default": (20, 0.0, 1.75),
    "Turbo": (12, 0.5, 1.75),
}


def krea2(g, p, prompt, seed):
    width, height = image_geometry(p)
    # Turbo is a distilled 8-step checkpoint; another step count does not run
    # the template's model and another cfg does not run its guidance.
    number(p, "steps", 8, 8, 8, True, describe="Comfy-Org/Krea-2-Turbo")
    cfg = number(p, "cfg", 1.0, 1.0, 1.0, describe="Comfy-Org/Krea-2-Turbo")
    model = g.add("UNETLoader", unet_name="krea2_turbo_int8_convrot.safetensors", weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name="qwen3vl_4b_fp8_scaled.safetensors", type="krea2", device="default")
    vae = g.add("VAELoader", vae_name="qwen_image_vae.safetensors")
    positive = g.add("CLIPTextEncode", clip=clip, text=prompt)
    negative = g.add("ConditioningZeroOut", conditioning=positive)
    latent = g.add("EmptyLatentImage", width=width, height=height, batch_size=1)
    sampled = g.sample(model, positive, negative, latent, seed, 8, cfg)
    return g.add("VAEDecode", samples=sampled, vae=vae)


def ideogram4(g, p, prompt, seed):
    if "negative_prompt" in p:
        # Guidance is asymmetric CFG against a second unconditional network, not
        # a negative prompt string, so there is no field to hold one.
        raise ValueError("Comfy-Org/Ideogram-4 does not accept a negative_prompt")
    width, height = ideogram_geometry(p)
    caption = ideogram_caption(prompt, width, height)
    preset = p.get("preset", "Default")
    if preset not in IDEOGRAM4_PRESETS:
        raise ValueError("preset must be one of Quality, Default, Turbo")
    steps, mu, std = IDEOGRAM4_PRESETS[preset]
    label = "Comfy-Org/Ideogram-4"
    steps = number(p, "steps", steps, 1, 200, True, describe=label)
    mu = number(p, "mu", mu, -10.0, 10.0, describe=label)
    std = number(p, "std", std, 0.1, 5.0, describe=label)
    vae = g.add("VAELoader", vae_name="flux2-vae.safetensors")
    clip = g.add("CLIPLoader", clip_name="qwen3vl_8b_fp8_scaled.safetensors", type="ideogram4", device="default")
    model = g.add("UNETLoader", unet_name="ideogram4_int8_convrot.safetensors", weight_dtype="default")
    uncond = g.add("UNETLoader", unet_name="ideogram4_unconditional_int8_convrot.safetensors", weight_dtype="default")
    positive = g.add("CLIPTextEncode", clip=clip, text=caption)
    negative = g.add("ConditioningZeroOut", conditioning=positive)
    latent = g.add("EmptyFlux2LatentImage", width=width, height=height, batch_size=1)
    noise = g.add("RandomNoise", noise_seed=seed)
    sampler = g.add("KSamplerSelect", sampler_name="euler")
    sigmas = g.add("Ideogram4Scheduler", steps=steps, width=width, height=height, mu=mu, std=std)
    guider = g.add("DualModelGuider", model=model, model_negative=uncond,
                   positive=positive, negative=negative, cfg=7.0)
    sampled = g.add("SamplerCustomAdvanced", noise=noise, guider=guider, sampler=sampler,
                    sigmas=sigmas, latent_image=latent)
    return g.add("VAEDecode", samples=sampled, vae=vae)


def yue2(g, p, style, lyrics, duration, seed):
    label = "Comfy-Org/YuE2-3B"
    mode = p.get("mode", "full")
    if mode not in ("full", "melody"):
        raise ValueError("mode must be full or melody")
    steps = number(p, "steps", 32, 8, 64, True, describe=label)
    cfg = number(p, "cfg", 1.0, 1.0, 4.0, describe=label)
    abc_planning = p.get("abc_planning", False)
    if not isinstance(abc_planning, bool):
        raise ValueError("abc_planning must be true or false")
    # ``abc`` is an optional caller-supplied score; anything that is not bounded
    # text is refused rather than quietly replaced by a generated plan.
    caller_abc = text(p, "abc", "", 20000).strip() or None
    checkpoint = g.add("CheckpointLoaderSimple", ckpt_name="yue2_3b_int8_convrot.safetensors")
    model, clip, vae = checkpoint, [checkpoint[0], 1], [checkpoint[0], 2]
    if caller_abc is not None:
        # A caller-supplied editable score replaces the generator entirely.
        abc = caller_abc
    elif abc_planning:
        # The ABC plan is generated first, then fed to the music node.
        abc = g.add("YuE2GenerateABC", clip=clip, style=style, lyrics=lyrics, seed=seed,
                    mode=mode, max_abc_tokens=8192, temperature=0.7, top_p=0.9,
                    top_k=30, repetition_penalty=1.005, penalty_window=100)
    else:
        # Without a plan the music node generates directly and ignores ``mode``.
        abc = ""
    music = g.add("YuE2GenerateMusic", clip=clip, style=style, lyrics=lyrics, abc=abc,
                  seed=seed, mode=mode, max_duration=duration, temperature=1.0,
                  top_p=0.95, top_k=100, repetition_penalty=1.2)
    positive, seconds = music, [music[0], 1]
    negative = g.add("ConditioningZeroOut", conditioning=positive)
    latent = g.add("EmptyYuE2LatentAudio", seconds=seconds, batch_size=1)
    # YuE2's template runs dpm_2/sgm_uniform, not the euler/simple pair the
    # shared ``sample`` helper hardcodes.
    sampled = g.add("KSampler", model=model, positive=positive, negative=negative,
                    latent_image=latent, seed=seed, steps=steps, cfg=cfg,
                    sampler_name="dpm_2", scheduler="sgm_uniform", denoise=1.0)
    return g.add("VAEDecodeAudio", samples=sampled, vae=vae)


def qwen_image(g, p, prompt, seed, lightning=False):
    width, height = image_geometry(p)
    model = g.add("UNETLoader", unet_name="qwen_image_2512_fp8_e4m3fn.safetensors", weight_dtype="default")
    model = g.add("ModelSamplingAuraFlow", model=model, shift=3.1)
    if lightning:
        model = g.add(
            "LoraLoaderModelOnly",
            model=model,
            lora_name="Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors",
            strength_model=1.0,
        )
    clip = g.add("CLIPLoader", clip_name="qwen_2.5_vl_7b_nvfp4.safetensors", type="qwen_image", device="default")
    vae = g.add("VAELoader", vae_name="qwen_image_vae.safetensors")
    positive = g.add("CLIPTextEncode", clip=clip, text=prompt)
    negative = g.add("CLIPTextEncode", clip=clip, text=text(p, "negative_prompt", "low resolution, blurry text, malformed anatomy, oversaturated, waxy skin, cluttered composition"))
    latent = g.add("EmptySD3LatentImage", width=width, height=height, batch_size=1)
    if lightning:
        number(p, "steps", 4, 4, 4, True)
        steps, cfg = 4, number(p, "cfg", 1.0, 1.0, 1.0)
    else:
        steps, cfg = number(p, "steps", 50, 20, 60, True), number(p, "cfg", 4.0, 1.0, 8.0)
    sampled = g.sample(model, positive, negative, latent, seed, steps, cfg)
    return g.add("VAEDecode", samples=sampled, vae=vae)


def qwen_image_edit(g, p, prompt, seed, image_filename):
    if any(field in p for field in ("size", "width", "height")):
        raise ValueError("Qwen edit output geometry follows the reference image")
    model = g.add("UNETLoader", unet_name="qwen_image_edit_2511_fp8mixed.safetensors", weight_dtype="default")
    model = g.add("ModelSamplingAuraFlow", model=model, shift=3.1)
    model = g.add("CFGNorm", model=model, strength=1.0)
    clip = g.add("CLIPLoader", clip_name="qwen_2.5_vl_7b_nvfp4.safetensors", type="qwen_image", device="default")
    vae = g.add("VAELoader", vae_name="qwen_image_vae.safetensors")
    image = g.add("LoadImage", image=image_filename)
    image = g.add("FluxKontextImageScale", image=image)
    positive = g.add("TextEncodeQwenImageEditPlus", clip=clip, vae=vae, image1=image, prompt=prompt)
    negative = g.add("TextEncodeQwenImageEditPlus", clip=clip, vae=vae, image1=image, prompt=text(p, "negative_prompt", ""))
    latent = g.add("VAEEncode", pixels=image, vae=vae)
    steps = number(p, "steps", 40, 20, 60, True)
    cfg = number(p, "cfg", 4.0, 1.0, 8.0)
    sampled = g.sample(model, positive, negative, latent, seed, steps, cfg)
    return g.add("VAEDecode", samples=sampled, vae=vae)


def qwen_image_21_geometry(p, resolution):
    width = height = resolution
    if "size" in p:
        match = re.fullmatch(r"([0-9]{3,4})x([0-9]{3,4})", str(p["size"]))
        if not match:
            raise ValueError("size must be WIDTHxHEIGHT")
        width, height = map(int, match.groups())
    width = number(p, "width", width, 256, 3072, True)
    height = number(p, "height", height, 256, 3072, True)
    if width % 32 or height % 32 or width * height > 4.5 * 1024 * 1024:
        raise ValueError("Dimensions must be multiples of 32 and at most 4.5 megapixels")
    return width, height


def qwen_image_21(g, p, prompt, seed, image_filename, model_id="Qwen/Qwen-Image-2.1"):
    """Qwen-Image 2.1: one DiT for generation, reference editing and RGBA output.

    The graph mirrors the pinned official template. Its text-encode node splices
    any reference image into the sequence as VAE latents and hands back the
    latent it was built for, so an edit samples that latent while a
    text-to-image request builds its own empty one.

    There is deliberately no ``ModelSamplingAuraFlow``: 2.1 carries its own
    sampling shift in the checkpoint, and the aura-flow patch (what the 2512
    lane needs at 3.1) would override it. The template also runs cfg 1, where
    the negative prompt is unused.

    ``model_id`` picks a fixed checkpoint set from
    ``QWEN_IMAGE_21_CHECKPOINTS``; the INT8 and NVFP4 lanes share this contract
    and differ only in which pinned files the loaders open.
    """
    allowed = {"model", "prompt", "negative_prompt", "image", "size", "width", "height", "resolution", "quality", "steps", "seed", "cfg", "n", "response_format"}
    if set(p) - allowed:
        raise ValueError("Unsupported Qwen Image 2.1 fields: " + ", ".join(sorted(set(p) - allowed)))
    if p.get("negative_prompt", "") != "":
        raise ValueError("negative_prompt is unsupported because Qwen Image 2.1 uses cfg=1")
    if "size" in p and ("width" in p or "height" in p):
        raise ValueError("Use size or width/height, not both")
    resolution = number(p, "resolution", 1024, 256, 2048, True, describe="the reference-image pixel budget")
    if resolution % 32:
        raise ValueError("resolution must be a multiple of 32")
    checkpoints = QWEN_IMAGE_21_CHECKPOINTS[model_id]
    model = g.add("UNETLoader", unet_name=checkpoints["diffusion"], weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name=checkpoints["encoder"], type="qwen_image", device="default")
    vae = g.add("VAELoader", vae_name=checkpoints["vae"])
    if image_filename is not None:
        if any(field in p for field in ("size", "width", "height")):
            raise ValueError("Qwen 2.1 edits follow the reference image; use resolution instead")
        # The node resizes every reference to about resolution x resolution
        # pixels at multiples of 32, preserving aspect ratio.
        encode = g.add("TextEncodeQwenImage21", clip=clip, vae=vae, prompt=prompt,
                       negative_prompt=text(p, "negative_prompt", ""), resolution=resolution)
        positive, negative, latent = encode, [encode[0], 1], [encode[0], 2]
        image = g.add("LoadImage", image=image_filename)
        # API graphs use flattened dynamic-input paths. ComfyUI resolves the
        # link first, then builds the images dict passed to execute(). A nested
        # dict here is not a graph edge and silently loses the reference.
        # LoadImage hands back RGB plus MASK = 1 - alpha. JoinImageWithAlpha
        # rebuilds 4 channels from image + (1 - mask), so an RGBA reference
        # survives the edit instead of being flattened against the VAE's white
        # composite. The mask link is required: without it the node would take a
        # default alpha.
        rgba = g.add("JoinImageWithAlpha", image=[image[0], 0], alpha=[image[0], 1])
        g.nodes[encode[0]]["inputs"]["images.image_1"] = rgba
    else:
        width, height = qwen_image_21_geometry(p, resolution)
        # Without reference images the node resizes nothing, so its resolution
        # is inert; generation geometry comes from the empty latent below.
        encode = g.add("TextEncodeQwenImage21", clip=clip, vae=vae, prompt=prompt,
                       negative_prompt=text(p, "negative_prompt", ""), resolution=1024)
        positive, negative = encode, [encode[0], 1]
        latent = g.add("EmptyLatentImage", width=width, height=height, batch_size=1)
    # Both generation and editing share this one step resolver, so the quality
    # dial and the explicit-steps override behave identically in either mode.
    steps = qwen_image_21_steps(p)
    cfg = number(p, "cfg", 1.0, 1.0, 1.0)
    sampled = g.sample(model, positive, negative, latent, seed, steps, cfg)
    return g.add("VAEDecode", samples=sampled, vae=vae)


def flux2_klein(g, p, prompt, seed, image_filename):
    width, height = image_geometry(p)
    number(p, "steps", 4, 4, 4, True)
    cfg = number(p, "cfg", 1.0, 1.0, 5.0)
    model = g.add("UNETLoader", unet_name="flux-2-klein-4b-nvfp4.safetensors", weight_dtype="default")
    clip = g.add("CLIPLoader", clip_name="qwen_3_4b_fp4_mixed.safetensors", type="flux2", device="default")
    vae = g.add("VAELoader", vae_name="flux2-vae.safetensors")
    positive = g.add("CLIPTextEncode", clip=clip, text=prompt)
    negative = g.add("CLIPTextEncode", clip=clip, text=text(p, "negative_prompt", ""))
    if image_filename is not None:
        image = g.add("LoadImage", image=image_filename)
        image = g.add("ImageScaleToTotalPixels", image=image, upscale_method="nearest-exact", megapixels=1.0, resolution_steps=1)
        reference = g.add("VAEEncode", pixels=image, vae=vae)
        positive = g.add("ReferenceLatent", conditioning=positive, latent=reference)
        negative = g.add("ReferenceLatent", conditioning=negative, latent=reference)
    latent = g.add("EmptyFlux2LatentImage", width=width, height=height, batch_size=1)
    noise = g.add("RandomNoise", noise_seed=seed)
    guider = g.add("CFGGuider", model=model, positive=positive, negative=negative, cfg=cfg)
    sampler = g.add("KSamplerSelect", sampler_name="euler")
    sigmas = g.add("Flux2Scheduler", steps=4, width=width, height=height)
    sampled = g.add("SamplerCustomAdvanced", noise=noise, guider=guider, sampler=sampler, sigmas=sigmas, latent_image=latent)
    return g.add("VAEDecode", samples=sampled, vae=vae)
