# Spark audio speech and transcription recipes

Each `linux-nvidia-spark-audio-*` recipe installs one checkpoint and runs it in
its own LLooM-managed container, port and runtime. All four recipes share only the
image, which is built locally from `backends/spark-audio`.

| Recipe                                                | Gateway model                          | Kind                      |
| ----------------------------------------------------- | -------------------------------------- | ------------------------- |
| `linux-nvidia-spark-audio-qwen3-tts-1-7b-customvoice` | `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | speech, built-in speakers |
| `linux-nvidia-spark-audio-qwen3-tts-1-7b-base`        | `Qwen/Qwen3-TTS-12Hz-1.7B-Base`        | speech, voice cloning     |
| `linux-nvidia-spark-audio-qwen3-tts-1-7b-voicedesign` | `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | speech, voice design      |
| `linux-nvidia-spark-audio-whisper-large-v3-turbo`     | `openai/whisper-large-v3-turbo`        | transcription             |

## Install

Use Linux on NVIDIA hardware with Docker, NVIDIA Container Toolkit and Python 3
with venv support. Preview the complete plan, then apply and start:

```sh
lloom setup --recipe linux-nvidia-spark-audio-qwen3-tts-1-7b-base --additive --json
lloom setup --recipe linux-nvidia-spark-audio-qwen3-tts-1-7b-base --additive --apply --yes --start
```

Repeat with another recipe ID to add a model. `--additive` preserves the existing
catalog and defaults. Speech models reserve 10 GiB and Whisper reserves 6 GiB in
LLooM's admission configuration. Each runtime accepts one request at a time and
is not kept warm.

The backend installer builds `lloom/spark-audio:source-<sha256>` from the digest-pinned
NGC PyTorch base, the Dockerfile and the adapter. The tag is the SHA-256 of those
build inputs; tests and documentation are excluded. Reapplying setup checks the
image's source label and reuses a matching image. Nothing is pulled from a private
registry.

Downloads use immutable Hugging Face revisions with per-file SHA-256 checks. Each
container mounts only its own model directory, read-only, with Hugging Face
offline mode enabled. Backend ports stay bound to loopback; clients use the
authenticated LLooM gateway.

openai-whisper cannot load the Transformers-format `openai/whisper-large-v3-turbo`
repository. The Whisper recipe therefore downloads OpenAI's original
`large-v3-turbo.pt` checkpoint from a byte-identical Hugging Face copy. Its SHA-256
matches the value published in openai-whisper v20250625.

Voice cloning uses the stock Qwen engine by default. Streamed PCM voice clones
and cancellation between chunks require `LLOOM_TTS_ENGINE=faster` in the
runtime's container environment; see the [adapter README](../backends/spark-audio/README.md).
Buffered synthesis and transcription run to completion after a client disconnects.

Run CPU validation:

```sh
python -m pytest -q backends/spark-audio/test_lloom_audio_cuda_server.py
node test/spark-audio-recipes.test.mjs
```
