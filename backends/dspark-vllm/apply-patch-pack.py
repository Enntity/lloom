#!/usr/bin/env python3
"""Verify and apply a pinned DSpark patch pack without shell evaluation."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


ALLOWED_KINDS = {"python": "python3", "shell": "bash", "reference": None}


class PackError(RuntimeError):
    """Raised when a patch pack cannot be trusted or applied."""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise PackError(f"cannot read patch-pack manifest {path}: {error}") from error
    if data.get("schemaVersion") != 1:
        raise PackError("unsupported patch-pack schemaVersion")
    if not isinstance(data.get("id"), str) or not data["id"]:
        raise PackError("patch-pack id is required")
    if not isinstance(data.get("patches"), list) or not data["patches"]:
        raise PackError("patch-pack patches must be a non-empty list")
    if not isinstance(data.get("compatibility"), dict):
        raise PackError("patch-pack compatibility contract is required")
    return data


def resolve_artifact(pack_root: Path, relative: str) -> Path:
    if not relative or Path(relative).is_absolute():
        raise PackError(f"artifact path must be relative: {relative!r}")
    artifact = (pack_root / relative).resolve()
    try:
        artifact.relative_to(pack_root)
    except ValueError as error:
        raise PackError(f"artifact escapes patch-pack root: {relative}") from error
    return artifact


def verify_pack(manifest_path: Path, manifest: dict[str, Any]) -> list[tuple[dict[str, Any], Path]]:
    pack_root = manifest_path.parent.resolve()
    seen_ids: set[str] = set()
    seen_files: set[str] = set()
    verified: list[tuple[dict[str, Any], Path]] = []
    for index, patch in enumerate(manifest["patches"]):
        if not isinstance(patch, dict):
            raise PackError(f"patch #{index + 1} is not an object")
        patch_id = patch.get("id")
        relative = patch.get("file")
        expected = patch.get("sha256")
        kind = patch.get("kind")
        enabled = patch.get("enabled")
        if not isinstance(patch_id, str) or not patch_id:
            raise PackError(f"patch #{index + 1} has no id")
        if patch_id in seen_ids:
            raise PackError(f"duplicate patch id: {patch_id}")
        seen_ids.add(patch_id)
        if not isinstance(relative, str) or relative in seen_files:
            raise PackError(f"invalid or duplicate artifact for {patch_id}: {relative!r}")
        seen_files.add(relative)
        if kind not in ALLOWED_KINDS:
            raise PackError(f"unsupported patch kind for {patch_id}: {kind!r}")
        if not isinstance(enabled, bool):
            raise PackError(f"enabled must be boolean for {patch_id}")
        if enabled and kind == "reference":
            raise PackError(f"reference artifact cannot be enabled: {patch_id}")
        if not isinstance(expected, str) or len(expected) != 64:
            raise PackError(f"invalid sha256 for {patch_id}")
        try:
            int(expected, 16)
        except ValueError as error:
            raise PackError(f"invalid sha256 for {patch_id}") from error
        upstream_expected = patch.get("upstreamSha256")
        if upstream_expected is not None:
            if not isinstance(upstream_expected, str) or len(upstream_expected) != 64:
                raise PackError(f"invalid upstreamSha256 for {patch_id}")
            try:
                int(upstream_expected, 16)
            except ValueError as error:
                raise PackError(f"invalid upstreamSha256 for {patch_id}") from error
        artifact = resolve_artifact(pack_root, relative)
        if not artifact.is_file():
            raise PackError(f"missing patch artifact: {relative}")
        actual = sha256(artifact)
        if actual != expected:
            raise PackError(
                f"checksum mismatch for {relative}: expected {expected}, got {actual}"
            )
        if enabled:
            args = patch.get("args")
            if not isinstance(args, list) or not args or not all(isinstance(value, str) for value in args):
                raise PackError(f"enabled patch has invalid args: {patch_id}")
            env = patch.get("env", {})
            if not isinstance(env, dict) or not all(
                isinstance(key, str) and isinstance(value, str) for key, value in env.items()
            ):
                raise PackError(f"enabled patch has invalid env: {patch_id}")
        verified.append((patch, artifact))
    return verified


def require_compatibility(
    manifest: dict[str, Any], runtime_image: str, model: str, model_revision: str
) -> None:
    expected = manifest["compatibility"]
    actual = {
        "runtimeImage": runtime_image,
        "model": model,
        "modelRevision": model_revision,
    }
    for key, value in actual.items():
        wanted = expected.get(key)
        if value != wanted:
            raise PackError(f"incompatible {key}: expected {wanted!r}, got {value!r}")


def expand(value: str, variables: dict[str, str], patch_id: str) -> str:
    try:
        return value.format_map(variables)
    except KeyError as error:
        raise PackError(f"unknown placeholder {error} in {patch_id}") from error


def apply_enabled(
    verified: list[tuple[dict[str, Any], Path]], vllm_root: Path
) -> int:
    if not vllm_root.is_dir():
        raise PackError(f"vLLM root is missing: {vllm_root}")
    applied = 0
    for patch, artifact in verified:
        patch_id = patch["id"]
        if not patch["enabled"]:
            print(f"[dspark-pack] disabled: {patch_id}")
            continue
        variables = {
            "file": str(artifact),
            "packRoot": str(artifact.parent.parent if artifact.parent.name == "patches" else artifact.parent),
            "vllmRoot": str(vllm_root),
        }
        interpreter = ALLOWED_KINDS[patch["kind"]]
        if interpreter is None:
            raise PackError(f"enabled patch has no interpreter: {patch_id}")
        command = [interpreter] + [expand(value, variables, patch_id) for value in patch["args"]]
        environment = os.environ.copy()
        for key, value in patch.get("env", {}).items():
            environment[key] = expand(value, variables, patch_id)
        print(f"[dspark-pack] applying: {patch_id}")
        try:
            subprocess.run(command, env=environment, check=True)
        except subprocess.CalledProcessError as error:
            raise PackError(f"patch failed ({error.returncode}): {patch_id}") from error
        applied += 1
    return applied


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--runtime-image", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--vllm-root", type=Path)
    parser.add_argument("--check-only", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    manifest_path = args.manifest.resolve()
    manifest = load_manifest(manifest_path)
    verified = verify_pack(manifest_path, manifest)
    require_compatibility(manifest, args.runtime_image, args.model, args.model_revision)
    enabled = sum(1 for patch, _ in verified if patch["enabled"])
    print(
        f"[dspark-pack] verified {manifest['id']}: "
        f"{len(verified)} artifacts, {enabled} enabled"
    )
    if args.check_only:
        return 0
    configured_root = manifest["compatibility"].get("vllmRoot")
    vllm_root = args.vllm_root or (Path(configured_root) if configured_root else None)
    if vllm_root is None:
        raise PackError("vLLM root is required")
    applied = apply_enabled(verified, vllm_root.resolve())
    print(f"[dspark-pack] applied {applied} patches")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PackError as error:
        print(f"[dspark-pack] ERROR: {error}", file=sys.stderr)
        raise SystemExit(1)
