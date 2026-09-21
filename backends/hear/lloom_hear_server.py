#!/usr/bin/env python3
"""LLooM Hear — a local hearing tool exposed as a LLooM backend.

Takes audio (base64, URL, or path), optionally extracts a segment, runs local DSP
for denotation, renders analytic images, and calls an upstream model for
interpretation and query answering. DSP and the model call run concurrently so
elapsed time is max(dsp, model) rather than the sum.

Design rules:
  * Every measured field carries a confidence and its alternatives.
  * Abstention is computed from evidence (RMS gate, correlation margin), never
    self-reported by a model.
  * The interpretation prompt asks the model to avoid numbers, and its
    provenance is labelled "generated" so callers can tell it from measurement.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import http.client
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import tempfile
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

# numba fails outright ("cannot cache function ... no locator available") and
# matplotlib rebuilds its font cache on every process start unless these point at
# a writable, persistent directory. Configure them before anything imports either.
_cache_root = os.environ.get("LLOOM_HEAR_CACHE_DIR") or os.path.join(
    os.path.expanduser("~"), ".lloom", "backends", "hear", "cache")


def _ensure_dir(path: str) -> str:
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, ".w")
        with open(probe, "w") as f:
            f.write("")
        os.remove(probe)
        return path
    except OSError:
        fallback = os.path.join(tempfile.gettempdir(), "lloom-hear-cache",
                                os.path.basename(path))
        os.makedirs(fallback, exist_ok=True)
        return fallback


os.environ.setdefault("NUMBA_CACHE_DIR", _ensure_dir(os.path.join(_cache_root, "numba")))
os.environ.setdefault("MPLCONFIGDIR", _ensure_dir(os.path.join(_cache_root, "mpl")))

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DEF = {
    "port": 8230,
    "host": "127.0.0.1",
    "upstream_url": os.environ.get("LLOOM_HEAR_UPSTREAM_URL", "http://127.0.0.1:8100/v1/chat/completions"),
    "upstream_model": os.environ.get("LLOOM_HEAR_UPSTREAM_MODEL", "google/gemini-3.1-flash-lite"),
    "upstream_key_env": "LLOOM_HEAR_UPSTREAM_KEY",
    "artifact_dir": os.environ.get("LLOOM_HEAR_ARTIFACT_DIR") or tempfile.mkdtemp(prefix="lloom-hear-artifacts-"),
    # "inline" keeps the response self-contained so a gateway caller never needs to
    # reach the runtime port directly; "url" is for direct/local use.
    "image_delivery": os.environ.get("LLOOM_HEAR_IMAGE_DELIVERY", "inline"),
    "max_analysis_seconds": 300.0,
    "max_upstream_bytes": 1024 * 1024,
    "artifact_ttl_seconds": 3600,
    "max_artifacts": 128,
    "rms_silence_floor": 1e-4,
    "flatness_noise_floor": 0.15,
    "min_segment_s": 4.0,
    "key_margin_floor": 0.02,
    "dsp_workers": 2,
    "self_model_ids": {"hear", "listen", "lloom-hear", "local/hear"},
    # Ingest and resource bounds. Data parts are decoded in memory, so the request
    # byte ceiling is what keeps a single call from exhausting the process.
    "max_request_bytes": 64 * 1024 * 1024,
    "max_input_bytes": 64 * 1024 * 1024,
    "max_download_bytes": 64 * 1024 * 1024,
    "ffmpeg_timeout_s": 120.0,
    "ffprobe_timeout_s": 30.0,
    "download_timeout_s": 60.0,
}

for _k, _v in list(DEF.items()):
    _env = os.environ.get(f"LLOOM_HEAR_{_k.upper()}")
    if _env:
        DEF[_k] = type(_v)(_env) if not isinstance(_v, (dict, set)) else _v

# Operator decisions, all closed by default. A local file path, an outbound audio
# fetch, and an upstream interpretation call that ships audio to another endpoint
# are each a separate opt-in; none of them is enabled just by deploying the backend.
#
#   LLOOM_HEAR_ALLOWED_INPUT_DIRS  colon-separated absolute directories; local path
#                                  parts resolve inside one of them (symlinks included)
#   LLOOM_HEAR_ALLOW_URL_FETCH     truthy enables remote https audio ingest
#   LLOOM_HEAR_ALLOW_LOCAL_FILES   truthy enables local path ingest
#   LLOOM_HEAR_ALLOWED_INTERPRET_MODELS  comma-separated upstream model allowlist
#   LLOOM_HEAR_ALLOW_INTERPRET     truthy only changes the default value of
#                                  `hear.interpret`; callers can always ask for true
_TRUEISH = {"1", "true", "yes", "on"}


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.strip().lower() in _TRUEISH


def _env_list(name: str, sep: str = ",") -> List[str]:
    raw = os.environ.get(name) or ""
    return [item.strip() for item in raw.split(sep) if item.strip()]


ALLOWED_INPUT_DIRS: List[str] = [
    os.path.realpath(os.path.expanduser(d)) for d in _env_list("LLOOM_HEAR_ALLOWED_INPUT_DIRS", os.pathsep)
]
ALLOW_LOCAL_FILES = _env_flag("LLOOM_HEAR_ALLOW_LOCAL_FILES")
ALLOW_URL_FETCH = _env_flag("LLOOM_HEAR_ALLOW_URL_FETCH")
ALLOWED_INTERPRET_MODELS = _env_list("LLOOM_HEAR_ALLOWED_INTERPRET_MODELS")
DEFAULT_INTERPRET = _env_flag("LLOOM_HEAR_ALLOW_INTERPRET", False)

# Finite extension allowlist. The format string never reaches the filesystem, but an
# unbounded value is still an unbounded input surface (and a way to lie to ffmpeg).
AUDIO_EXTENSIONS = frozenset({
    "mp3", "wav", "wave", "m4a", "mp4", "aac", "flac", "ogg", "oga", "opus",
    "aiff", "aif", "aifc", "wma", "webm", "mkv", "mov", "amr", "caf", "au", "mp2", "3gp",
})
MEDIA_INPUT_OPTIONS = ["-protocol_whitelist", "file,pipe", "-format_whitelist",
                       "wav,mp3,flac,ogg,mov,aac,aiff,asf,matroska,webm,amr,caf,au"]
ALLOWED_IMAGE_DELIVERY = frozenset({"inline", "url", "none"})

os.makedirs(DEF["artifact_dir"], exist_ok=True)
_executor = ThreadPoolExecutor(max_workers=int(DEF["dsp_workers"]))
_render_lock = asyncio.Lock()
_request_slots = asyncio.BoundedSemaphore(2)

app = FastAPI(title="LLooM Hear", version="0.1.0")

# ---------------------------------------------------------------------------
# Audio ingest
# ---------------------------------------------------------------------------

_TIME_RE = re.compile(
    r"(?:^|\D)(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\s*(?:-|–|to|until|through)\s*"
    r"(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?:\D|$)"
)

_FORMAT_RE = re.compile(r"^[A-Za-z0-9]{1,12}$")


def _fail(status: int, message: str) -> HTTPException:
    """HTTP errors are deliberately opaque: they never echo a caller path, URL, or
    subprocess diagnostic back to the client."""
    return HTTPException(status, message)


def _require_int(value: Any, field: str, *, maximum: float) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _fail(400, f"{field} must be a finite number")
    if isinstance(value, float) and not value.is_integer():
        # Byte counts arrive as integers; 1000.5 bytes is a shape error, not a bound.
        raise _fail(400, f"{field} must be a whole number of bytes")
    number = int(value)
    if number < 0:
        raise _fail(400, f"{field} must be non-negative")
    if number > int(maximum):
        raise _fail(413, f"{field} exceeds the configured limit")
    return number


def validate_audio_format(value: Any) -> str:
    """Finite extension allowlist, checked before the value is used to build a name."""
    if value is None or value == "":
        return "mp3"
    if not isinstance(value, str):
        raise _fail(400, "audio format must be a string")
    fmt = value.strip().lower().lstrip(".")
    if fmt not in AUDIO_EXTENSIONS or not _FORMAT_RE.match(fmt):
        raise _fail(400, "unsupported audio format")
    return fmt


def resolve_local_audio_path(raw: Any) -> str:
    """Resolve a caller-supplied path, following symlinks, and enforce containment."""
    if not ALLOWED_INPUT_DIRS:
        raise _fail(403, "local audio paths are disabled unless "
                         "LLOOM_HEAR_ALLOWED_INPUT_DIRS configures the readable directory")
    if not ALLOW_LOCAL_FILES:
        raise _fail(403, "local audio paths are disabled by operator configuration")
    if not isinstance(raw, str) or not raw:
        raise _fail(400, "audio path must be a non-empty string")
    if "\x00" in raw:
        raise _fail(400, "invalid audio path")
    real = os.path.realpath(os.path.expanduser(raw))
    for root in ALLOWED_INPUT_DIRS:
        try:
            if os.path.commonpath([real, root]) == root:
                break
        except ValueError:
            continue
    else:
        raise _fail(400, "audio path not found")
    if not os.path.isfile(real):
        raise _fail(400, "audio path not found")
    return real


def _address_allowed(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    if not addr.is_global:
        return False
    if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
        return False
    if addr.is_multicast or addr.is_unspecified:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and (addr.is_site_local or addr.ipv4_mapped):
        # ::ffff:127.0.0.1 is loopback wearing a v6 costume.
        if addr.ipv4_mapped is not None and not _address_allowed(str(addr.ipv4_mapped)):
            return False
        return not addr.is_site_local
    return True


def validate_remote_url(url: Any) -> str:
    """HTTPS only, no credentials in the URL, no non-public address (DNS included)."""
    if not ALLOW_URL_FETCH:
        raise _fail(403, "remote audio urls are disabled unless the operator sets "
                         "LLOOM_HEAR_ALLOW_URL_FETCH")
    if not isinstance(url, str) or not url:
        raise _fail(400, "audio url must be a non-empty string")
    try:
        parsed = urllib.parse.urlsplit(url)
    except ValueError as e:
        raise _fail(400, "invalid audio url") from e
    if parsed.scheme != "https":
        raise _fail(400, "audio url must use https")
    if parsed.username or parsed.password:
        raise _fail(400, "audio url must not carry credentials")
    host = parsed.hostname
    if not host:
        raise _fail(400, "invalid audio url")
    try:
        port = parsed.port or 443
    except ValueError as e:
        raise _fail(400, "invalid audio url port") from e
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError as e:
        raise _fail(400, "audio url host could not be resolved") from e
    if not infos:
        raise _fail(400, "audio url host could not be resolved")
    for info in infos:
        if not _address_allowed(info[4][0]):
            raise _fail(400, "audio url host resolves to a non-public address")
    return url


def _download_url(url: str, dest: str, max_bytes: int) -> int:
    """Blocking bounded fetch; every redirect is refusal, not a hop."""
    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ARG002
            raise urllib.error.HTTPError(req.full_url, code,
                                         "upstream redirects are not followed", headers, fp)

    # Validate the addresses actually used by the socket, without a second DNS
    # lookup between validation and connection. Keep TLS verification on the
    # original hostname, and bypass ambient proxies for this untrusted URL.
    class _PublicHTTPSConnection(http.client.HTTPSConnection):
        def connect(self):
            def public_connection(address, timeout=None, source_address=None):
                infos = socket.getaddrinfo(*address, type=socket.SOCK_STREAM)
                if not infos or any(not _address_allowed(info[4][0]) for info in infos):
                    raise _fail(400, "audio url host resolves to a non-public address")
                error = None
                for family, kind, proto, _, sockaddr in infos:
                    sock = socket.socket(family, kind, proto)
                    try:
                        sock.settimeout(timeout)
                        if source_address:
                            sock.bind(source_address)
                        sock.connect(sockaddr)
                        return sock
                    except OSError as exc:
                        error = exc
                        sock.close()
                raise error or OSError("connection failed")
            self._create_connection = public_connection
            super().connect()

    class _PublicHTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(_PublicHTTPSConnection, req, context=self._context)

    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), _NoRedirect, _PublicHTTPSHandler())
    total = 0
    deadline = time.monotonic() + float(DEF["download_timeout_s"])
    with opener.open(url, timeout=float(DEF["download_timeout_s"])) as response:
        with open(dest, "wb") as out:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise _fail(504, "audio download timed out")
                if hasattr(response, "fp") and hasattr(response.fp, "raw"):
                    response.fp.raw._sock.settimeout(remaining)
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    raise _fail(413, "remote audio exceeds the configured download limit")
                out.write(chunk)
    if total == 0:
        raise _fail(400, "remote audio was empty")
    return total


async def _fetch_remote(url: str, dest: str) -> int:
    """Host and DNS validation are blocking, so the whole fetch moves off-loop."""
    loop = asyncio.get_running_loop()

    def _do() -> int:
        validated = validate_remote_url(url)
        try:
            return _download_url(validated, dest, int(DEF["max_download_bytes"]))
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise _fail(400, "could not fetch audio url") from e

    return await loop.run_in_executor(_executor, _do)


def _mmss(m: str, s: str, frac: Optional[str]) -> float:
    return int(m) * 60 + int(s) + (float(f"0.{frac}") if frac else 0.0)


def parse_window_from_text(text: str) -> Optional[Tuple[float, float]]:
    m = _TIME_RE.search(text or "")
    if not m:
        return None
    a = _mmss(m.group(1), m.group(2), m.group(3))
    b = _mmss(m.group(4), m.group(5), m.group(6))
    return (a, b) if b > a else None


def _ffmpeg(args: List[str]) -> None:
    exe = shutil.which("ffmpeg")
    if not exe:
        raise HTTPException(500, "ffmpeg not found on PATH")
    try:
        p = subprocess.run([exe, "-v", "error", "-y", *args], capture_output=True,
                           timeout=float(DEF["ffmpeg_timeout_s"]))
    except subprocess.TimeoutExpired as e:
        # No raw stderr in the response: it contains local paths.
        raise _fail(504, "audio conversion timed out") from e
    if p.returncode != 0:
        raise _fail(400, "audio could not be decoded; unsupported or corrupt input")


def _probe_duration(path: str) -> float:
    """Known, finite duration or refuse — never fall back to processing everything."""
    exe = shutil.which("ffprobe")
    if not exe:
        raise HTTPException(500, "ffprobe not found on PATH")
    try:
        p = subprocess.run(
            [exe, "-v", "error", *MEDIA_INPUT_OPTIONS, "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, timeout=float(DEF["ffprobe_timeout_s"]))
    except subprocess.TimeoutExpired as e:
        raise _fail(504, "probing audio duration timed out") from e
    if p.returncode != 0:
        raise _fail(400, "audio could not be probed; unsupported or corrupt input")
    try:
        value = float(p.stdout.decode().strip())
    except Exception as e:  # noqa: BLE001
        raise _fail(400, "audio duration is unknown; refusing to process unbounded input") from e
    if not value == value or value in (float("inf"), float("-inf")):
        raise _fail(400, "audio duration is unknown; refusing to process unbounded input")
    if value <= 0:
        raise _fail(400, "audio duration is unknown; refusing to process unbounded input")
    return value


def _extract(src: str, start: Optional[float], dur: Optional[float], out: str, codec: List[str]) -> None:
    args: List[str] = []
    if start:
        args += ["-ss", f"{start:.3f}"]
    if dur:
        args += ["-t", f"{dur:.3f}"]
    args += [*MEDIA_INPUT_OPTIONS, "-i", src, "-vn", *codec, out]
    _ffmpeg(args)


async def _resolve_source(msg_audio: Dict[str, Any], workdir: str) -> Tuple[str, Optional[str]]:
    """Return (path_on_disk, suffix_or_None) — suffix is never used by callers."""
    if msg_audio.get("path"):
        path = resolve_local_audio_path(msg_audio["path"])
        if os.path.getsize(path) > int(DEF["max_input_bytes"]):
            raise _fail(413, "audio data exceeds the configured input limit")
        return path, None
    url = msg_audio.get("url")
    if url:
        fmt = validate_audio_format(msg_audio.get("format"))
        dst = os.path.join(workdir, f"audio.{fmt}")
        await _fetch_remote(url, dst)
        return dst, None
    b64 = msg_audio.get("data")
    if b64:
        if not isinstance(b64, str):
            raise _fail(400, "audio data must be a base64 string")
        fmt = validate_audio_format(msg_audio.get("format"))
        try:
            raw = base64.b64decode(b64, validate=True)
        except Exception as e:  # noqa: BLE001
            raise _fail(400, "invalid base64 audio data") from e
        if not raw:
            raise _fail(400, "audio data was empty")
        if len(raw) > int(DEF["max_input_bytes"]):
            raise _fail(413, "audio data exceeds the configured input limit")
        dst = os.path.join(workdir, f"audio.{fmt}")
        with open(dst, "wb") as f:
            f.write(raw)
        return dst, None
    raise _fail(400, "audio part had none of data/url/path")


# ---------------------------------------------------------------------------
# DSP
# ---------------------------------------------------------------------------

_PC = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MIN = np.array([6.33, 2.68, 3.52, 2.54, 4.73, 2.69, 3.34, 3.98, 2.69, 3.34, 3.17, 2.35])


def _key_candidates(chroma: np.ndarray) -> List[Dict[str, Any]]:
    out = []
    for i in range(12):
        out.append({"key": f"{_PC[i]} major",
                    "corr": float(np.corrcoef(np.roll(_MAJ, i), chroma)[0, 1])})
        out.append({"key": f"{_PC[i]} minor",
                    "corr": float(np.corrcoef(np.roll(_MIN, i), chroma)[0, 1])})
    out.sort(key=lambda d: -d["corr"])
    return out[:3]


def _detect_boundaries(novelty: np.ndarray, times: np.ndarray, dur: float) -> List[float]:
    """Novelty peak-picking shared by the measurement and rendering paths so the
    dashboard's section lines always agree with the reported segments."""
    import librosa

    if novelty.size <= 4:
        return []
    delta = float(novelty.mean() + 1.6 * novelty.std())
    peaks = librosa.util.peak_pick(novelty, pre_max=12, post_max=12,
                                   pre_avg=20, post_avg=20,
                                   delta=max(delta, 1e-6), wait=40)
    raw = sorted(float(times[min(p, len(times) - 1)]) for p in peaks)
    kept: List[float] = []
    for b in raw:
        if 1.0 < b < dur - 1.0 and (not kept or b - kept[-1] >= float(DEF["min_segment_s"])):
            kept.append(b)
    if len(kept) > 10:
        mags = {round(float(times[min(p, len(times) - 1)]), 2):
                float(novelty[min(p, len(novelty) - 1)]) for p in peaks}
        kept = sorted(sorted(kept, key=lambda b: -mags.get(round(b, 2), 0.0))[:10])
    return [round(b, 2) for b in kept]


def analyse(path: str, sr: int = 22050) -> Dict[str, Any]:
    """Local denotation. Everything returned here is measured or derived."""
    import librosa

    t_start = time.perf_counter()
    timings: Dict[str, float] = {}

    t = time.perf_counter()
    y, sr = librosa.load(path, sr=sr, mono=True)
    timings["load_ms"] = round((time.perf_counter() - t) * 1000, 1)

    if y.size == 0:
        return {"abstain": True, "reason": "empty audio", "timings_ms": timings}

    rms = float(np.sqrt(np.mean(y ** 2)))
    peak = float(np.max(np.abs(y)))

    if rms < float(DEF["rms_silence_floor"]):
        return {
            "abstain": True,
            "reason": "silence",
            "evidence": "measured",
            "duration_s": round(len(y) / sr, 3),
            "rms": rms,
            "peak": peak,
            "measured": {"loudness": {"rms": rms, "peak": peak}},
            "confidence_notes": [
                f"RMS {rms:.2e} is below the silence floor {DEF['rms_silence_floor']}; "
                "no musical content is reported."
            ],
            "timings_ms": timings,
        }

    # One STFT, reused by every feature below.
    t = time.perf_counter()
    n_fft, hop = 2048, 512
    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop))
    S_db = librosa.amplitude_to_db(S, ref=np.max)
    times = librosa.frames_to_time(np.arange(S.shape[1]), sr=sr, hop_length=hop)
    timings["stft_ms"] = round((time.perf_counter() - t) * 1000, 1)

    t = time.perf_counter()
    rms_env = librosa.feature.rms(S=S)[0]
    centroid = librosa.feature.spectral_centroid(S=S, sr=sr)[0]
    rolloff = librosa.feature.spectral_rolloff(S=S, sr=sr, roll_percent=0.85)[0]
    flatness = librosa.feature.spectral_flatness(S=S)[0]
    onset_env = librosa.onset.onset_strength(S=librosa.power_to_db(S ** 2), sr=sr)
    timings["features_ms"] = round((time.perf_counter() - t) * 1000, 1)

    t = time.perf_counter()
    tempo_raw = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr, start_bpm=120)[0]
    tempo = float(np.atleast_1d(tempo_raw)[0])
    timings["tempo_ms"] = round((time.perf_counter() - t) * 1000, 1)

    t = time.perf_counter()
    chroma = librosa.feature.chroma_stft(S=S, sr=sr).mean(axis=1)
    chroma = chroma / (chroma.sum() + 1e-9)
    keys = _key_candidates(chroma)
    margin = keys[0]["corr"] - keys[1]["corr"]
    timings["chroma_ms"] = round((time.perf_counter() - t) * 1000, 1)

    t = time.perf_counter()
    novelty = np.maximum(0.0, np.diff(S_db, axis=1)).mean(axis=0)
    novelty = np.convolve(novelty, np.ones(9) / 9, mode="same")
    # Peak-pick relative to this track's own novelty distribution. A fixed delta
    # over-segments steady loops into a section every couple of seconds.
    dur = float(len(y) / sr)
    bounds = _detect_boundaries(novelty, times, dur)
    edges = sorted({0.0, *bounds, dur})
    sections = []
    for a, b in zip(edges[:-1], edges[1:]):
        ia = int(a * sr)
        ib = int(b * sr)
        seg_rms = float(np.sqrt(np.mean(y[ia:ib] ** 2))) if ib > ia else 0.0
        sections.append({
            "start": round(a, 2), "end": round(b, 2),
            "energy": round(seg_rms, 4),
        })
    if sections:
        mx = max(s["energy"] for s in sections) or 1.0
        for s in sections:
            rel = s["energy"] / mx
            s["energy_rel"] = round(rel, 3)
            s["label"] = ("low" if rel < 0.4 else "mid" if rel < 0.75 else "high") + " energy"
    timings["structure_ms"] = round((time.perf_counter() - t) * 1000, 1)

    # Notable moments: give the caller seeds to drill into instead of timecodes
    # it would otherwise have to invent.
    moments = []
    if bounds:
        idx = {round(float(times[min(i, len(times) - 1)]), 2): i for i in range(len(times))}
        ranked = sorted(((float(novelty[min(idx[b], len(novelty) - 1)]), b) for b in bounds),
                        key=lambda x: -x[0])[:6]
        moments = sorted(
            ({"t": b, "kind": "spectral_change", "magnitude": round(mag, 4)}
             for mag, b in ranked), key=lambda m: m["t"])

    flat = float(np.mean(flatness))
    noise_like = flat > float(DEF["flatness_noise_floor"])

    # Known failure modes: Krumhansl profiles routinely cannot separate a key from
    # its relative major/minor (shared pitch-class set) or its parallel major/minor
    # (shared tonic, differing third). Both are flagged rather than asserted.
    def _split(k: str) -> Tuple[Optional[int], str]:
        try:
            r, m = k.split()
            return _PC.index(r), m
        except (ValueError, IndexError):
            return None, ""

    def _related(a: str, b: str) -> bool:
        ia, ma = _split(a)
        ib, mb = _split(b)
        if ia is None or ib is None or ma == mb:
            return False
        if ia == ib:                       # parallel major/minor
            return True
        if ma == "minor" and mb == "major":
            return (ia + 3) % 12 == ib     # relative
        if ma == "major" and mb == "minor":
            return (ib + 3) % 12 == ia
        return False

    key_ambiguous = bool(margin < float(DEF["key_margin_floor"])) or _related(
        keys[0]["key"], keys[1]["key"])

    # Noise-like content must not yield a confident tempo or key. Withholding is
    # computed from evidence here, never self-reported downstream.
    if noise_like:
        tempo_block: Dict[str, Any] = {
            "withheld": True, "reason": "noise-like content (spectral flatness "
            f"{flat:.3f} > {DEF['flatness_noise_floor']})", "evidence": "measured",
            "raw_estimate": round(tempo, 1),
        }
        key_block: Dict[str, Any] = {
            "withheld": True, "reason": "noise-like content", "evidence": "measured",
            "raw_estimate": keys[0]["key"],
        }
    else:
        tempo_block = {
            "bpm": round(tempo, 1),
            "alternatives": [round(tempo / 2, 1), round(tempo * 2, 1)],
            "note": "half/double ambiguity is inherent; alternatives listed",
            "evidence": "measured",
        }
        key_block = {
            "estimate": keys[0]["key"],
            "corr": round(keys[0]["corr"], 3),
            "runners_up": [{"key": k["key"], "corr": round(k["corr"], 3)} for k in keys[1:]],
            "margin": round(margin, 4),
            "ambiguous": key_ambiguous,
            "evidence": "derived",
        }

    measured = {
        "duration_s": round(dur, 3),
        "loudness": {
            "rms": round(rms, 5), "peak": round(peak, 5),
            "rms_db": round(20 * np.log10(rms + 1e-12), 2),
            "dynamic_range_db": round(float(20 * np.log10((np.percentile(rms_env, 95) + 1e-9) /
                                                          (np.percentile(rms_env, 5) + 1e-9))), 2),
        },
        "tempo": tempo_block,
        "key": key_block,
        "timbre": {
            "spectral_centroid_hz": round(float(np.mean(centroid)), 1),
            "spectral_rolloff_hz": round(float(np.mean(rolloff)), 1),
            "spectral_flatness": round(flat, 5),
            "noise_like": noise_like,
            "note": "flatness near 1 is noise-like, near 0 is tonal",
        },
        "rhythm": {
            "onset_rate_per_s": round(float(len(librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)) / max(dur, 1e-6)), 2),
        },
        "sections": sections,
        "notable_moments": moments,
    }

    notes: List[str] = []
    if noise_like:
        notes.append(
            f"Spectral flatness {flat:.3f} indicates noise-like content with no stable pitch or "
            "pulse. Tempo and key are withheld rather than guessed.")
        notes.append("Do not describe this as music.")
    else:
        if key_block.get("ambiguous"):
            notes.append(
                f"Key is ambiguous: '{keys[0]['key']}' vs '{keys[1]['key']}' "
                f"(margin {margin:.3f}). Do not state a key as fact.")
        if measured["timbre"]["noise_like"]:
            notes.append("Spectral flatness is high; content may be noise-like.")
    if dur < 3.0:
        notes.append("Clip shorter than 3s; tempo and key estimates are unreliable at this length.")

    return {
        "abstain": False,
        "evidence": "measured",
        "sr": sr,
        "rms": rms,
        "measured": measured,
        "confidence_notes": notes,
        "timings_ms": timings,
    }


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def render_dashboard(path: str, out_png: str, sr: int = 22050,
                     label: Optional[str] = None) -> Dict[str, Any]:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import librosa

    t0 = time.perf_counter()
    y, sr = librosa.load(path, sr=sr, mono=True)
    if y.size == 0:
        return {"ok": False, "reason": "empty"}
    n_fft, hop = 2048, 512
    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop))
    S_db = librosa.amplitude_to_db(S, ref=np.max)
    times = librosa.frames_to_time(np.arange(S.shape[1]), sr=sr, hop_length=hop)
    dur = len(y) / sr

    chroma = librosa.feature.chroma_stft(S=S, sr=sr)
    rms_env = librosa.feature.rms(S=S)[0]
    rms_t = librosa.frames_to_time(np.arange(len(rms_env)), sr=sr, hop_length=hop)
    novelty = np.maximum(0.0, np.diff(S_db, axis=1)).mean(axis=0)

    fig, axes = plt.subplots(4, 1, figsize=(14, 9), sharex=True,
                             layout="constrained")
    ax = axes[0]
    img = ax.pcolormesh(times, librosa.fft_frequencies(sr=sr, n_fft=n_fft), S_db,
                        shading="auto", cmap="magma")
    ax.set_yscale("log")
    ax.set_ylim(40, sr / 2)
    ax.set_ylabel("Hz (log)\nlog-mel spectrogram")
    fig.colorbar(img, ax=ax, pad=0.005, format="%d dB")

    ax = axes[1]
    im2 = ax.pcolormesh(times, np.arange(12), chroma, shading="auto", cmap="viridis")
    ax.set_yticks(np.arange(12))
    ax.set_yticklabels(_PC, fontsize=7)
    ax.set_ylabel("pitch class\nchromagram")
    fig.colorbar(im2, ax=ax, pad=0.005)

    ax = axes[2]
    ax.plot(rms_t, rms_env, lw=1.1, color="#c1440e")
    ax.fill_between(rms_t, rms_env, alpha=0.25, color="#c1440e")
    ax.set_ylabel("RMS\nloudness envelope")
    ax.grid(True, alpha=0.25)

    ax = axes[3]
    nt = times[: len(novelty)]
    ax.plot(nt, novelty, lw=1.0, color="#1f6f8b")
    ax.set_ylabel("novelty\n(change)")
    ax.set_xlabel("time (seconds)")
    ax.grid(True, alpha=0.25)

    bounds = _detect_boundaries(novelty, times, dur)
    for a in axes:
        a.set_xlim(0, dur)
        for tick in np.arange(0, dur + 1, max(1.0, round(dur / 20))):
            a.axvline(tick, color="white", alpha=0.10, lw=0.6, zorder=0)
    # Section boundaries drawn across all panels at the same x positions: this is
    # what lets a reader cross-reference harmony, loudness and change at one moment.
    for b in bounds:
        for a in axes:
            a.axvline(b, color="#00d0ff", alpha=0.75, lw=1.1, ls="--", zorder=3)
    axes[0].set_title(
        f"LLooM Hear — {label or os.path.basename(path)}  ({dur:.1f}s)  "
        f"panels share one time axis; {len(bounds)} section boundaries (dashed)",
        fontsize=10)

    fig.savefig(out_png, dpi=110)
    plt.close(fig)
    return {"ok": True, "render_ms": round((time.perf_counter() - t0) * 1000, 1)}


# ---------------------------------------------------------------------------
# Upstream interpretation
# ---------------------------------------------------------------------------

INTERPRET_SYSTEM = (
    "You are the interpretation channel of a hearing tool. A separate local DSP stage "
    "has already measured this audio; you are NOT the measurement stage.\n"
    "Hard rules:\n"
    "  * Never state a tempo, BPM, key, time signature, timestamp, or any number.\n"
    "  * Do not describe section boundaries by time.\n"
    "  * If asked for a measurement, say the measurement channel reports it.\n"
    "Describe what the audio evokes: character, mood, texture, genre reference, "
    "instrumentation by character, energy and its shape, and how it evolves. "
    "Four to eight sentences unless the caller asks for something more specific. "
    "If the audio appears to contain no musical content, say so plainly and stop."
)


async def call_upstream(audio_bytes: bytes, fmt: str, query: str,
                        model: str) -> Dict[str, Any]:
    import urllib.request

    if model in DEF["self_model_ids"]:
        return {"error": "refusing to call self", "text": "", "ms": 0.0}

    b64 = base64.b64encode(audio_bytes).decode()
    user_text = query.strip() or "Describe the character of this audio."
    body = {
        "model": model,
        "temperature": 0.4,
        "max_tokens": 700,
        "messages": [
            {"role": "system", "content": INTERPRET_SYSTEM},
            {"role": "user", "content": [
                {"type": "input_audio", "input_audio": {"data": b64, "format": fmt}},
                {"type": "text", "text": user_text},
            ]},
        ],
    }
    key = os.environ.get(DEF["upstream_key_env"], "") or os.environ.get("LLOOM_API_KEY", "")
    req = urllib.request.Request(
        DEF["upstream_url"], data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 **({"Authorization": f"Bearer {key}"} if key else {})})

    # A redirect here would replay the upstream Authorization header at a host the
    # caller never asked to trust, so the opener refuses to follow one.
    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ARG002
            raise urllib.error.HTTPError(req.full_url, code,
                                         "upstream redirects are not followed", headers, fp)

    opener = urllib.request.build_opener(_NoRedirect)
    loop = asyncio.get_running_loop()
    t0 = time.perf_counter()

    def _do() -> Dict[str, Any]:
        try:
            with opener.open(req, timeout=180) as r:
                raw = r.read(int(DEF["max_upstream_bytes"]) + 1)
                if len(raw) > int(DEF["max_upstream_bytes"]):
                    return {"error": "interpretation response exceeded its limit", "text": ""}
                out = json.loads(raw)
        except Exception:  # noqa: BLE001
            return {"error": "interpretation request failed", "text": ""}
        try:
            msg = out["choices"][0]["message"]
            text = msg.get("content") or ""
            if not isinstance(text, str):
                raise ValueError("invalid content")
            return {"text": text.strip(), "usage": out.get("usage", {})}
        except (KeyError, IndexError, TypeError, ValueError):
            return {"error": "invalid interpretation response", "text": ""}

    res = await loop.run_in_executor(_executor, _do)
    res["ms"] = round((time.perf_counter() - t0) * 1000, 1)
    return res


# ---------------------------------------------------------------------------
# Report assembly
# ---------------------------------------------------------------------------


def _fmt_t(sec: float) -> str:
    return f"{int(sec // 60)}:{sec % 60:04.1f}"


def build_markdown(res: Dict[str, Any]) -> str:
    L: List[str] = []
    src = res["source"]
    L.append(f"# Hearing report — {src['name']}")
    w = src.get("window")
    L.append(f"*duration analysed: {src['analysed_s']:.1f}s"
             + (f" · window {_fmt_t(w[0])}–{_fmt_t(w[1])} of a {src['full_s']:.1f}s source"
                if w else "")
             + "*")
    L.append("")

    d = res["dsp"]
    if d.get("abstain"):
        L.append("## Measured (local DSP)")
        L.append(f"**Abstained: {d.get('reason')}.** "
                 f"{' '.join(d.get('confidence_notes', []))}")
    else:
        m = d["measured"]
        L.append("## Measured (local DSP) — evidence: measured")
        L.append(f"- duration: {m['duration_s']}s")
        L.append(f"- loudness: RMS {m['loudness']['rms']:.4f} "
                 f"({m['loudness']['rms_db']} dBFS), dynamic range "
                 f"{m['loudness']['dynamic_range_db']} dB")
        t = m["tempo"]
        if t.get("withheld"):
            L.append(f"- tempo: **WITHHELD** — {t['reason']} "
                     f"(raw uncalibrated estimate {t.get('raw_estimate')}, not reliable)")
        else:
            L.append(f"- tempo: **{t['bpm']} BPM** (half/double alternatives "
                     f"{t['alternatives'][0]} / {t['alternatives'][1]} — inherent ambiguity)")
        k = m["key"]
        if k.get("withheld"):
            L.append(f"- key: **WITHHELD** — {k['reason']} "
                     f"(raw uncalibrated estimate {k.get('raw_estimate')}, not reliable)")
        else:
            amb = " — **AMBIGUOUS, do not assert**" if k["ambiguous"] else ""
            L.append(f"- key: {k['estimate']} (corr {k['corr']}, margin {k['margin']}){amb}"
                     f"; runners-up {', '.join(r['key'] for r in k['runners_up'])}")
        tb = m["timbre"]
        L.append(f"- timbre: centroid {tb['spectral_centroid_hz']} Hz, "
                 f"flatness {tb['spectral_flatness']} ({tb['note']})")
        L.append(f"- rhythm: {m['rhythm']['onset_rate_per_s']} onsets/s")
        L.append("")
        L.append("### Segments (derived: novelty-delimited change points, "
                 f"min {DEF['min_segment_s']}s)")
        L.append("*Bar-level changes appear here as separate segments; this is not a "
                 "verse/chorus analysis.*")
        for s in m["sections"][:40]:
            L.append(f"- {_fmt_t(s['start'])}–{_fmt_t(s['end'])}  {s['label']} "
                     f"(rel energy {s.get('energy_rel')})")
        if m["notable_moments"]:
            L.append("")
            L.append("### Notable moments (drill-down seeds — use these, do not invent timecodes)")
            for mm in m["notable_moments"]:
                L.append(f"- {_fmt_t(mm['t'])}  {mm['kind']} (magnitude {mm['magnitude']})")
        if d.get("confidence_notes"):
            L.append("")
            L.append("### Confidence notes")
            for n in d["confidence_notes"]:
                L.append(f"- {n}")

    up = res.get("interpretation", {})
    L.append("")
    L.append("## Interpretation — evidence: GENERATED (not measured)")
    if up.get("error"):
        L.append(f"*interpretation channel unavailable: {up['error']}*")
    elif up.get("text"):
        L.append(up["text"])
    else:
        L.append("*no interpretation returned*")

    if res.get("images"):
        L.append("")
        L.append("## Images")
        for i, im in enumerate(res["images"]):
            if im.get("data_uri") and not im.get("embed", False):
                # Reference, do not embed: a 400 KB data URI would swamp the report
                # and every caller that only wants the measurements would pay for it.
                L.append(f"- {im['label']} — available at `hear.images[{i}].data_uri` "
                         f"(image/png, {im.get('bytes', 0) // 1024} KB), "
                         "or request `hear.image_delivery=\"url\"` for a link.")
            else:
                L.append(f"- {im['label']}: ![{im['label']}]({im['url']})")
    return "\n".join(L)


# ---------------------------------------------------------------------------
# Request handling
# ---------------------------------------------------------------------------

AUDIO_PART_TYPES = {"input_audio", "audio_url", "audio"}


def _collect(parts: List[Any]) -> Tuple[Optional[Dict[str, Any]], str]:
    audio: Optional[Dict[str, Any]] = None
    texts: List[str] = []
    for p in parts:
        if isinstance(p, str):
            texts.append(p)
            continue
        if not isinstance(p, dict):
            continue
        t = p.get("type")
        if t == "text":
            if not isinstance(p.get("text", ""), str):
                raise _fail(400, "text content must be a string")
            texts.append(p.get("text", ""))
        elif t == "input_audio":
            ia = p.get("input_audio") or {}
            if isinstance(ia, dict):
                audio = {"data": ia.get("data"), "format": ia.get("format", "mp3")}
        elif t in ("audio_url", "audio"):
            au = p.get("audio_url") or p.get("audio") or {}
            url = au.get("url") if isinstance(au, dict) else au
            fmt = (au.get("format") if isinstance(au, dict) else None) or "mp3"
            if isinstance(url, str) and url.lower().startswith("http"):
                audio = {"url": url, "format": fmt}
            elif isinstance(url, str) and url:
                # A path part is a path whether or not it currently exists; the
                # containment check reports a uniform failure either way.
                audio = {"path": url, "format": fmt}
        elif t == "file" or "file" in p:
            f = p.get("file") or {}
            if isinstance(f, dict):
                if f.get("file_data"):
                    fd = f["file_data"]
                    if isinstance(fd, str) and fd.startswith("data:"):
                        fd = fd.split(",", 1)[1] if "," in fd else ""
                    audio = {"data": fd, "format": f.get("format", "mp3")}
                elif f.get("path"):
                    audio = {"path": f["path"], "format": f.get("format") or "mp3"}
    return audio, "\n".join(x for x in texts if x).strip()


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"status": "ok", "service": "lloom-hear", "version": app.version,
            "upstream_model": DEF["upstream_model"]}


@app.get("/v1/models")
def list_models() -> Dict[str, Any]:
    return {"object": "list", "data": [{
        "id": "hear", "object": "model", "created": 0, "owned_by": "lloom",
        "input": ["text", "audio", "file"], "output": ["text", "image"],
        "capabilities": ["audio-analysis", "music", "dsp", "measurement", "vision-output"],
    }]}


@app.get("/artifacts/{name}")
def artifact(name: str):
    prune_artifacts()
    safe = os.path.basename(name)
    p = os.path.join(DEF["artifact_dir"], safe)
    if not os.path.isfile(p):
        raise HTTPException(404, "not found")
    return FileResponse(p, media_type="image/png")


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    if _request_slots.locked():
        raise _fail(429, "Hear is busy; retry after active analyses finish")
    await _request_slots.acquire()
    task = asyncio.create_task(_chat_completions(request))

    def finished(done):
        _request_slots.release()
        if not done.cancelled():
            done.exception()

    task.add_done_callback(finished)
    # Keep admission and temporary files until executor work actually finishes,
    # even when the ASGI caller is cancelled. Abandoned work stays bounded.
    return await asyncio.shield(task)


def prune_artifacts():
    now = time.time()
    entries = sorted((entry for entry in os.scandir(DEF["artifact_dir"])
                      if re.fullmatch(r"[0-9a-f]{12}-[0-9a-f]{6}\.png", entry.name)
                      and entry.is_file(follow_symlinks=False)),
                     key=lambda entry: entry.stat().st_mtime, reverse=True)
    for index, entry in enumerate(entries):
        if index >= int(DEF["max_artifacts"]) or now - entry.stat().st_mtime > float(DEF["artifact_ttl_seconds"]):
            try:
                os.unlink(entry.path)
            except FileNotFoundError:
                pass


async def _chat_completions(request: Request):
    t_req = time.perf_counter()
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > int(DEF["max_request_bytes"]):
        raise _fail(413, "request body exceeds the configured limit")
    try:
        raw_body = bytearray()
        async for chunk in request.stream():
            if len(raw_body) + len(chunk) > int(DEF["max_request_bytes"]):
                raise _fail(413, "request body exceeds the configured limit")
            raw_body.extend(chunk)
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise _fail(400, "could not read request body") from e
    if len(raw_body) > int(DEF["max_request_bytes"]):
        raise _fail(413, "request body exceeds the configured limit")
    try:
        body = json.loads(raw_body)
    except Exception as e:  # noqa: BLE001
        raise _fail(400, "invalid json body") from e
    if not isinstance(body, dict):
        raise _fail(400, "invalid json body")
    if body.get("response_format") or (isinstance(body.get("lloom"), dict) and body["lloom"].get("outputSchema")):
        raise _fail(400, "schema-constrained output is not supported by Hear")

    if body.get("stream"):
        # This backend returns one JSON completion; a caller asking for SSE would
        # otherwise receive a buffered document on a stream-shaped connection.
        raise _fail(400, "streaming is not supported; omit \"stream\" and read the "
                         "single JSON completion")

    msgs = body.get("messages") or []
    if not isinstance(msgs, list):
        raise _fail(400, "messages must be an array")
    audio: Optional[Dict[str, Any]] = None
    query = ""
    for m in msgs:
        if not isinstance(m, dict):
            continue
        c = m.get("content")
        if isinstance(c, list):
            a, t = _collect(c)
            audio = a or audio
            if t:
                query = t
        elif isinstance(c, str) and m.get("role") == "user":
            query = c

    if audio is None:
        raise HTTPException(400, "no audio content part found "
                                 "(expected input_audio / audio_url / file)")

    directive = body.get("hear") or {}
    if not isinstance(directive, dict):
        raise _fail(400, "hear directive must be an object")

    def _seconds(name: str) -> Optional[float]:
        value = directive.get(name)
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise _fail(400, f"hear.{name} must be a finite number of seconds")
        number = float(value)
        if number != number or number in (float("inf"), float("-inf")):
            raise _fail(400, f"hear.{name} must be a finite number of seconds")
        if number < 0:
            raise _fail(400, f"hear.{name} must be non-negative")
        return number

    max_analysis = float(DEF["max_analysis_seconds"])
    window: Optional[Tuple[float, float]] = None
    start = _seconds("start")
    end = _seconds("end")
    duration = _seconds("duration")
    if start is not None and end is not None:
        window = (start, end)
    elif start is not None and duration is not None:
        window = (start, start + duration)
    elif end is not None or duration is not None:
        raise _fail(400, "hear.end/hear.duration require hear.start")
    if window is not None and window[1] <= window[0]:
        raise _fail(400, "requested window end must be greater than its start")
    if window is None:
        window = parse_window_from_text(query)

    want_interpret = directive.get("interpret", DEFAULT_INTERPRET)
    if not isinstance(want_interpret, bool):
        raise _fail(400, "hear.interpret must be a boolean")
    want_image = directive.get("image", True)
    if not isinstance(want_image, bool):
        raise _fail(400, "hear.image must be a boolean")
    delivery = directive.get("image_delivery", DEF["image_delivery"])
    if delivery not in ALLOWED_IMAGE_DELIVERY:
        raise _fail(400, "hear.image_delivery must be one of inline, url, none")

    # Request-supplied model override is a gateway-loop hazard: the caller could
    # point this backend back at itself or at a lane the operator never chose for
    # audio egress. Only an explicitly configured allowlist is honoured.
    upstream_model = DEF["upstream_model"]
    requested_model = directive.get("model")
    if requested_model is not None:
        if not isinstance(requested_model, str) or not requested_model:
            raise _fail(400, "hear.model must be a non-empty string")
        if requested_model not in ALLOWED_INTERPRET_MODELS:
            raise _fail(403, "hear.model override is not enabled for this interpretation "
                             "model; the operator must list it in "
                             "LLOOM_HEAR_ALLOWED_INTERPRET_MODELS")
        upstream_model = requested_model
    if want_interpret and upstream_model in DEF["self_model_ids"]:
        # Recursion guard: 'hear' and its aliases ('listen' included) are this
        # backend, so an interpretation call that names one would re-enter it.
        raise _fail(400, "refusing to use this backend as its own interpretation model")

    workdir = tempfile.mkdtemp(prefix="lloom-hear-")
    timings: Dict[str, Any] = {}
    try:
        t = time.perf_counter()
        src_path, _ = await _resolve_source(audio, workdir)
        timings["ingest_ms"] = round((time.perf_counter() - t) * 1000, 1)

        t = time.perf_counter()
        full_s = await asyncio.get_running_loop().run_in_executor(
            _executor, _probe_duration, src_path)
        timings["probe_ms"] = round((time.perf_counter() - t) * 1000, 1)

        if window is None and full_s > max_analysis:
            window = (0.0, max_analysis)
        if window is None:
            window = (0.0, full_s)
        # Every path is clamped to max_analysis_seconds, including caller-supplied
        # windows: DSP, image render and the upstream upload all scale with it.
        window = (window[0], min(window[1], window[0] + max_analysis, full_s))
        if window[1] <= window[0]:
            raise _fail(400, "requested window falls outside the analysable range")

        # Segment extraction (fast seek) — done once, feeds DSP, model, and images.
        t = time.perf_counter()
        wav = os.path.join(workdir, "seg.wav")
        start = window[0] if window else None
        dur = (window[1] - window[0]) if window else None
        await asyncio.get_running_loop().run_in_executor(
            _executor, _extract, src_path, start, dur, wav,
            ["-ac", "1", "-ar", "22050", "-f", "wav"])
        model_audio = src_path
        model_fmt = audio.get("format", "mp3")
        if window and (start or (full_s and dur and dur < full_s - 0.05)):
            seg_mp3 = os.path.join(workdir, "seg.mp3")
            await asyncio.get_running_loop().run_in_executor(
                _executor, _extract, src_path, start, dur, seg_mp3,
                ["-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k"])
            model_audio, model_fmt = seg_mp3, "mp3"
        timings["segment_ms"] = round((time.perf_counter() - t) * 1000, 1)

        analysed_s = await asyncio.get_running_loop().run_in_executor(
            _executor, _probe_duration, wav)

        # ---- FAN OUT: DSP and the model call run concurrently --------------
        loop = asyncio.get_running_loop()
        t_fan = time.perf_counter()

        dsp_fut = loop.run_in_executor(_executor, analyse, wav)

        img_fut = None
        if want_image and delivery != "none":
            with open(wav, "rb") as _f:
                wav_head = _f.read(1 << 20)
            art_id = f"{hashlib.sha1(wav_head).hexdigest()[:12]}-{uuid.uuid4().hex[:6]}"
            png = os.path.join(DEF["artifact_dir"], f"{art_id}.png")

            def _render() -> Dict[str, Any]:
                prune_artifacts()
                # Label with the audio part's own format, not a resolved path.
                r = render_dashboard(wav, png, label=f"audio.{model_fmt}")
                r["id"] = art_id
                r["path"] = png
                return r

            async def _guarded_render() -> Dict[str, Any]:
                async with _render_lock:  # matplotlib is not thread-safe
                    return await loop.run_in_executor(_executor, _render)

            img_fut = _guarded_render()

        with open(model_audio, "rb") as f:
            mbytes = f.read()
        up_fut = (call_upstream(mbytes, model_fmt, query, upstream_model)
                  if want_interpret else None)

        futures: List[asyncio.Future] = [asyncio.ensure_future(dsp_fut)]
        slots: List[str] = ["dsp"]
        if img_fut is not None:
            futures.append(asyncio.ensure_future(img_fut))
            slots.append("img")
        if up_fut is not None:
            futures.append(asyncio.ensure_future(up_fut))
            slots.append("up")
        results = await asyncio.gather(*futures, return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException):
                raise result
        by_slot = dict(zip(slots, results))
        dsp = by_slot.get("dsp")
        img = by_slot.get("img")
        up = by_slot.get("up")
        timings["fanout_ms"] = round((time.perf_counter() - t_fan) * 1000, 1)

        images: List[Dict[str, Any]] = []
        if img and img.get("ok"):
            base = str(request.base_url).rstrip("/")
            entry: Dict[str, Any] = {
                "label": "analytic dashboard (spectrogram / chroma / loudness / "
                         "novelty, one shared time axis)",
                "url": f"{base}/artifacts/{img['id']}.png",
                "render_ms": img.get("render_ms"),
            }
            if delivery == "inline":
                with open(img["path"], "rb") as f:
                    entry["data_uri"] = ("data:image/png;base64,"
                                         + base64.b64encode(f.read()).decode())
                entry["bytes"] = os.path.getsize(img["path"])
                os.unlink(img["path"])
                entry.pop("url", None)
            images.append(entry)
        elif img:
            timings["render_error"] = img.get("reason")

        # Computed abstention outranks the model. The interpretation channel has no
        # access to the evidence gate. Discard its description when the signal
        # does not support a musical interpretation.
        non_musical = bool(dsp.get("abstain")) or bool(
            (dsp.get("measured") or {}).get("timbre", {}).get("noise_like"))
        if non_musical:
            why = (dsp.get("reason") if dsp.get("abstain")
                   else "noise-like content with no stable pitch or pulse")
            up = {"text": "", "discarded": True,
                  "reason": f"DSP found non-musical content ({why}); the generated "
                            "description was discarded because it is not grounded in any "
                            "measurable signal.",
                  }

        res = {
            # The source name is the part's own label, never a resolved filesystem
            # path: responses must not disclose where the input lives.
            "source": {"name": f"audio.{model_fmt}", "full_s": round(full_s, 2),
                       "analysed_s": analysed_s, "window": window},
            "dsp": dsp,
            "interpretation": up or {},
            "images": images,
            "trust": {
                "measured": "local DSP (analyse)", "derived": "local DSP (inference from measurement)",
                "generated": "upstream model — may be wrong; never a measurement",
            },
            "timings_ms": timings,
        }
        res["markdown"] = build_markdown(res)
        timings["total_ms"] = round((time.perf_counter() - t_req) * 1000, 1)

        return JSONResponse({
            "id": f"chatcmpl-hear-{uuid.uuid4().hex[:12]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "hear",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": res["markdown"]}}],
            "usage": (up or {}).get("usage", {}),
            "hear": res,
        })
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def _warmup() -> None:
    """Pay the numba JIT, matplotlib font-cache and librosa import costs at boot so
    the first real request does not pay those initialization costs."""
    import soundfile as sf

    sr = 22050
    n = sr * 2
    t = np.arange(n) / sr
    y = (0.3 * np.sin(2 * np.pi * 220 * t) * (1 + 0.5 * np.sin(2 * np.pi * 2 * t))
         ).astype(np.float32)
    p = os.path.join(tempfile.gettempdir(), "lloom-hear-warmup.wav")
    png = os.path.join(tempfile.gettempdir(), "lloom-hear-warmup.png")
    sf.write(p, y, sr)
    try:
        analyse(p)                 # numba JIT for beat/onset/chroma paths
        render_dashboard(p, png)   # matplotlib font cache + Agg backend
    finally:
        for f in (p, png):
            if os.path.exists(f):
                os.remove(f)


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=DEF["host"])
    ap.add_argument("--port", type=int, default=int(DEF["port"]))
    ap.add_argument("--no-warmup", action="store_true")
    a = ap.parse_args()
    if not a.no_warmup:
        t = time.perf_counter()
        try:
            _warmup()
            print(f"warmup complete in {time.perf_counter() - t:.1f}s", flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"warmup failed (continuing): {e}", flush=True)
    uvicorn.run(app, host=a.host, port=a.port, log_level="info")


if __name__ == "__main__":
    main()
