"""Minimal HTTP client for the fixed local ComfyUI service."""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from urllib.parse import urlsplit
from typing import Any

import httpx

from errors import backend_error, backend_unavailable

log = logging.getLogger("bridge.comfy")

# Server-side ceilings. Callers cannot influence any of these.
MAX_ARTIFACT_BYTES = 200 * 1024 * 1024  # 200 MiB
MAX_UPLOAD_BYTES = 32 * 1024 * 1024

# Filename/subfolder reference bounds (server-side, not caller controlled).
MAX_REF_LENGTH = 255
MAX_SUBFOLDER_LENGTH = 1024

# Loopback hosts the fixed ComfyUI endpoint may use. The endpoint is pinned on
# the CLI/env only; nothing a request supplies can retarget it.
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def validate_comfy_base_url(base_url: str) -> str:
    """Return the normalized base URL or raise ``ValueError``.

    Only plain HTTP to a loopback host is allowed, with no userinfo, query,
    fragment or path. This pins the backend so a mis-set env var or CLI flag
    cannot silently point the bridge at a remote or credentialed endpoint.
    """
    if not isinstance(base_url, str) or not base_url:
        raise ValueError("ComfyUI base URL must be a non-empty string")
    try:
        parts = urlsplit(base_url)
    except ValueError as exc:  # pragma: no cover - malformed URL
        raise ValueError("ComfyUI base URL is not a valid URL") from exc
    if parts.scheme != "http":
        raise ValueError("ComfyUI base URL must use plain http")
    if parts.username or parts.password:
        raise ValueError("ComfyUI base URL must not contain credentials")
    if parts.query or parts.fragment:
        raise ValueError("ComfyUI base URL must not contain a query or fragment")
    if parts.path not in ("", "/"):
        raise ValueError("ComfyUI base URL must not contain a path")
    host = (parts.hostname or "").lower()
    if host not in _LOOPBACK_HOSTS:
        raise ValueError("ComfyUI base URL must be a loopback address")
    if parts.port is None:
        raise ValueError("ComfyUI base URL must include an explicit port")
    return f"http://{parts.netloc}"


class ComfyClient:
    """Talks to one fixed ComfyUI endpoint supplied on the CLI only."""

    def __init__(
        self,
        base_url: str,
        *,
        client: httpx.AsyncClient | None = None,
        poll_interval: float = 1.0,
        # A long generation can outlast a fixed timer: MiniMax-H3 at 15s is 362
        # frames at ~30 s/step for 20 steps, roughly half an hour, and the GPU is
        # still working when a 15-minute poll would abandon it. The ceiling is
        # configurable so a long-duration request is not reported as a backend
        # failure while the job is healthy.
        poll_timeout: float = float(os.environ.get("LLOOM_MEDIA_POLL_TIMEOUT", "3600")),
        instance_id: str | None = None,
    ):
        self.base_url = validate_comfy_base_url(base_url)
        self._client = client
        self._owns_client = client is None
        self.poll_interval = poll_interval
        self.poll_timeout = poll_timeout
        # Identifies prompt ids we submitted, for safe /queue cancellation.
        self.instance_id = instance_id or uuid.uuid4().hex
        self._cancelled = False

    async def start(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self.base_url, timeout=httpx.Timeout(30.0, read=300.0))

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            raise backend_unavailable("Media backend client is not running.")
        return self._client

    # -- readiness ---------------------------------------------------------

    async def system_stats(self) -> dict:
        try:
            resp = await self.client.get("/system_stats")
        except httpx.HTTPError:
            raise backend_unavailable()
        if resp.status_code != 200:
            raise backend_unavailable()
        try:
            return resp.json()
        except ValueError:
            raise backend_unavailable()

    async def wait_until_ready(self, attempts: int = 60, delay: float = 2.0) -> bool:
        for _ in range(attempts):
            try:
                await self.system_stats()
                return True
            except Exception:
                await asyncio.sleep(delay)
        return False

    # -- image upload ------------------------------------------------------

    async def upload_image(self, data: bytes, filename: str, content_type: str) -> str:
        """Upload decoded image bytes under a server-generated name.

        The caller never supplies a filename or a path.
        """
        files = {"image": (filename, data, content_type)}
        form = {"type": "input", "overwrite": "false"}
        try:
            resp = await self.client.post("/upload/image", files=files, data=form)
        except httpx.HTTPError:
            raise backend_error("Image upload to the media backend failed.")
        if resp.status_code != 200:
            raise backend_error("Image upload to the media backend failed.")
        try:
            body = resp.json()
        except ValueError:
            raise backend_error("Image upload to the media backend failed.")
        if not isinstance(body, dict):
            raise backend_error("Image upload to the media backend failed.")
        name = body.get("name")
        subfolder = body.get("subfolder")
        # Both name and subfolder are attacker-influenced (a compromised or
        # buggy backend), so each is validated independently to the same
        # standard the /view reference check uses.
        if not _safe_ref(name) or not isinstance(name, str) or not name:
            raise backend_error("Image upload to the media backend failed.")
        if name in (".", ".."):
            raise backend_error("Image upload to the media backend failed.")
        if subfolder is None or subfolder == "":
            subfolder = ""
        elif not _safe_ref(subfolder):
            raise backend_error("Image upload to the media backend failed.")
        if len(name) > MAX_REF_LENGTH or len(subfolder) > MAX_SUBFOLDER_LENGTH:
            raise backend_error("Image upload to the media backend failed.")
        return f"{subfolder}/{name}".strip("/") if subfolder else name

    # -- job lifecycle -----------------------------------------------------

    async def submit(self, graph: dict, client_id: str, prompt_id: str) -> str:
        """Submit a prompt with a caller-chosen UUID ``prompt_id``.

        The pinned server accepts a canonical lowercase hyphenated UUID in the
        request body and uses it verbatim as the history key and the
        ``/interrupt`` match target. Supplying our own id means that even if the
        HTTP response never arrives we still know exactly which backend job (if
        any) we may have created, so the admission slot is never released on a
        guess.

        Raises ``backend_error`` only when the backend positively rejected the
        prompt (4xx) or returned an unusable body. Transport-level uncertainty
        raises ``backend_unavailable``; callers must treat that as "acceptance
        unknown" and never assume the job was not created.
        """
        payload = {
            "prompt": graph,
            "prompt_id": prompt_id,
            "client_id": client_id,
            "extra_data": {"bridge": self.instance_id},
        }
        try:
            resp = await self.client.post("/prompt", json=payload)
        except httpx.HTTPError:
            raise backend_unavailable()
        if resp.status_code != 200:
            # 4xx from ComfyUI means the graph was *rejected* and never queued:
            # nothing is running, so the slot is safe to release. Do not leak
            # the backend body. Any other status (5xx, redirect, ...) is not a
            # proven rejection, so conservatively treat it as unavailable.
            if 400 <= resp.status_code < 500:
                raise backend_error("The media backend rejected the request.")
            raise backend_unavailable()
        try:
            body = resp.json()
        except ValueError:
            # 200 but unparsable body: the prompt may have been accepted, so
            # this is uncertain acceptance, not a client-visible rejection.
            raise backend_unavailable()
        if not isinstance(body, dict):
            raise backend_unavailable()
        returned = body.get("prompt_id")
        if returned != prompt_id:
            # Either a misbehaving backend or a body we cannot trust. We cannot
            # prove which id (if any) was queued, so acceptance is uncertain.
            raise backend_unavailable()
        return prompt_id

    async def history(self, prompt_id: str) -> dict | None:
        try:
            resp = await self.client.get(f"/history/{prompt_id}")
        except httpx.HTTPError as exc:
            raise ComfyPollError("poll transport error") from exc
        if resp.status_code != 200:
            raise ComfyPollError(f"poll status {resp.status_code}")
        try:
            body = resp.json()
        except ValueError as exc:
            raise ComfyPollError("poll invalid json") from exc
        entry = body.get(prompt_id)
        if isinstance(entry, dict):
            return entry
        if body and all(not isinstance(v, dict) for v in body.values()):
            return None
        return None

    async def wait_for_terminal(self, prompt_id: str, *, timeout: float | None = None) -> dict:
        """Poll until the job reaches a terminal state.

        Never cancelled by the caller: this coroutine is shielded upstream.
        """
        deadline = None if timeout is None else asyncio.get_event_loop().time() + timeout
        while True:
            entry = await self.history(prompt_id)
            if entry is not None:
                status = entry.get("status") or {}
                if status.get("completed") is True or status.get("status_str") in ("success", "error"):
                    if entry.get("execution_cancelled") or _is_error(entry):
                        # Terminal *and* failed: the GPU slot is free again.
                        raise ComfyJobFailed("The media backend failed to generate the asset.")
                    return entry
            if self._cancelled:
                raise ComfyCancelled()
            if deadline is not None and asyncio.get_event_loop().time() > deadline:
                raise ComfyTimeout()
            await asyncio.sleep(self.poll_interval)

    async def fetch_view(self, item: dict) -> bytes:
        """Download exactly one artifact referenced by Comfy's /history entry."""
        filename = item.get("filename")
        subfolder = item.get("subfolder") or ""
        kind = item.get("type") or "output"
        if not isinstance(filename, str) or not filename:
            raise backend_error("The media backend returned an invalid artifact reference.")
        if not _safe_ref(filename) or not _safe_ref(subfolder):
            raise backend_error("The media backend returned an invalid artifact reference.")
        # Generated results are served only from Comfy's output directory.
        # Input and temp references could expose pre-existing media and would
        # bypass the output cleanup contract.
        if kind != "output":
            raise backend_error("The media backend returned an invalid artifact reference.")
        if len(filename) > MAX_REF_LENGTH or len(subfolder) > MAX_SUBFOLDER_LENGTH:
            raise backend_error("The media backend returned an invalid artifact reference.")
        params = {"filename": filename, "subfolder": subfolder, "type": kind}
        try:
            async with self.client.stream("GET", "/view", params=params) as resp:
                if resp.status_code == 200:
                    length = resp.headers.get("content-length")
                    if length is not None:
                        try:
                            declared = int(length)
                        except ValueError:
                            raise backend_error("The media backend returned an invalid artifact length.")
                        if declared > MAX_ARTIFACT_BYTES:
                            raise backend_error("Generated artifact exceeded the size limit.")
                    data = bytearray()
                    async for chunk in resp.aiter_bytes():
                        if len(data) + len(chunk) > MAX_ARTIFACT_BYTES:
                            raise backend_error("Generated artifact exceeded the size limit.")
                        data.extend(chunk)
                    return bytes(data)
        except httpx.HTTPError:
            raise backend_error("Downloading the generated asset failed.")
        raise backend_error("Downloading the generated asset failed.")

    # -- cancellation ------------------------------------------------------

    async def cancel_own_job(self, prompt_id: str) -> bool:
        """Best-effort cancellation of a prompt this process submitted.

        Returns ``True`` only when terminal history proves the job is no longer
        occupying the GPU. A successful pending delete is not enough: Comfy's
        ``POST /queue`` response is an empty 200 even for a no-op, and a prompt
        can race between queue snapshots.

        The pinned server (see ``../upstream/ComfyUI/server.py``):

        * ``POST /queue`` returns an empty 200 body, so it can never report
          whether a prompt was deleted. ``GET /queue`` is useful for deciding
          whether a targeted interrupt is needed, but absence alone is not a
          terminal proof.
        * ``POST /interrupt`` accepts ``{"prompt_id": ...}`` and only signals the
          interrupt when that exact id is currently running.

        Returns ``False`` whenever ownership or state cannot be proven, so the
        caller keeps the slot quarantined instead of guessing.

        A *missing* history entry never counts as terminal: while a job is
        pending or running ComfyUI reports ``{}`` for its history, so only an
        entry that is present and terminal proves the GPU is free.
        """
        # Always attempt the targeted pending delete first. On the pinned server
        # the predicate is ``lambda a: a[1] == prompt_id``, so it can only match
        # the exact id we submitted and is a harmless no-op once the job has left
        # the pending queue. ``POST /queue`` returns an empty 200 body, so the
        # response itself proves nothing; ``GET /queue`` below is authoritative.
        try:
            await self.client.post("/queue", json={"delete": [prompt_id]})
        except httpx.HTTPError:
            pass
        # An entry that is present *and* terminal is the strongest proof.
        if _history_proven_terminal(await self._history_or_none(prompt_id)):
            return True
        # ``GET /queue`` is the authoritative running/pending source for
        # deciding whether an interrupt is needed. It is not itself enough to
        # release the slot because a prompt can change state between reads.
        running = await self._queue_state(prompt_id)
        if running is None:
            # Could not read the queue: only trust a proven terminal history.
            return _history_proven_terminal(await self._history_or_none(prompt_id))
        if running:
            # Still running and it is exactly ours: issue a *targeted* interrupt
            # for our own id. The pinned server only signals the interrupt when
            # that exact id is currently running, so an unrelated prompt is
            # never touched.
            try:
                resp = await self.client.post("/interrupt", json={"prompt_id": prompt_id})
            except httpx.HTTPError:
                return False
            if resp.status_code != 200:
                return False
            # Interrupt only *signals*; confirm the job left the running set and
            # reached a terminal history state before declaring it resolved.
            for _ in range(20):
                if _history_proven_terminal(await self._history_or_none(prompt_id)):
                    return True
                if await self._queue_state(prompt_id) is False:
                    break
                await asyncio.sleep(self.poll_interval)
            return _history_proven_terminal(await self._history_or_none(prompt_id))
        # Not running. A pending delete or an empty queue snapshot still does
        # not prove terminal state; only history can do that.
        return _history_proven_terminal(await self._history_or_none(prompt_id))

    async def _queue_state(self, prompt_id: str) -> bool | None:
        """Return True if ``prompt_id`` is running, False if absent, None if unknown.

        Reads ``GET /queue`` (``{"queue_running": [...], "queue_pending": [...]}``
        on the pinned server) and matches entries by their index-1 prompt id.
        """
        try:
            resp = await self.client.get("/queue")
        except httpx.HTTPError:
            return None
        if resp.status_code != 200:
            return None
        try:
            body = resp.json()
        except ValueError:
            return None
        if not isinstance(body, dict):
            return None
        running = body.get("queue_running")
        pending = body.get("queue_pending")
        if not isinstance(running, list) or not isinstance(pending, list):
            return None
        for entry in running:
            if _entry_prompt_id(entry) == prompt_id:
                return True
        for entry in pending:
            if _entry_prompt_id(entry) == prompt_id:
                return False
        return False

    async def _history_or_none(self, prompt_id: str) -> dict | None:
        try:
            return await self.history(prompt_id)
        except ComfyPollError:
            return None

    # -- cleanup -----------------------------------------------------------

    async def delete_history(self, prompt_id: str) -> bool:
        """Best-effort removal of *our own* history entry (``POST /history``).

        Only ever names the single prompt id this process submitted; the pinned
        server's handler accepts ``{"delete": [...]}``. Failures are ignored:
        history retention is a hygiene nicety, not a safety property.
        """
        try:
            resp = await self.client.post("/history", json={"delete": [prompt_id]})
        except httpx.HTTPError:
            return False
        return resp.status_code == 200


class ComfyPollError(Exception):
    pass


class ComfyJobFailed(Exception):
    """The job reached a terminal state and the backend reported it failed."""


class ComfyTimeout(Exception):
    pass


class ComfyCancelled(Exception):
    pass


def _safe_ref(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    if "\x00" in value:
        return False
    if value in ("", "."):
        return True
    if value.startswith(("/", "\\")) or "\\" in value or ":" in value:
        return False
    parts = [p for p in value.split("/") if p not in ("", ".")]
    return all(p != ".." for p in parts)


def _is_error(entry: dict) -> bool:
    status = entry.get("status") or {}
    if status.get("status_str") == "error":
        return True
    if status.get("completed") is True and not status.get("success", True):
        return True
    messages = status.get("messages") or []
    for item in messages:
        if isinstance(item, (list, tuple)) and item and item[0] in ("execution_error", "execution_interrupted"):
            return True
    return False


def _entry_prompt_id(entry: Any) -> str | None:
    """Extract the prompt id from a queue entry ``(number, prompt_id, ...)``."""
    if isinstance(entry, (list, tuple)) and len(entry) > 1 and isinstance(entry[1], str):
        return entry[1]
    return None


def _history_terminal(entry: dict | None) -> bool:
    if entry is None:
        return True
    status = entry.get("status") or {}
    return bool(status.get("completed") is True or status.get("status_str") in ("success", "error"))


def _history_proven_terminal(entry: dict | None) -> bool:
    """True only when a history *entry exists* and reports a terminal state.

    Unlike :func:`_history_terminal`, a missing entry is not treated as
    terminal: ComfyUI returns ``{}`` for a job that is still pending or running,
    so "no entry" is exactly the case we must never read as "nothing on the
    GPU".
    """
    return entry is not None and _history_terminal(entry)
