# Spark speech adapter

Serves one existing local Qwen3-TTS or Whisper checkpoint per process. The stock
engine remains the default. Set `LLOOM_TTS_ENGINE=faster` for CUDA graph voice
cloning using `faster-qwen3-tts==0.2.6` (MIT, upstream commit
`5ae964a39fadec39141db779f5c5e4768ddd2b22`). This version matches Qwen TTS 0.1.1
and Transformers 4.57.3; install it without replacing the CUDA-matched PyTorch.

`stream: true` with `response_format: pcm` emits mono 24 kHz signed little-endian
PCM16 as synthesis progresses. Four codec frames per chunk balance onset and
decode overhead. WAV remains buffered. Named profiles are resolved by the
LLooM gateway and their bounded reference audio is sent inline; the adapter
never opens client-supplied paths. Profile sampling parameters are preserved.

The producer owns the single GPU lease until it actually exits. Cancellation
stops further chunks, closes the generator, and cannot release a replacement
request's lease. Queue capacity and reference/prompt caches are bounded.
A failed partial stream closes the connection rather than appending JSON or SSE
to audio. Cold CUDA graph capture and first-use voice conditioning require a
warm-up before latency measurement. A loaded GPU can remain slower than real
time even when first audio arrives earlier; measure both onset and sustained
production against the same concurrent workload.

Run `pytest -q backends/spark-audio/test_lloom_audio_cuda_server.py` in an isolated
environment with FastAPI, httpx, numpy, soundfile, python-multipart, and pytest.
These tests use fake models. Hardware acceptance must additionally prove PCM
headers, named-profile routing, streaming onset, interruption/recovery, and
transcription through the selected gateway on the actual host.

Per-model recipes and setup commands are documented in [Spark audio](../../docs/spark-audio.md).
