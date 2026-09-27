"""Bounded local MP4 reference preflight; never accepts paths or URLs."""
import base64
import binascii
from fractions import Fraction
import json
from pathlib import Path
import re
import subprocess
import tempfile
from errors import bad_request


def decode_reference_video(payload):
    value = payload.get("video")
    if value is None:
        return None
    if payload.get("model") != "MiniMaxAI/MiniMax-H3":
        raise bad_request("This model does not support a reference video.", "invalid_field")
    match = re.fullmatch(r"data:video/mp4;base64,([A-Za-z0-9+/=\s]+)", value) if isinstance(value, str) else None
    if not match:
        raise bad_request("video must be an inline MP4 data URI.", "invalid_field")
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", match[1]), validate=True)
    except (ValueError, binascii.Error):
        raise bad_request("video is not valid base64.", "invalid_field") from None
    if not 12 <= len(raw) <= 16 * 1024 * 1024 or raw[4:8] != b"ftyp":
        raise bad_request("video must be an MP4 of at most 16 MiB.", "invalid_field")
    try:
        with tempfile.TemporaryDirectory(prefix="lloom-video-") as folder:
            path = Path(folder) / "input.mp4"
            path.write_bytes(raw)
            result = subprocess.run(["ffprobe", "-v", "error", "-f", "mov", "-count_frames", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,nb_read_frames", "-of", "json", str(path)], capture_output=True, text=True, timeout=20, check=True)
            streams = json.loads(result.stdout)["streams"]
            video = next(s for s in streams if s["codec_type"] == "video")
            w, h, n = int(video["width"]), int(video["height"]), int(video["nb_read_frames"])
            fps = float(Fraction(video["avg_frame_rate"]))
            if not (1 <= w <= 2048 and 1 <= h <= 2048 and w * h <= 2097152 and 5 <= n <= 360 and abs(fps - 24) < 0.001):
                raise ValueError("Reference video must be 24 fps, 5-360 frames, at most 2048 per axis and 2 MP.")
            if payload.get("video_audio") and not any(s["codec_type"] == "audio" for s in streams):
                raise ValueError("video_audio was requested but the source has no audio stream.")
            subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-f", "mov", "-i", str(path), "-f", "null", "-"], capture_output=True, timeout=30, check=True)
    except (ValueError, ZeroDivisionError) as exc:
        raise bad_request(str(exc), "invalid_field") from None
    except (KeyError, StopIteration, OSError, subprocess.SubprocessError):
        raise bad_request("video is malformed or exceeds the decoding time limit.", "invalid_field") from None
    return raw, "video/mp4", "mp4"
