"""Tests for lloom_drama_server: no GPU, engine or network is used."""
from __future__ import annotations

import base64
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import lloom_drama_server as mod

WAV = b"RIFF\x00\x00\x00\x00WAVEfake"
DATA_URL = "data:audio/wav;base64," + base64.b64encode(WAV).decode()
CODES = [[1, 2, 3]] * 10


class FakeEngine(BaseHTTPRequestHandler):
    seen: list[dict] = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        self._send(200, b'{"status": "ok"}', "application/json")

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeEngine.seen.append(body)
        if body["input"] == "refuse":
            self._send(400, b'{"error": "nope"}', "application/json")
        else:
            self._send(200, b"AUDIO", "audio/wav", {"X-Cfg-Gamma": "1.5"})

    def _send(self, status, payload, content_type, headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)


def serve(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


class ReferenceTests(unittest.TestCase):
    def setUp(self):
        self.cache = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.calls = 0

    def encode(self, audio_path, text, out_path):
        self.calls += 1
        self.assertEqual(Path(audio_path).read_bytes(), WAV)
        Path(out_path).write_text(json.dumps({"text": text, "vq_codes": CODES}))

    def test_data_url_is_decoded(self):
        self.assertEqual(mod.decode_reference(DATA_URL), WAV)

    def test_paths_and_urls_are_refused(self):
        for value in ("/etc/passwd", "https://example.com/a.wav", "data:audio/wav,plain", 7):
            with self.assertRaises(mod.BadRequest):
                mod.decode_reference(value)

    def test_reference_is_encoded_once(self):
        first = mod.reference_for(DATA_URL, " hello ", self.cache, self.encode)
        second = mod.reference_for(DATA_URL, "hello", self.cache, self.encode)
        self.assertEqual(first, {"text": "hello", "vq_codes": CODES})
        self.assertEqual(second, first)
        self.assertEqual(self.calls, 1)

    def test_a_new_transcript_is_a_new_reference(self):
        mod.reference_for(DATA_URL, "hello", self.cache, self.encode)
        mod.reference_for(DATA_URL, "goodbye", self.cache, self.encode)
        self.assertEqual(self.calls, 2)

    def test_reference_needs_its_transcript(self):
        with self.assertRaises(mod.BadRequest):
            mod.reference_for(DATA_URL, "  ", self.cache, self.encode)


class EngineBodyTests(unittest.TestCase):
    def test_only_engine_fields_are_forwarded(self):
        body = mod.engine_body(
            {"model": "tts-clone", "input": "hi", "voice": "jinx", "ref_audio": DATA_URL, "ref_text": "x",
             "audio_prompt_path": DATA_URL, "language": "en", "repetition_penalty": 1.05,
             "temperature": 0.9, "stream": True, "response_format": "pcm"},
            {"text": "x", "vq_codes": CODES})
        self.assertEqual(body, {"model": mod.ENGINE_MODEL, "input": "hi", "response_format": "pcm",
                                "stream": True, "temperature": 0.9,
                                "references": [{"text": "x", "vq_codes": CODES}]})

    def test_no_reference_uses_the_builtin_voice(self):
        self.assertEqual(mod.engine_body({"input": "hi"}, None),
                         {"model": mod.ENGINE_MODEL, "input": "hi", "response_format": "wav"})

    def test_bad_requests(self):
        for body in ({}, {"input": ""}, {"input": "hi", "response_format": "mp3"}):
            with self.assertRaises(mod.BadRequest):
                mod.engine_body(body, None)


class ProxyTests(unittest.TestCase):
    def setUp(self):
        FakeEngine.seen = []
        engine = ThreadingHTTPServer(("127.0.0.1", 0), FakeEngine)
        self.addCleanup(lambda: (engine.shutdown(), engine.server_close()))
        cache = Path(self.enterContext(tempfile.TemporaryDirectory()))

        def encode(audio_path, text, out_path):
            Path(out_path).write_text(json.dumps({"text": text, "vq_codes": CODES}))

        shim = mod.make_server("127.0.0.1", 0, serve(engine), cache, encode)
        self.addCleanup(lambda: (shim.shutdown(), shim.server_close()))
        self.url = serve(shim)

    def post(self, body):
        request = urllib.request.Request(self.url + "/v1/audio/speech", json.dumps(body).encode(),
                                         {"Content-Type": "application/json"})
        return urllib.request.urlopen(request, timeout=10)

    def test_health_follows_the_engine(self):
        with urllib.request.urlopen(self.url + "/health", timeout=10) as response:
            self.assertEqual(json.load(response), {"status": "ok"})

    def test_clone_request_reaches_the_engine_as_codes(self):
        with self.post({"input": "hi", "voice": "jinx", "ref_audio": DATA_URL, "ref_text": "words"}) as response:
            self.assertEqual(response.read(), b"AUDIO")
            self.assertEqual(response.headers["Content-Type"], "audio/wav")
            self.assertEqual(response.headers["X-Cfg-Gamma"], "1.5")
        self.assertEqual(FakeEngine.seen[0]["references"], [{"text": "words", "vq_codes": CODES}])
        self.assertNotIn("voice", FakeEngine.seen[0])

    def test_engine_refusal_is_passed_back(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post({"input": "refuse"})
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(json.load(caught.exception), {"error": "nope"})

    def test_bad_request_never_reaches_the_engine(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.post({"input": "hi", "ref_audio": "/etc/passwd", "ref_text": "x"})
        self.assertEqual(caught.exception.code, 400)
        self.assertEqual(FakeEngine.seen, [])


if __name__ == "__main__":
    unittest.main()
