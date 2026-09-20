"""Shared submission loop: admission, submit, poll, fetch, release."""

from __future__ import annotations

import asyncio
import logging
import uuid
from audio_codec import flac_to_wav

from comfy_client import (
    ComfyCancelled,
    ComfyClient,
    ComfyJobFailed,
    ComfyPollError,
    ComfyTimeout,
)
from errors import (
    BridgeError,
    backend_error,
    backend_unavailable,
    rejected,
)
from media import AUDIO_MIME, IMAGE_MIME, VIDEO_MIME, DataRoots, expected_media_suffix, media_matches_kind

log = logging.getLogger("bridge.jobs")

# How long a reaper keeps polling for a terminal state before quarantining.
REAP_BUDGET_SECONDS = 300.0


class SingleFlightRunner:
    """Owns the one-and-only backend slot for every modality."""

    def __init__(self, comfy: ComfyClient, data_roots: DataRoots | None = None):
        self.comfy = comfy
        self._lock = asyncio.Lock()
        self._busy = False
        self._unhealthy = False
        self._reason = "unknown"
        self._owner: str | None = None
        self._reaps: set[asyncio.Task] = set()
        self.data_roots = data_roots if data_roots is not None else DataRoots()
        # Strong references to in-flight submission tasks, keyed by the owner
        # and prompt they belong to. A cancelled shielded submit remains here
        # until a reaper consumes its outcome; a done callback must not discard
        # the only evidence of a proven rejection versus uncertain acceptance.
        self._submits: dict[tuple[str, str], asyncio.Task] = {}

    @property
    def busy(self) -> bool:
        return self._busy

    @property
    def unhealthy(self) -> bool:
        return self._unhealthy

    # -- admission ---------------------------------------------------------

    async def _acquire(self, owner: str) -> None:
        async with self._lock:
            if self._unhealthy:
                raise backend_unavailable("Media backend is unavailable.")
            if self._busy:
                raise BridgeError(429, "rate_limit_error", "A generation is already in progress.", "busy")
            self._busy = True
            self._owner = owner

    async def _release(self, owner: str) -> None:
        async with self._lock:
            if getattr(self, "_owner", None) == owner:
                self._busy = False
                self._owner = None

    async def _retain_busy(self, owner: str, reason: str) -> None:
        async with self._lock:
            if getattr(self, "_owner", None) == owner:
                self._unhealthy = True
                self._reason = reason
                # Slot stays held: _busy remains True.

    async def _release_terminal(self, owner: str) -> None:
        """Release the slot for a *proven terminal* job and clear our own flag.

        Only clears ``unhealthy`` when this owner still holds the slot, so a
        quarantine recorded against a different owner is never wiped by an
        unrelated release.
        """
        async with self._lock:
            if getattr(self, "_owner", None) != owner:
                return
            self._busy = False
            self._owner = None
            if self._unhealthy:
                log.info("backend job for the quarantined slot reached a terminal state")
                self._unhealthy = False
                self._reason = "unknown"

    # -- main entry --------------------------------------------------------

    async def run(self, build, *, kind: str, upload_ref: list[str] | None = None) -> tuple[bytes, str]:
        """Submit one job and return (artifact bytes, mime type).

        Cancellation semantics: if this coroutine is cancelled (client
        disconnect) while the backend job is still running, the job is *not*
        abandoned and the admission slot is *not* released here. A reaper task
        is kept alive until ComfyUI reports a terminal state; only then is the
        slot freed. On an unrecoverable reap the runner is marked unhealthy and
        the slot is retained forever rather than risking a second GPU job.

        Every failure path is classified by what we can *prove*:

        * the prompt was positively rejected (4xx) or never had a graph built ->
          nothing is on the GPU, release the slot;
        * the backend job is proven terminal (success/error/cancelled) ->
          release the slot;
        * acceptance is unknown (transport error or cancel during submit) ->
          quarantine the slot and reap, never release.
        """
        owner = uuid.uuid4().hex
        await self._acquire(owner)
        # Generate the id ourselves *before* submitting. The pinned server
        # honours a caller-supplied canonical UUID as the history key and the
        # /interrupt match target, so we always know which backend job (if any)
        # we may have created even if the HTTP response never arrives.
        prompt_id: str = str(uuid.uuid4())
        submitted = False
        # True once a graph has been built and a *submit attempt* has begun.
        # A cancellation that lands before this point (e.g. during graph
        # construction) cannot have queued any GPU work, so the slot is safe to
        # release immediately instead of being quarantined.
        submit_started = False
        # Set once we know the backend job reached a terminal state. While it is
        # False the job may still be running on the GPU, so the slot must stay
        # held no matter how this coroutine exits.
        terminal = False
        output_node: str | None = None
        upload_names: list[str] | None = None
        output_item: dict | None = None
        try:
            # The build closure may publish an upload reference while it is
            # running (before it returns or before a cancellation reaches us).
            if upload_ref:
                upload_names = list(upload_ref)
            graph, output_node, out_kind = await build(self.comfy)
            if out_kind not in ("video", "audio", "image"):
                raise backend_error("The media backend produced an unsupported output.")
            if upload_ref:
                upload_names = list(upload_ref)
            # Submission is shielded and strongly referenced: a cancellation
            # arriving here must not abort the request before we learn whether
            # Comfy accepted it.
            submit_started = True
            await self._submit(graph, owner, prompt_id)
            submitted = True
            try:
                entry = await self.comfy.wait_for_terminal(prompt_id, timeout=self.comfy.poll_timeout)
                terminal = True
                item = _pick_output(entry, output_node)
                output_item = item
                data = await self.comfy.fetch_view(item)
            except ComfyTimeout:
                await self._reap_after_timeout(owner, prompt_id, output_node, upload_names)
                raise backend_error("Media generation timed out.")
            except ComfyJobFailed:
                # Terminal failure: the slot is no longer occupied on the GPU.
                terminal = True
                self._cleanup_after_fetch(owner, prompt_id, output_item, upload_names)
                raise backend_error("The media backend failed to generate the asset.")
            except (ComfyPollError, ComfyCancelled):
                await self._retain_busy(owner, "poll-error")
                self._schedule_reap(
                    owner,
                    prompt_id,
                    output_node=output_node,
                    upload_names=upload_names,
                    stop_after_seconds=REAP_BUDGET_SECONDS,
                )
                raise backend_unavailable("Media backend is unavailable.")
            if not data:
                raise backend_error("The media backend produced an empty artifact.")
            # Native ComfyUI SaveAudio writes FLAC; convert only a matching,
            # bounded lossless output to the WAV promised by the gateway.
            if out_kind == "audio" and data.startswith(b"fLaC"):
                if not output_item.get("filename", "").lower().endswith(".flac"):
                    raise backend_error("The media backend produced an unexpected output type.")
                data = await asyncio.to_thread(flac_to_wav, data)
            # The declared graph kind and the actual bytes must agree, and both
            # must match what this endpoint promised to return.
            if not media_matches_kind(data, out_kind):
                raise backend_error("The media backend produced an unexpected output type.")
            _validate_output_ref(output_item, output_node, out_kind)
            expected_kind = kind
            if out_kind != expected_kind:
                raise backend_error("The media backend produced an unexpected output type.")
            mime = {"video": VIDEO_MIME, "audio": AUDIO_MIME, "image": IMAGE_MIME}[out_kind]
            self._cleanup_after_fetch(owner, prompt_id, output_item, upload_names)
            await self._release_terminal(owner)
            return data, mime
        except asyncio.CancelledError:
            if upload_ref:
                upload_names = list(upload_ref)
            if submitted:
                # The prompt is on the GPU; hold the slot until it is provably
                # terminal.
                self._schedule_reap(
                    owner,
                    prompt_id,
                    output_node=output_node,
                    upload_names=upload_names,
                    stop_after_seconds=REAP_BUDGET_SECONDS,
                )
            elif submit_started:
                # The shielded submit task may have reached Comfy, so let it
                # finish and reap based on the outcome rather than guessing.
                await self._retain_busy(owner, "submit-uncertain")
                self._schedule_reap_after_submit(owner, prompt_id, output_node, upload_names)
            else:
                # Cancelled during graph construction: nothing was ever
                # submitted, so hand the slot straight back.
                self._cleanup_after_fetch(owner, prompt_id, output_item, upload_names)
                await self._release(owner)
            raise
        except _SubmitUncertain:
            # We could not prove whether Comfy accepted the prompt, so assume it
            # might be running and quarantine the slot rather than release it.
            if upload_ref:
                upload_names = list(upload_ref)
            await self._retain_busy(owner, "submit-uncertain")
            self._schedule_reap(
                owner,
                prompt_id,
                output_node=output_node,
                upload_names=upload_names,
                stop_after_seconds=REAP_BUDGET_SECONDS,
            )
            raise backend_unavailable("Media backend is unavailable.")
        except BaseException:
            # The job is provably finished (or was never submitted), so the GPU
            # slot is safe to hand back.
            if upload_ref:
                upload_names = list(upload_ref)
            if not submitted or terminal:
                self._cleanup_after_fetch(owner, prompt_id, output_item, upload_names)
                await self._release(owner)
            raise

    # -- submission --------------------------------------------------------

    async def _submit(self, graph: dict, owner: str, prompt_id: str) -> None:
        """Submit through a shielded, strongly-referenced task.

        ``ComfyClient.submit`` raises ``backend_error`` (502) only when the
        backend *positively rejected* the prompt (4xx), and ``backend_unavailable``
        (503) when acceptance is uncertain. We translate the latter into
        ``_SubmitUncertain`` so the caller quarantines instead of releasing.
        """
        key = (owner, prompt_id)
        task = asyncio.get_running_loop().create_task(self.comfy.submit(graph, owner, prompt_id))
        self._submits[key] = task
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            # Our caller was cancelled but the request may still land. The
            # caller turns this into an uncertain-acceptance quarantine.
            raise
        except BridgeError as exc:
            # The outcome was consumed by this foreground path. A caller
            # cancellation deliberately skips this removal so the reaper can
            # inspect the task after the shielded request settles.
            self._submits.pop(key, None)
            if exc.status_code == 502:
                # Proven rejection: nothing was queued.
                raise
            raise _SubmitUncertain() from exc
        except Exception as exc:
            self._submits.pop(key, None)
            # An unexpected submit failure is still acceptance uncertainty;
            # never let an implementation/transport exception release a slot
            # whose prompt may have reached Comfy.
            raise _SubmitUncertain() from exc
        else:
            self._submits.pop(key, None)

    # -- cancellation helpers ---------------------------------------------

    def _schedule_reap(
        self,
        owner: str,
        prompt_id: str | None,
        *,
        output_node: str | None,
        upload_names: list[str] | None,
        stop_after_seconds: float | None,
    ) -> None:
        task = asyncio.get_running_loop().create_task(
            self._reap(
                owner,
                prompt_id,
                output_node=output_node,
                upload_names=upload_names,
                stop_after_seconds=stop_after_seconds,
            )
        )
        self._reaps.add(task)
        task.add_done_callback(self._reaps.discard)

    def _schedule_reap_after_submit(
        self,
        owner: str,
        prompt_id: str,
        output_node: str | None,
        upload_names: list[str] | None,
    ) -> None:
        """Reap a job whose shielded submit was cancelled mid-flight.

        The submit task is strongly referenced (``self._submits``) and runs to
        completion: if it fails with a *proven* rejection nothing was queued and
        the slot is released; otherwise the accepted (or uncertain) id is
        reaped to terminal.
        """
        task = asyncio.get_running_loop().create_task(
            self._reap_after_submit(owner, prompt_id, output_node, upload_names)
        )
        self._reaps.add(task)
        task.add_done_callback(self._reaps.discard)

    async def _reap_after_submit(
        self,
        owner: str,
        prompt_id: str,
        output_node: str | None,
        upload_names: list[str] | None,
    ) -> None:
        """Consume a cancelled submit outcome before deciding how to reap.

        A 4xx response is a proven rejection and releases the slot. Every
        other result, including a missing task, is treated as uncertain and
        remains quarantined until terminal history is observed.
        """
        task = self._submits.get((owner, prompt_id))
        if task is None:
            await self._retain_busy(owner, "submit-uncertain")
            await self._reap(
                owner,
                prompt_id,
                output_node=output_node,
                upload_names=upload_names,
                stop_after_seconds=REAP_BUDGET_SECONDS,
            )
            return
        try:
            await asyncio.shield(task)
        except BridgeError as exc:
            if exc.status_code == 502:
                # This task is now proven rejected; consume it before release
                # so no exception is left unobserved.
                self._submits.pop((owner, prompt_id), None)
                self._cleanup_after_fetch(owner, prompt_id, None, upload_names)
                await self._release_terminal(owner)
                return
            self._submits.pop((owner, prompt_id), None)
        except BaseException:
            self._submits.pop((owner, prompt_id), None)
        else:
            self._submits.pop((owner, prompt_id), None)

        # A successful response, a transport/backend failure, or an unexpected
        # exception leaves acceptance uncertain. Keep the slot quarantined and
        # use the caller-supplied id to look for terminal history.
        await self._retain_busy(owner, "submit-uncertain")
        await self._reap(
            owner,
            prompt_id,
            output_node=output_node,
            upload_names=upload_names,
            stop_after_seconds=REAP_BUDGET_SECONDS,
        )

    async def _reap(
        self,
        owner: str,
        prompt_id: str | None,
        *,
        output_node: str | None,
        upload_names: list[str] | None,
        stop_after_seconds: float | None,
    ) -> None:
        """Keep the slot held until the backend job is provably terminal.

        ``stop_after_seconds`` is a *hard* budget: once it elapses without a
        terminal state the slot is quarantined and the loop exits rather than
        spinning forever.
        """
        if prompt_id is None:
            await self._release(owner)
            return
        loop = asyncio.get_running_loop()
        deadline = None if stop_after_seconds is None else loop.time() + stop_after_seconds
        while True:
            entry = None
            try:
                entry = await self.comfy.history(prompt_id)
            except ComfyPollError:
                entry = None
            if entry is not None and _terminal(entry):
                item = _pick_output(entry, output_node, required=False)
                self._cleanup_after_fetch(owner, prompt_id, item, upload_names)
                await self._release_terminal(owner)
                return
            if deadline is not None and loop.time() > deadline:
                await self._retain_busy(owner, "unresolved-job")
                log.error("backend job never reached a terminal state; retaining slot")
                return
            await asyncio.sleep(min(1.0, self.comfy.poll_interval))

    async def _reap_after_timeout(
        self,
        owner: str,
        prompt_id: str,
        output_node: str | None,
        upload_names: list[str] | None,
    ) -> None:
        """Timeout path: try targeted cancellation, then verify terminal."""
        try:
            verified = await self.comfy.cancel_own_job(prompt_id)
        except Exception:
            verified = False
        if verified:
            try:
                entry = await self.comfy.history(prompt_id)
            except ComfyPollError:
                entry = None
            if entry is not None and _terminal(entry):
                item = _pick_output(entry, output_node, required=False)
                self._cleanup_after_fetch(owner, prompt_id, item, upload_names)
                await self._release_terminal(owner)
                return
        await self._retain_busy(owner, "timeout-unresolved")
        self._schedule_reap(
            owner,
            prompt_id,
            output_node=output_node,
            upload_names=upload_names,
            stop_after_seconds=REAP_BUDGET_SECONDS,
        )

    # -- artifact cleanup --------------------------------------------------

    def _cleanup_after_fetch(
        self,
        owner: str,
        prompt_id: str,
        item: dict | None,
        upload_names: list[str] | None = None,
    ) -> None:
        """Delete our history entry and any files under the trusted data root.

        Called only once the job is resolved and the artifact has been fetched
        (success or terminal failure). Never called on an uncertain/cancelled
        job, whose files are retained until the id is resolved. All deletions
        are confined to :class:`~media.DataRoots`; a no-op when unconfigured.
        """
        task = asyncio.get_running_loop().create_task(
            self._cleanup(owner, prompt_id, item, upload_names)
        )
        self._reaps.add(task)
        task.add_done_callback(self._reaps.discard)

    async def _cleanup(
        self,
        owner: str,
        prompt_id: str,
        item: dict | None,
        upload_names: list[str] | None,
    ) -> None:
        try:
            await self.comfy.delete_history(prompt_id)
        except Exception:
            pass
        roots = self.data_roots
        if not roots.enabled:
            return
        for name in upload_names or ():
            roots.delete_upload(name)
        if item is not None:
            roots.delete_output(item)


def _pick_output(entry: dict, output_node, *, required: bool = True) -> dict | None:
    """Select an artifact from the history entry for the *declared* output node.

    There is deliberately no fallback: an artifact is returned only when the
    declared node id is present in the ``/history`` outputs. Scanning other
    nodes would mean handing back something the graph never nominated as its
    result.
    """
    outputs = entry.get("outputs") or {}
    node_key = None if output_node is None else str(output_node)
    candidates: list[dict] = []
    if node_key is not None and isinstance(outputs, dict) and node_key in outputs:
        candidates = _flatten(outputs[node_key])
    if not candidates:
        if required:
            raise backend_error("The media backend produced no artifact.")
        return None
    return candidates[0]


def _validate_output_ref(item: dict | None, output_node, out_kind: str) -> None:
    """Reject an artifact outside the fixed output contract or wrong kind.

    The declared node's artifact must look like the media kind the graph
    promised (``.mp4`` for video, ``.wav`` for audio), and it must be a native
    Comfy output reference. This runs after the bytes have been fetched and
    sniffed, so both the container and the name must agree.
    """
    if item is None:
        raise backend_error("The media backend produced no artifact.")
    if item.get("type") != "output":
        raise backend_error("The media backend returned an invalid artifact reference.")
    filename = item.get("filename")
    if not isinstance(filename, str) or not filename:
        raise backend_error("The media backend returned an invalid artifact reference.")
    lowered = filename.lower()
    wanted = expected_media_suffix(out_kind)
    if not lowered.endswith(wanted) and not (out_kind == "audio" and lowered.endswith(".flac")):
        raise backend_error("The media backend produced an unexpected output type.")


def _flatten(node_output) -> list[dict]:
    found: list[dict] = []
    if isinstance(node_output, dict):
        for key in ("images", "gifs", "video", "videos", "audio", "audios", "files"):
            items = node_output.get(key)
            if isinstance(items, list):
                for item in items:
                    if isinstance(item, dict) and item.get("filename"):
                        found.append(item)
    return found


def _terminal(entry: dict) -> bool:
    status = entry.get("status") or {}
    return bool(status.get("completed") is True or status.get("status_str") in ("success", "error"))


class _SubmitUncertain(Exception):
    """Acceptance of a submitted prompt could not be proven either way."""


__all__ = ["SingleFlightRunner", "rejected", "REAP_BUDGET_SECONDS"]
