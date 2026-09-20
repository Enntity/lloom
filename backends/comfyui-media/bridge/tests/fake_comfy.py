"""An in-process fake ComfyUI ASGI app driven through httpx MockTransport."""

from __future__ import annotations

import asyncio
import json
import time

import httpx


class FakeComfy:
    """Behaves like the subset of ComfyUI the bridge is allowed to use."""

    def __init__(
        self,
        *,
        ready: bool = True,
        artifact: bytes = b"\x00\x00\x00\x18ftypmp42-video-bytes",
        fail_job: bool = False,
    ):
        self.ready = ready
        self.artifact = artifact
        self.fail_job = fail_job
        self.prompts: dict[str, dict] = {}
        self.histories: dict[str, dict] = {}
        self.queued: list[str] = []
        self.running: list[str] = []
        self.deleted: list[str] = []
        self.interrupts = 0
        self.uploaded: list[tuple[str, bytes, str]] = []
        self.view_requests: list[dict] = []
        self.job_state = "pending"  # pending -> running -> done
        self.terminal = asyncio.Event()
        self.submitted = asyncio.Event()
        # ``None`` means "derive from the artifact bytes" so an audio artifact
        # yields a RIFF/WAVE reference and a video artifact an MP4 one, exactly
        # as the real save nodes would. Tests may still set an explicit item to
        # exercise hostile/pathological history references.
        self.artifact_item: dict | None = None
        self.history_failures = 0
        self.view_path: str | None = None

    # -- fake ComfyUI routes ----------------------------------------------

    async def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/system_stats":
            if not self.ready:
                return httpx.Response(503, json={"error": "not ready"})
            return httpx.Response(200, json={"system": {"comfyui_version": "test"}, "devices": []})
        if path == "/upload/image":
            body = request.read()
            content_type = request.headers.get("content-type", "")
            name = _multipart_filename(body, content_type) or "upload.png"
            payload = _multipart_file(body, content_type)
            self.uploaded.append((name, payload, content_type))
            return httpx.Response(200, json={"name": name, "subfolder": "", "type": "input"})
        if path == "/prompt":
            payload = json.loads(request.read())
            # The pinned server honours a caller-supplied canonical UUID as the
            # history key; only mint one when the caller omitted it.
            prompt_id = payload.get("prompt_id") or f"pid-{len(self.prompts) + 1}"
            self.prompts[prompt_id] = payload
            self.queued.append(prompt_id)
            self.job_state = "running"
            self.running.append(prompt_id)
            self.submitted.set()
            return httpx.Response(200, json={"prompt_id": prompt_id, "number": 1, "node_errors": {}})
        if path.startswith("/history/"):
            if self.history_failures > 0:
                self.history_failures -= 1
                return httpx.Response(500, json={"error": "boom"})
            prompt_id = path.rsplit("/", 1)[-1]
            if self.job_state == "running":
                return httpx.Response(200, json={})
            if self.job_state == "done":
                entry = self.histories.get(prompt_id) or self._finish(prompt_id)
                return httpx.Response(200, json={prompt_id: entry})
            return httpx.Response(200, json={})
        if path == "/view":
            params = dict(request.url.params)
            self.view_requests.append(params)
            if self.view_path is not None:
                return httpx.Response(404)
            return httpx.Response(200, content=self.artifact, headers={"content-type": "video/mp4"})
        if path == "/queue":
            if request.method == "GET":
                # Pinned server shape: queue_running/queue_pending lists of the
                # raw queue tuples ``(number, prompt_id, ...)``.
                return httpx.Response(
                    200,
                    json={
                        "queue_running": [[1, p] for p in self.running],
                        "queue_pending": [[2, p] for p in self.queued if p not in self.running],
                    },
                )
            payload = json.loads(request.read() or b"{}")
            for prompt_id in payload.get("delete", []):
                self.deleted.append(prompt_id)
                if prompt_id in self.queued:
                    self.queued.remove(prompt_id)
            # The pinned server returns an empty 200 body from POST /queue.
            return httpx.Response(200)
        if path == "/interrupt":
            self.interrupts += 1
            self.running.clear()
            self.job_state = "done"
            self.terminal.set()
            return httpx.Response(200, json={})
        return httpx.Response(404, json={"error": "not found"})

    # -- test-side controls -----------------------------------------------

    def finish(self, *, error: bool = False) -> None:
        prompt_id = self.queued[0] if self.queued else (self.running[0] if self.running else "pid-1")
        self._finish(prompt_id, error=error)
        self.job_state = "done"
        self.running.clear()
        self.terminal.set()

    def _finish(self, prompt_id: str, *, error: bool = False) -> dict:
        if error or self.fail_job:
            entry = {
                "status": {"status_str": "error", "completed": False, "messages": [["execution_error", {}]]},
                "outputs": {},
            }
        else:
            item, key = self._output_ref()
            entry = {
                "status": {"status_str": "success", "completed": True, "messages": []},
                "outputs": {"9": {key: [item]}},
            }
        self.histories[prompt_id] = entry
        return entry

    def _output_ref(self) -> tuple[dict, str]:
        """Return the (reference, output-key) the declared node would publish."""
        if self.artifact_item is not None:
            item = self.artifact_item
            name = str(item.get("filename", ""))
            if name.lower().endswith(".wav"):
                return item, "audio"
            return item, "images"
        if self.artifact[:4] == b"RIFF":
            return {"filename": "lloom_00001.wav", "subfolder": "", "type": "output"}, "audio"
        return {"filename": "lloom_00001.mp4", "subfolder": "lloom", "type": "output"}, "images"

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


def make_client(fake: FakeComfy, base_url: str = "http://127.0.0.1:8188") -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=base_url, transport=fake.transport())


def _multipart_parts(body: bytes, content_type: str) -> list[tuple[bytes, bytes]]:
    marker = "boundary="
    if marker not in content_type:
        return []
    boundary = content_type.split(marker, 1)[1].strip().strip('"')
    sep = b"--" + boundary.encode()
    return [chunk for chunk in body.split(sep) if b"\r\n\r\n" in chunk]


def _multipart_filename(body: bytes, content_type: str) -> str | None:
    for part in _multipart_parts(body, content_type):
        head = part.split(b"\r\n\r\n", 1)[0]
        if b'name="image"' in head and b"filename=" in head:
            marker = b"filename="
            after = head.split(marker, 1)[1]
            value = after.split(b"\r\n", 1)[0].strip().strip(b'"')
            return value.decode("utf-8", "replace")
    return None


def _multipart_file(body: bytes, content_type: str) -> bytes:
    for part in _multipart_parts(body, content_type):
        head, _, payload = part.partition(b"\r\n\r\n")
        if b'name="image"' in head and b"filename=" in head:
            return payload.rstrip(b"\r\n")
    return b""


def audio_graph_builder(kind: str = "audio"):
    """Stand-in for ../graphs/graphs.py."""

    def build_graph(model_id, payload, image_filename=None, prefix="lloom"):
        return ({"1": {"class_type": "Test", "inputs": {model_id: 1}}}, "9", kind)

    return build_graph
