"""Bounded conversion of ComfyUI's lossless FLAC output to PCM WAV."""
import io
from errors import backend_error


def flac_to_wav(data):
    import soundfile as sf
    try:
        with sf.SoundFile(io.BytesIO(data)) as source:
            if (source.format != "FLAC" or source.channels not in (1, 2)
                    or not 8000 <= source.samplerate <= 48000
                    or not 0 < source.frames <= source.samplerate * 360):
                raise ValueError("unsupported audio shape")
            samples = source.read(dtype="int16", always_2d=True)
            output = io.BytesIO()
            sf.write(output, samples, source.samplerate, format="WAV", subtype="PCM_16")
            return output.getvalue()
    except Exception:
        raise backend_error("Invalid or oversized generated audio.") from None
