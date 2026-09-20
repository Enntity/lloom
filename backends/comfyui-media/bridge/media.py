"""Output typing and trusted-data-root cleanup for generated artifacts.

Two independent responsibilities live here:

* :func:`sniff_media` types an artifact by inspecting its bytes (MP4/ISO-BMFF
  container or RIFF/WAVE), so the declared ``output_kind`` from the graph and
  the bytes we are about to hand back cannot silently disagree.
* :class:`DataRoots` deletes files *only* under the trusted, operationally
  configured data root (``LLOOM_MEDIA_DATA_ROOT``, conventionally ``/data``).
  A caller can never choose a root: the only inputs are a validated
  server-generated upload basename and a validated ComfyUI-returned output
  reference. Everything else is refused, so a hostile or buggy backend cannot
  turn cleanup into arbitrary file deletion.
"""

from __future__ import annotations

import logging
import os
import re
from urllib.parse import unquote

log = logging.getLogger("bridge.media")

VIDEO_MIME = "video/mp4"
AUDIO_MIME = "audio/wav"
IMAGE_MIME = "image/png"

# MP4/ISO base media file format: a box with size>=8 followed by "ftyp" at
# offset 4. Covers MP4 non-fragmented and fragmented (moof/mfra) outputs.
_FTYP = b"ftyp"
# RIFF/WAVE: "RIFF" + 4-byte length + "WAVE".
_RIFF = b"RIFF"
_WAVE = b"WAVE"
_PNG = b"\x89PNG\r\n\x1a\n"

_SAFE_BASENAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,255}$")


def sniff_media(data: bytes) -> str | None:
    """Return the recognized fixed artifact kind, else ``None``."""
    if data.startswith(_PNG):
        return "image"
    if len(data) >= 12 and data[4:8] == _FTYP:
        return "video"
    if len(data) >= 12 and data[:4] == _RIFF and data[8:12] == _WAVE:
        return "audio"
    return None


def media_matches_kind(data: bytes, kind: str) -> bool:
    """True when the artifact bytes are a container consistent with ``kind``."""
    return sniff_media(data) == kind


def expected_media_suffix(kind: str) -> str:
    if kind == "video":
        return ".mp4"
    if kind == "image":
        return ".png"
    return ".wav"


class DataRoots:
    """Confined cleanup of files under a trusted, operationally-set data root.

    ``root`` is taken from ``LLOOM_MEDIA_DATA_ROOT`` and defaults to ``None``,
    which disables all deletion. When configured (e.g. ``/data``) the mount is
    expected to hold ``input`` and ``output`` subdirectories that exactly mirror
    ComfyUI's ``type`` directories. Only names that pass the strict basename /
    relative-reference checks are joined onto those roots.
    """

    def __init__(self, root: str | None = None):
        self.root = _normalize_root(root)

    @classmethod
    def from_env(cls, env: dict | None = None) -> "DataRoots":
        env = os.environ if env is None else env
        return cls(env.get("LLOOM_MEDIA_DATA_ROOT"))

    @property
    def enabled(self) -> bool:
        return self.root is not None

    def delete_upload(self, name: str) -> bool:
        """Delete a previously uploaded input file by its validated reference."""
        return self._delete("input", name)

    def delete_output(self, item: dict) -> bool:
        """Delete a backend output file by its validated history reference."""
        kind = item.get("type") or "output"
        if kind not in ("output", "temp"):
            return False
        filename = item.get("filename")
        subfolder = item.get("subfolder") or ""
        ref = f"{subfolder}/{filename}" if subfolder else filename
        directory = "output" if kind in ("output",) else "temp"
        return self._delete(directory, ref)

    def _delete(self, category: str, ref: str) -> bool:
        if self.root is None:
            return False
        if not isinstance(ref, str) or not _safe_relative(ref):
            log.warning("refused cleanup of an unsafe media reference")
            return False
        base = os.path.join(self.root, category)
        base_real = os.path.realpath(base)
        target = os.path.realpath(os.path.join(base, *ref.split("/")))
        if target != base_real and not target.startswith(base_real + os.sep):
            log.warning("refused cleanup outside the trusted media root")
            return False
        try:
            os.remove(target)
            return True
        except FileNotFoundError:
            return False
        except OSError:
            log.warning("media cleanup failed")
            return False


def _normalize_root(root: str | None) -> str | None:
    if not isinstance(root, str) or not root.strip():
        return None
    if "\x00" in root:
        return None
    if not os.path.isabs(root):
        # A relative root would resolve against the process CWD, which is not a
        # trusted anchor, so refuse it outright rather than guess.
        log.warning("LLOOM_MEDIA_DATA_ROOT must be absolute; cleanup disabled")
        return None
    normalized = os.path.normpath(root)
    if normalized == os.sep:
        # Refuse "/" so cleanup can never operate on the whole filesystem.
        log.warning("LLOOM_MEDIA_DATA_ROOT must not be the filesystem root")
        return None
    return normalized


def _safe_relative(ref: str) -> bool:
    if "\x00" in ref or "\\" in ref or ":" in ref:
        return False
    if ref.startswith("/"):
        return False
    if ref != unquote(ref):
        # Percent-encoded input is not something we ever produce; refuse rather
        # than decode-and-guess.
        return False
    parts = [p for p in ref.split("/") if p not in ("", ".")]
    if not parts:
        return False
    if any(p == ".." for p in parts):
        return False
    if any(not _SAFE_BASENAME_RE.match(p) for p in parts):
        return False
    return True


__all__ = [
    "DataRoots",
    "VIDEO_MIME",
    "AUDIO_MIME",
    "IMAGE_MIME",
    "expected_media_suffix",
    "media_matches_kind",
    "sniff_media",
]
