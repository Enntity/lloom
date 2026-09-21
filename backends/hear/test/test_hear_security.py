#!/usr/bin/env python3
"""Focused boundary tests for the LLooM Hear backend.

These import the *real* server module (never a re-implementation) and drive it
through TestClient. Every expensive or hostile edge is mocked: subprocess
(ffmpeg/ffprobe), outbound network, and the DSP fan-out. Nothing here touches
the user's real cache directories or any live service - the cache/artifact
roots are redirected to a temporary directory before the module is imported.

Run with the backend venv:

    python3 -m unittest discover -s backends/hear/test -v
"""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
import wave
from pathlib import Path
from unittest import mock

_TMP_ROOT = tempfile.mkdtemp(prefix="lloom-hear-tests-")
# Configure the cache roots before the module is imported: it reads them at import
# time and would otherwise create directories under the real user home.
os.environ["LLOOM_HEAR_CACHE_DIR"] = os.path.join(_TMP_ROOT, "cache")
os.environ["LLOOM_HEAR_ARTIFACT_DIR"] = os.path.join(_TMP_ROOT, "artifacts")
# Operator gates start closed regardless of the ambient environment.
for _name in ("LLOOM_HEAR_ALLOW_LOCAL_FILES", "LLOOM_HEAR_ALLOW_URL_FETCH",
              "LLOOM_HEAR_ALLOWED_INPUT_DIRS", "LLOOM_HEAR_ALLOWED_INTERPRET_MODELS",
              "LLOOM_HEAR_ALLOW_INTERPRET"):
    os.environ.pop(_name, None)

_SERVER_PATH = Path(__file__).resolve().parents[1] / "lloom_hear_server.py"
_SPEC = importlib.util.spec_from_file_location("lloom_hear_server", _SERVER_PATH)
assert _SPEC and _SPEC.loader
hear = importlib.util.module_from_spec(_SPEC)
sys.modules["lloom_hear_server"] = hear
_SPEC.loader.exec_module(hear)

from fastapi.testclient import TestClient  # noqa: E402


def _silence_wav_bytes(seconds: float = 0.5, sr: int = 22050) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\x00\x00" * int(sr * seconds))
    return buf.getvalue()


def _tone_wav_bytes(seconds: float = 4.0, sr: int = 22050, freq: float = 440.0) -> bytes:
    import numpy as np

    t = np.arange(int(sr * seconds)) / sr
    y = (0.4 * np.sin(2 * np.pi * freq * t) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(y.tobytes())
    return buf.getvalue()


def _wav_duration(path: str) -> float:
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def _probe_stub(path: str) -> float:
    """Stands in for ffprobe: a real one reports a duration only for decodable
    media and fails otherwise, so undecodable input is refused here too."""
    try:
        return _wav_duration(path)
    except Exception as e:  # noqa: BLE001
        raise hear._fail(400, "audio duration is unknown; refusing to process "
                              "unbounded input") from e


def _b64_part(raw: bytes, fmt: str = "wav") -> dict:
    return {"type": "input_audio", "input_audio": {
        "data": base64.b64encode(raw).decode(), "format": fmt}}


def _chat(parts, directive=None, **extra) -> dict:
    body = {"model": "hear", "messages": [{"role": "user", "content": parts}]}
    if directive is not None:
        body["hear"] = directive
    body.update(extra)
    return body


def _fake_dsp_result(**over) -> dict:
    # Mirrors the exact key shape the real `analyse` returns for a tonal input, so
    # the report assembler is exercised rather than bypassed.
    res = {
        "abstain": False,
        "evidence": "measured",
        "sr": 22050,
        "rms": 0.05,
        "measured": {
            "duration_s": 1.0,
            "loudness": {"rms": 0.05, "peak": 0.2, "rms_db": -26.02,
                         "dynamic_range_db": 3.0},
            "tempo": {"bpm": 120.0, "alternatives": [60.0, 240.0],
                      "note": "half/double ambiguity is inherent; alternatives listed",
                      "evidence": "measured"},
            "key": {"estimate": "A minor", "corr": 0.7,
                    "runners_up": [{"key": "C major", "corr": 0.6}],
                    "margin": 0.1, "ambiguous": False, "evidence": "derived"},
            "timbre": {"spectral_centroid_hz": 440.0, "spectral_rolloff_hz": 880.0,
                       "spectral_flatness": 0.01, "noise_like": False,
                       "note": "flatness near 1 is noise-like, near 0 is tonal"},
            "rhythm": {"onset_rate_per_s": 2.0},
            "sections": [{"start": 0.0, "end": 1.0, "energy": 0.05,
                          "energy_rel": 1.0, "label": "high energy"}],
            "notable_moments": [],
        },
        "confidence_notes": [],
        "timings_ms": {},
    }
    res.update(over)
    return res


class _Harness(unittest.TestCase):
    """Shared fixture: real app, mocked subprocess/network/DSP."""

    def setUp(self) -> None:
        self._env_snapshot = {
            "ALLOWED_INPUT_DIRS": list(hear.ALLOWED_INPUT_DIRS),
            "ALLOW_LOCAL_FILES": hear.ALLOW_LOCAL_FILES,
            "ALLOW_URL_FETCH": hear.ALLOW_URL_FETCH,
            "ALLOWED_INTERPRET_MODELS": list(hear.ALLOWED_INTERPRET_MODELS),
            "DEFAULT_INTERPRET": hear.DEFAULT_INTERPRET,
        }
        hear.ALLOWED_INPUT_DIRS = []
        hear.ALLOW_LOCAL_FILES = False
        hear.ALLOW_URL_FETCH = False
        hear.ALLOWED_INTERPRET_MODELS = []
        hear.DEFAULT_INTERPRET = False

        self.work = tempfile.mkdtemp(prefix="hear-test-", dir=_TMP_ROOT)
        self.client = TestClient(hear.app)
        self.calls = []
        self.ffmpeg_args = None

        async def _fake_upstream(audio_bytes, fmt, query, model):
            self.calls.append({"model": model, "fmt": fmt, "query": query,
                               "bytes": len(audio_bytes)})
            return {"text": "a slow minor loop", "usage": {"total_tokens": 12}, "ms": 1.0}

        self._fake_upstream = _fake_upstream
        self._upstream_patch = mock.patch.object(hear, "call_upstream", _fake_upstream)

        def _fake_analyse(path, sr=22050):
            return _fake_dsp_result()

        def _fake_render(path, out_png, sr=22050, label=None):
            with open(out_png, "wb") as f:
                f.write(b"\x89PNG\r\n\x1a\n" + b"0" * 32)
            return {"ok": True, "render_ms": 1.0, "label": label}

        def _fake_ffmpeg(args):
            # Emulate a decode: the last positional arg is the output path. Anything
            # that is not real container data is refused, so "random bytes" fails.
            out = args[-1]
            src = args[args.index("-i") + 1]
            with open(src, "rb") as f:
                head = f.read(4)
            if head not in (b"RIFF", b"OggS", b"ID3\x03"):
                raise hear._fail(400, "audio could not be decoded; unsupported or corrupt input")
            dur = _wav_duration(src) if head == b"RIFF" else 1.0
            if "-t" in args:
                dur = float(args[args.index("-t") + 1])
            with open(out, "wb") as f:
                f.write(_silence_wav_bytes(max(dur, 0.001)))
            self.ffmpeg_args = list(args)

        self._patches = [
            mock.patch.object(hear, "analyse", _fake_analyse),
            mock.patch.object(hear, "render_dashboard", _fake_render),
            mock.patch.object(hear, "_ffmpeg", _fake_ffmpeg),
            mock.patch.object(hear, "_probe_duration", _probe_stub),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()
        hear.ALLOWED_INPUT_DIRS = self._env_snapshot["ALLOWED_INPUT_DIRS"]
        hear.ALLOW_LOCAL_FILES = self._env_snapshot["ALLOW_LOCAL_FILES"]
        hear.ALLOW_URL_FETCH = self._env_snapshot["ALLOW_URL_FETCH"]
        hear.ALLOWED_INTERPRET_MODELS = self._env_snapshot["ALLOWED_INTERPRET_MODELS"]
        hear.DEFAULT_INTERPRET = self._env_snapshot["DEFAULT_INTERPRET"]

    def post(self, body: dict):
        return self.client.post("/v1/chat/completions", json=body)

    def post_raw(self, body: dict):
        """Send bytes directly so non-finite JSON spellings (NaN/Infinity) survive."""
        return self.client.post("/v1/chat/completions", content=json.dumps(body).encode(),
                                headers={"content-type": "application/json"})

    def post_interpret(self, parts, directive):
        """POST with the upstream interpretation call patched in for real dispatch."""
        with self._upstream_patch:
            return self.post(_chat(parts, directive=directive))


class TestLocalPaths(_Harness):
    def test_disabled_by_default_and_does_not_echo_path(self):
        secret = "/etc/passwd-not-audio"
        r = self.post(_chat([{"type": "audio", "audio_url": {"url": secret}}]))
        self.assertEqual(r.status_code, 403)
        self.assertNotIn("passwd", r.text)
        self.assertNotIn("/etc", r.text)

    def test_enabled_dir_refuses_outside_and_symlink_escape(self):
        allowed = os.path.join(self.work, "allowed")
        outside = os.path.join(self.work, "outside")
        os.makedirs(allowed)
        os.makedirs(outside)
        target = os.path.join(outside, "song.wav")
        with open(target, "wb") as f:
            f.write(_silence_wav_bytes())
        link = os.path.join(allowed, "link.wav")
        os.symlink(target, link)
        hear.ALLOW_LOCAL_FILES = True
        hear.ALLOWED_INPUT_DIRS = [os.path.realpath(allowed)]

        r = self.post(_chat([{"type": "audio", "audio_url": {"url": target}}]))
        self.assertEqual(r.status_code, 400)
        self.assertNotIn(outside, r.text)

        r = self.post(_chat([{"type": "audio", "audio_url": {"url": link}}]))
        self.assertEqual(r.status_code, 400)
        self.assertNotIn(outside, r.text)

    def test_contained_path_allowed_and_source_has_no_directory(self):
        allowed = os.path.join(self.work, "allowed")
        os.makedirs(allowed, exist_ok=True)
        good = os.path.join(allowed, "song.wav")
        with open(good, "wb") as f:
            f.write(_silence_wav_bytes())
        hear.ALLOW_LOCAL_FILES = True
        hear.ALLOWED_INPUT_DIRS = [os.path.realpath(allowed)]

        r = self.post(_chat([{"type": "audio", "audio_url": {"url": good}}]))
        self.assertEqual(r.status_code, 200, r.text)
        payload = r.json()
        # A path part carries no format, so the label falls back to the default
        # extension rather than disclosing the real filename or directory.
        self.assertEqual(payload["hear"]["source"]["name"], "audio.mp3")
        self.assertNotIn("song.wav", r.text)
        self.assertNotIn(allowed, r.text)

    def test_missing_file_is_opaque(self):
        allowed = os.path.join(self.work, "allowed")
        os.makedirs(allowed, exist_ok=True)
        hear.ALLOW_LOCAL_FILES = True
        hear.ALLOWED_INPUT_DIRS = [os.path.realpath(allowed)]
        missing = os.path.join(allowed, "nope.wav")
        r = self.post(_chat([{"type": "audio", "audio_url": {"url": missing}}]))
        self.assertEqual(r.status_code, 400)
        self.assertNotIn(missing, r.text)


class TestRemoteUrls(_Harness):
    def test_disabled_by_default(self):
        r = self.post(_chat([{"type": "audio_url",
                              "audio_url": {"url": "https://example.com/a.mp3"}}]))
        self.assertEqual(r.status_code, 403)

    def test_url_validation_matrix(self):
        hear.ALLOW_URL_FETCH = True
        rejected = [
            "http://example.com/a.mp3",
            "ftp://example.com/a.mp3",
            "file:///etc/passwd",
            "https://user:pw@example.com/a.mp3",
            "https://user@example.com/a.mp3",
            "https://127.0.0.1/a.mp3",
            "https://10.0.0.5/a.mp3",
            "https://192.168.1.10/a.mp3",
            "https://169.254.169.254/latest/meta-data/",
            "https://0.0.0.0/a.mp3",
            "https://[::1]/a.mp3",
            "https://[::ffff:127.0.0.1]/a.mp3",
            "https://[fe80::1]/a.mp3",
            "",
            "not a url",
        ]
        for url in rejected:
            with self.subTest(url=url):
                with self.assertRaises(hear.HTTPException) as ctx:
                    hear.validate_remote_url(url)
                self.assertIn(ctx.exception.status_code, (400, 403))

    def test_dns_rebinding_to_private_is_refused(self):
        hear.ALLOW_URL_FETCH = True
        fake = [(2, 1, 6, "", ("10.1.2.3", 443))]
        with mock.patch.object(hear.socket, "getaddrinfo", lambda *a, **k: fake):
            with self.assertRaises(hear.HTTPException) as ctx:
                hear.validate_remote_url("https://internal.example/a.wav")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertNotIn("10.1.2.3", str(ctx.exception.detail))

    def test_public_host_allowed_and_dns_failure_is_opaque(self):
        hear.ALLOW_URL_FETCH = True
        public = lambda *a, **k: [(2, 1, 6, "", ("93.184.216.34", 443))]  # noqa: E731
        with mock.patch.object(hear.socket, "getaddrinfo", public):
            self.assertEqual(hear.validate_remote_url("https://example.com/a.wav"),
                             "https://example.com/a.wav")
        with mock.patch.object(hear.socket, "getaddrinfo",
                               side_effect=OSError("dns boom")):
            with self.assertRaises(hear.HTTPException) as ctx:
                hear.validate_remote_url("https://example.com/a.wav")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertNotIn("dns boom", str(ctx.exception.detail))

    def test_download_is_bounded(self):
        class _Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        class _Opener:
            def open(self, url, timeout=None):  # noqa: ARG002
                return _Resp(b"A" * 4096)

        dest = os.path.join(self.work, "dl.bin")
        with mock.patch.object(hear.urllib.request, "build_opener",
                               lambda *h, **k: _Opener()):
            with self.assertRaises(hear.HTTPException) as ctx:
                hear._download_url("https://example.com/a.wav", dest, 1024)
        self.assertEqual(ctx.exception.status_code, 413)

    def test_empty_download_refused(self):
        class _Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        class _Opener:
            def open(self, url, timeout=None):  # noqa: ARG002
                return _Resp(b"")

        dest = os.path.join(self.work, "dl2.bin")
        with mock.patch.object(hear.urllib.request, "build_opener",
                               lambda *h, **k: _Opener()):
            with self.assertRaises(hear.HTTPException) as ctx:
                hear._download_url("https://example.com/a.wav", dest, 1 << 20)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_download_opener_refuses_redirect(self):
        built = {}

        class _Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        class _Opener:
            def open(self, url, timeout=None):  # noqa: ARG002
                return _Resp(b"RIFF")

        def _build(*handlers, **kw):
            built["handlers"] = handlers
            return _Opener()

        with mock.patch.object(hear.urllib.request, "build_opener", _build):
            hear._download_url("https://example.com/a.wav",
                               os.path.join(self.work, "dl3.bin"), 10)
        handlers = built["handlers"]
        self.assertTrue(handlers, "download must install an explicit handler")
        no_redirect = next(h for h in handlers if isinstance(h, type)
                           and issubclass(h, urllib.request.HTTPRedirectHandler))
        self.assertTrue(issubclass(no_redirect, urllib.request.HTTPRedirectHandler))
        self.assertIsNot(no_redirect.redirect_request,
                         urllib.request.HTTPRedirectHandler.redirect_request)
        self.assertEqual(no_redirect.__name__, "_NoRedirect")
        req = urllib.request.Request("https://example.com/a.wav")
        with self.assertRaises(urllib.error.HTTPError):
            no_redirect().redirect_request(req, None, 302, "Found", {},
                                           "https://evil.test/")


class TestFormatAndSizes(_Harness):
    def test_format_allowlist(self):
        for bad in ["wav/../../etc/passwd", "wav\x00", "exe", "a" * 40,
                    "mp3;rm -rf /", "snd", ".", "  "]:
            with self.subTest(fmt=bad):
                with self.assertRaises(hear.HTTPException):
                    hear.validate_audio_format(bad)
        # Only an absent/empty value falls back to the documented default.
        self.assertEqual(hear.validate_audio_format(""), "mp3")
        self.assertEqual(hear.validate_audio_format(None), "mp3")
        for good in ["wav", ".WAV", "Mp3", "flac", "m4a", "ogg"]:
            self.assertIn(hear.validate_audio_format(good), hear.AUDIO_EXTENSIONS)
        for weird in [123, ["wav"], {"f": "wav"}]:
            with self.assertRaises(hear.HTTPException):
                hear.validate_audio_format(weird)

    def test_format_is_used_only_after_allowlist(self):
        r = self.post(_chat([{"type": "input_audio", "input_audio": {
            "data": base64.b64encode(_silence_wav_bytes()).decode(),
            "format": "../evil"}}]))
        self.assertEqual(r.status_code, 400)
        self.assertNotIn("evil", r.text)

    def test_oversized_request_rejected(self):
        with mock.patch.dict(hear.DEF, {"max_request_bytes": 512}):
            r = self.post(_chat([{"type": "text", "text": "A" * 1024}]))
        self.assertEqual(r.status_code, 413)

    def test_oversized_inline_audio_rejected(self):
        raw = _silence_wav_bytes(1.0)
        with mock.patch.dict(hear.DEF, {"max_input_bytes": len(raw) // 2}):
            r = self.post(_chat([_b64_part(raw)]))
        self.assertEqual(r.status_code, 413)

    def test_empty_non_audio_and_bad_base64(self):
        r = self.post(_chat([{"type": "input_audio",
                              "input_audio": {"data": "", "format": "wav"}}]))
        self.assertEqual(r.status_code, 400)

        r = self.post(_chat([_b64_part(os.urandom(2048))]))
        self.assertEqual(r.status_code, 400)
        self.assertNotIn("lloom-hear-", r.text)
        self.assertNotIn("/var/", r.text)
        self.assertNotIn("/tmp", r.text)

        r = self.post(_chat([{"type": "input_audio", "input_audio": {
            "data": "!!!not base64!!!", "format": "wav"}}]))
        self.assertEqual(r.status_code, 400)

    def test_missing_audio_part(self):
        r = self.post(_chat([{"type": "text", "text": "hello"}]))
        self.assertEqual(r.status_code, 400)

    def test_hear_directive_shape(self):
        body = _chat([_b64_part(_silence_wav_bytes())])
        body["hear"] = [1, 2, 3]
        self.assertEqual(self.post(body).status_code, 400)


class TestWindows(_Harness):
    def test_invalid_seconds_shapes(self):
        for directive in [
            {"start": -1.0},
            {"start": float("nan")},
            {"start": float("inf")},
            {"start": "0.5"},
            {"start": True},
            {"end": 5.0},
            {"duration": 5.0},
            {"start": 5.0, "end": 2.0},
            {"start": 5.0, "end": 5.0},
        ]:
            with self.subTest(directive=directive):
                # Raw bytes: httpx/JSON reject NaN and Infinity literals before they
                # reach the server, and the server must reject them too.
                r = self.post_raw(_chat([_b64_part(_tone_wav_bytes(2.0))],
                                        directive=directive))
                self.assertEqual(r.status_code, 400, r.text)

    def test_window_is_clamped_to_max_analysis_seconds(self):
        with mock.patch.dict(hear.DEF, {"max_analysis_seconds": 1.0}):
            r = self.post(_chat([_b64_part(_tone_wav_bytes(4.0))],
                                directive={"start": 0.5, "end": 3.0}))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["hear"]["source"]["window"], [0.5, 1.5])
        dur = float(self.ffmpeg_args[self.ffmpeg_args.index("-t") + 1])
        self.assertAlmostEqual(dur, 1.0, places=3)

    def test_later_window_is_allowed_with_bounded_duration(self):
        with mock.patch.dict(hear.DEF, {"max_analysis_seconds": 1.0}):
            r = self.post(_chat([_b64_part(_tone_wav_bytes(4.0))],
                                directive={"start": 2.0, "end": 3.0}))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["hear"]["source"]["window"], [2.0, 3.0])

    def test_window_from_query_text_is_clamped_too(self):
        parts = [_b64_part(_tone_wav_bytes(4.0)),
                 {"type": "text", "text": "from 0:00.5 to 0:30"}]
        with mock.patch.dict(hear.DEF, {"max_analysis_seconds": 2.0}):
            r = self.post(_chat(parts))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["hear"]["source"]["window"], [0.5, 2.5])


class TestInterpretation(_Harness):
    def test_default_is_dsp_only_no_upstream_call(self):
        r = self.post(_chat([_b64_part(_tone_wav_bytes(1.0))], directive={"image": False}))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.calls, [])
        self.assertEqual(r.json()["hear"]["interpretation"], {})

    def test_explicit_interpret_true_calls_upstream(self):
        r = self.post_interpret([_b64_part(_tone_wav_bytes(1.0))],
                                {"interpret": True, "image": False})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["model"], hear.DEF["upstream_model"])
        self.assertEqual(r.json()["hear"]["interpretation"]["text"], "a slow minor loop")

    def test_interpret_must_be_boolean(self):
        r = self.post(_chat([_b64_part(_tone_wav_bytes(1.0))],
                            directive={"interpret": "yes"}))
        self.assertEqual(r.status_code, 400)

    def test_model_override_refused_unless_allowlisted(self):
        parts = [_b64_part(_tone_wav_bytes(1.0))]
        r = self.post(_chat(parts, directive={"interpret": True, "model": "some/other-lane"}))
        self.assertEqual(r.status_code, 403)
        self.assertEqual(self.calls, [])

        hear.ALLOWED_INTERPRET_MODELS = ["Qwen/Qwen3-Omni-30B-A3B"]
        r = self.post_interpret(parts, {"interpret": True,
                                        "model": "Qwen/Qwen3-Omni-30B-A3B"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.calls[0]["model"], "Qwen/Qwen3-Omni-30B-A3B")

    def test_recursion_guard_covers_aliases(self):
        for name in ["hear", "listen", "lloom-hear", "local/hear"]:
            with self.subTest(model=name):
                hear.ALLOWED_INTERPRET_MODELS = [name]
                r = self.post(_chat([_b64_part(_tone_wav_bytes(1.0))],
                                    directive={"interpret": True, "model": name}))
                self.assertEqual(r.status_code, 400)
        self.assertEqual(self.calls, [])

    def test_default_upstream_model_never_self_calls(self):
        # Even with the upstream default pointed at an alias, the call_upstream
        # entry point refuses without touching the network.
        import asyncio
        for name in ["hear", "listen", "lloom-hear"]:
            with self.subTest(name=name):
                out = asyncio.run(hear.call_upstream(b"RIFF", "wav", "q", name))
                self.assertIn("error", out)
                self.assertEqual(out.get("text"), "")

    def test_interpreter_text_discarded_on_dsp_abstain(self):
        with mock.patch.object(hear, "analyse",
                               lambda p, sr=22050: _fake_dsp_result(abstain=True,
                                                                    reason="silence")):
            r = self.post_interpret([_b64_part(_tone_wav_bytes(1.0))],
                                    {"interpret": True, "image": False})
        self.assertEqual(r.status_code, 200, r.text)
        up = r.json()["hear"]["interpretation"]
        self.assertTrue(up.get("discarded"))
        self.assertEqual(up.get("text"), "")

    def test_image_delivery_enum(self):
        r = self.post(_chat([_b64_part(_tone_wav_bytes(1.0))],
                            directive={"image_delivery": "ftp"}))
        self.assertEqual(r.status_code, 400)

    def test_image_false_skips_render(self):
        r = self.post(_chat([_b64_part(_tone_wav_bytes(1.0))], directive={"image": False}))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["hear"]["images"], [])


class TestUpstreamRedirects(_Harness):
    def test_upstream_opener_refuses_redirects_with_authorization(self):
        import asyncio

        captured = {}

        class _Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        class _Opener:
            def open(self, req, timeout=None):  # noqa: ARG002
                captured["req"] = req
                return _Resp(json.dumps(
                    {"choices": [{"message": {"content": "ok"}}]}).encode())

        def _build(*handlers, **kw):
            captured["handlers"] = handlers
            return _Opener()

        os.environ["LLOOM_HEAR_UPSTREAM_KEY"] = "test-only-key"
        try:
            with mock.patch.object(hear.urllib.request, "build_opener", _build):
                out = asyncio.run(hear.call_upstream(b"RIFF", "wav", "q", "some/model"))
        finally:
            os.environ.pop("LLOOM_HEAR_UPSTREAM_KEY", None)
        self.assertEqual(out.get("text"), "ok")
        self.assertEqual(captured["req"].get_header("Authorization"),
                         "Bearer test-only-key")
        handlers = captured["handlers"]
        self.assertTrue(handlers, "upstream must install an explicit handler")
        no_redirect = handlers[0]
        self.assertTrue(issubclass(no_redirect, urllib.request.HTTPRedirectHandler))
        self.assertIsNot(no_redirect.redirect_request,
                         urllib.request.HTTPRedirectHandler.redirect_request)
        with self.assertRaises(urllib.error.HTTPError):
            no_redirect().redirect_request(captured["req"], None, 307, "Temporary",
                                           {}, "https://elsewhere.test/v1")


class TestStreamingAndBody(_Harness):
    def test_stream_true_rejected_before_processing(self):
        r = self.post(_chat([_b64_part(_tone_wav_bytes(1.0))], stream=True))
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.calls, [])
        self.assertIsNone(self.ffmpeg_args)

    def test_invalid_json_and_non_object_body(self):
        for raw in (b"{not json", b"[1,2,3]", b'"str"'):
            with self.subTest(raw=raw):
                r = self.client.post("/v1/chat/completions", content=raw,
                                     headers={"content-type": "application/json"})
                self.assertEqual(r.status_code, 400)

    def test_health_and_models(self):
        self.assertEqual(self.client.get("/health").json()["service"], "lloom-hear")
        ids = [m["id"] for m in self.client.get("/v1/models").json()["data"]]
        self.assertEqual(ids, ["hear"])

    def test_artifact_traversal_is_not_served(self):
        r = self.client.get("/artifacts/..%2f..%2fetc%2fpasswd")
        self.assertIn(r.status_code, (400, 404))


class TestRealDspCanary(unittest.TestCase):
    """Unmocked DSP over synthetic audio: the abstention gate must still fire."""

    def test_silence_abstains_and_tone_does_not(self):
        import numpy as np
        import soundfile as sf

        sr = 22050
        silence = os.path.join(_TMP_ROOT, "canary-silence.wav")
        sf.write(silence, np.zeros(sr, dtype="float32"), sr, subtype="PCM_16")
        res = hear.analyse(silence)
        self.assertTrue(res.get("abstain"))
        self.assertEqual(res.get("reason"), "silence")

        t = np.arange(sr * 4) / sr
        tone = 0.4 * np.sin(2 * np.pi * 220.0 * t) + 0.2 * np.sin(2 * np.pi * 330.0 * t)
        path = os.path.join(_TMP_ROOT, "canary-tone.wav")
        sf.write(path, tone.astype("float32"), sr, subtype="PCM_16")
        res = hear.analyse(path)
        self.assertFalse(res.get("abstain"))
        self.assertIn("key", res["measured"])
        self.assertEqual(res["measured"]["duration_s"], 4.0)


class TestFinalBoundaries(unittest.TestCase):
    def test_abandoned_requests_keep_admission_until_work_finishes(self):
        import asyncio

        async def exercise():
            started = asyncio.Event()
            release = asyncio.Event()
            count = 0

            async def work(request):
                nonlocal count
                count += 1
                if count == 2:
                    started.set()
                await release.wait()
                return "done"

            with mock.patch.object(hear, "_chat_completions", work), \
                 mock.patch.object(hear, "_request_slots", asyncio.BoundedSemaphore(2)):
                callers = [asyncio.create_task(hear.chat_completions(None)) for _ in range(2)]
                await started.wait()
                for caller in callers:
                    caller.cancel()
                await asyncio.gather(*callers, return_exceptions=True)
                with self.assertRaises(hear.HTTPException) as ctx:
                    await hear.chat_completions(None)
                self.assertEqual(ctx.exception.status_code, 429)
                release.set()
                for _ in range(5):
                    await asyncio.sleep(0)
                self.assertEqual(await hear.chat_completions(None), "done")
        asyncio.run(exercise())

    def test_artifact_quota_and_expiry(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.dict(hear.DEF, {"artifact_dir": directory, "max_artifacts": 2, "artifact_ttl_seconds": 60}):
            import time
            for index in range(4):
                p = Path(directory) / (f"{index:012x}-{index:06x}.png")
                p.write_bytes(b"image")
                os.utime(p, (time.time() - index, time.time() - index))
            hear.prune_artifacts()
            self.assertEqual(len(list(Path(directory).iterdir())), 2)
            with mock.patch.dict(hear.DEF, {"artifact_ttl_seconds": -1}):
                hear.prune_artifacts()
            self.assertFalse(list(Path(directory).iterdir()))

    def test_schema_bound_requests_are_rejected(self):
        with TestClient(hear.app) as client:
            for extra in [{"response_format": {"type": "json_object"}}, {"lloom": {"outputSchema": {"type": "object"}}}]:
                r = client.post("/v1/chat/completions", json=_chat([_b64_part(_silence_wav_bytes())], **extra))
                self.assertEqual(r.status_code, 400)

    def test_upstream_response_limit(self):
        import asyncio
        class Opener:
            def open(self, *args, **kwargs):
                return io.BytesIO(b"x" * 100)
        with mock.patch.object(hear.urllib.request, "build_opener", return_value=Opener()), \
             mock.patch.dict(hear.DEF, {"max_upstream_bytes": 10}):
            result = asyncio.run(hear.call_upstream(b"audio", "wav", "describe", "example/model"))
        self.assertIn("exceeded", result["error"])

    def test_chunked_request_is_stopped_before_reading_the_rest(self):
        import asyncio

        class Request:
            headers = {}
            consumed = 0

            async def stream(self):
                for chunk in [b"{" * 8, b"x" * 8, b"never read"]:
                    self.consumed += 1
                    yield chunk

        request = Request()
        with mock.patch.dict(hear.DEF, {"max_request_bytes": 10}):
            with self.assertRaises(hear.HTTPException) as ctx:
                asyncio.run(hear.chat_completions(request))
        self.assertEqual(ctx.exception.status_code, 413)
        self.assertEqual(request.consumed, 2)

    def test_url_connect_rechecks_dns_without_an_unvalidated_lookup(self):
        import asyncio
        import socket

        public = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
        private = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]

        def connect(connection):
            connection._create_connection((connection.host, connection.port), 1)

        def open_connection(handler, connection_type, request, **kwargs):
            connection_type(request.host).connect()

        loop = asyncio.new_event_loop()
        self.addCleanup(loop.close)
        with mock.patch.object(hear, "ALLOW_URL_FETCH", True), \
             mock.patch.object(hear.socket, "getaddrinfo", side_effect=[public, private]) as dns, \
             mock.patch.object(hear.http.client.HTTPSConnection, "connect", connect), \
             mock.patch.object(hear.urllib.request.HTTPSHandler, "do_open", open_connection), \
             mock.patch.object(hear.socket, "socket") as sock:
            with self.assertRaises(hear.HTTPException) as ctx:
                loop.run_until_complete(hear._fetch_remote("https://example.com/audio.wav", os.path.join(_TMP_ROOT, "never.wav")))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(dns.call_count, 2)
        sock.assert_not_called()
        self.assertFalse(hear._address_allowed("100.64.0.1"))

    def test_real_inline_silence_pipeline_and_playlist_rejection(self):
        import shutil
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            self.skipTest("ffmpeg and ffprobe required")
        with TestClient(hear.app) as client:
            r = client.post("/v1/chat/completions", json=_chat(
                [_b64_part(_silence_wav_bytes())], {"image": False, "interpret": False}))
            self.assertEqual(r.status_code, 200, r.text)
            self.assertTrue(r.json()["hear"]["dsp"]["abstain"])
            # A disguised playlist must not make ffprobe/ffmpeg open references.
            playlist = b"#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfile:///etc/passwd\n"
            r = client.post("/v1/chat/completions", json=_chat(
                [_b64_part(playlist)], {"image": False, "interpret": False}))
            self.assertEqual(r.status_code, 400, r.text)

    def test_malformed_text_and_string_url_are_client_errors(self):
        with TestClient(hear.app) as client:
            r = client.post("/v1/chat/completions", json=_chat(
                [_b64_part(_silence_wav_bytes()), {"type": "text", "text": 42}]))
            self.assertEqual(r.status_code, 400)
            r = client.post("/v1/chat/completions", json=_chat(
                [{"type": "audio_url", "audio_url": "https://example.com/audio.wav"}]))
            self.assertEqual(r.status_code, 403)


if __name__ == "__main__":
    unittest.main(verbosity=2)
