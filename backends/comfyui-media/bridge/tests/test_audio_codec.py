import io
import wave
import numpy as np
import pytest
import soundfile as sf
from audio_codec import flac_to_wav
from errors import BridgeError


def test_flac_preserves_pcm_and_sample_rate():
    samples = (np.sin(np.arange(3200) * 0.08) * 12000).astype(np.int16)
    src = io.BytesIO()
    sf.write(src, samples, 32000, format="FLAC", subtype="PCM_16")
    output = flac_to_wav(src.getvalue())
    with wave.open(io.BytesIO(output)) as wav:
        assert wav.getframerate() == 32000
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.readframes(wav.getnframes()) == samples.tobytes()


def test_audio_conversion_rejects_unbounded_shape():
    src = io.BytesIO()
    sf.write(src, np.zeros((16, 3), dtype=np.int16), 48000, format="FLAC")
    with pytest.raises(BridgeError):
        flac_to_wav(src.getvalue())


def test_audio_conversion_rejects_invalid_container():
    with pytest.raises(BridgeError):
        flac_to_wav(b"fLaCinvalid")
