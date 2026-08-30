#!/usr/bin/env python3
"""Backport SGLang PR #36418's streaming-disconnect lifecycle fix.

This patch is intentionally exact-source guarded for the pinned Qwen3.8 image.
It must fail closed when the upstream file changes instead of guessing how to
modify a different TokenizerManager implementation.
"""

from __future__ import annotations

import pathlib
import sys


PATCH_MARKER = 'dispatched_rids = getattr(obj, "_dispatched_rids", None)'


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return source.replace(old, new, 1)


def apply(path: pathlib.Path) -> None:
    source = path.read_text(encoding="utf-8")
    if PATCH_MARKER in source:
        print(f"disconnect lifecycle fix already present: {path}")
        return

    source = replace_once(
        source,
        """        self._init_req_state(obj, request)\n        try:\n            if self.server_args.language_only:\n""",
        """        self._init_req_state(obj, request)\n        try:\n            dispatched_rids = set()\n            if self.server_args.language_only:\n""",
        "initialize dispatched RID tracking",
    )
    source = replace_once(
        source,
        """                    self._send_one_request(tokenized_obj)\n                    async for response in self._wait_one_response(obj, request):\n""",
        """                    self._send_one_request(tokenized_obj)\n                    dispatched_rids.add(obj.rid)\n                    async for response in self._wait_one_response(obj, request):\n""",
        "track single dispatched RID",
    )
    source = replace_once(
        source,
        """                    async for response in self._handle_batch_request(obj, request):\n                        yield response\n        except BaseException:\n""",
        """                    async for response in self._handle_batch_request(\n                        obj, request, dispatched_rids\n                    ):\n                        yield response\n        except (asyncio.CancelledError, GeneratorExit):\n            # Keep scheduler-owned state until the delayed forced abort is sent.\n            obj._dispatched_rids = dispatched_rids.copy()\n            self._discard_pending_req_states(obj, dispatched_rids)\n            raise\n        except BaseException:\n""",
        "handle cancellation without orphaning scheduler requests",
    )
    source = replace_once(
        source,
        """    async def _handle_batch_request(\n        self,\n        obj: Union[GenerateReqInput, EmbeddingReqInput],\n        request: Optional[fastapi.Request] = None,\n    ):\n""",
        """    async def _handle_batch_request(\n        self,\n        obj: Union[GenerateReqInput, EmbeddingReqInput],\n        request: Optional[fastapi.Request] = None,\n        dispatched_rids: Optional[set[str]] = None,\n    ):\n""",
        "pass dispatched RID set to batch handler",
    )
    source = replace_once(
        source,
        """                self._send_batch_request(tokenized_objs)\n\n                # Set up generators for each request in the batch\n""",
        """                self._send_batch_request(tokenized_objs)\n                if dispatched_rids is not None:\n                    dispatched_rids.update(\n                        tokenized_obj.rid for tokenized_obj in tokenized_objs\n                    )\n\n                # Set up generators for each request in the batch\n""",
        "track batch-tokenized RIDs",
    )
    source = replace_once(
        source,
        """                        self._send_one_request(tokenized_obj)\n                        generators.append(self._wait_one_response(tmp_obj, request))\n""",
        """                        self._send_one_request(tokenized_obj)\n                        if dispatched_rids is not None:\n                            dispatched_rids.add(tmp_obj.rid)\n                        generators.append(self._wait_one_response(tmp_obj, request))\n""",
        "track sequential batch RID",
    )
    source = replace_once(
        source,
        """                self._init_req_state(tmp_obj)\n                self._send_one_request(tokenized_obj)\n                await self._wait_one_response(tmp_obj, request).__anext__()\n""",
        """                self._init_req_state(tmp_obj)\n                self._send_one_request(tokenized_obj)\n                if dispatched_rids is not None:\n                    dispatched_rids.add(tokenized_obj.rid)\n                await self._wait_one_response(tmp_obj, request).__anext__()\n""",
        "track parallel-sampling cache RID",
    )
    source = replace_once(
        source,
        """                    self._send_one_request(tokenized_obj)\n                    generators.append(self._wait_one_response(tmp_obj, request))\n""",
        """                    self._send_one_request(tokenized_obj)\n                    if dispatched_rids is not None:\n                        dispatched_rids.add(tokenized_obj.rid)\n                    generators.append(self._wait_one_response(tmp_obj, request))\n""",
        "track generated parallel-sampling RID",
    )
    source = replace_once(
        source,
        """    def abort_request(self, rid: str = "", abort_all: bool = False):\n""",
        """    def abort_request(\n        self, rid: str = "", abort_all: bool = False, force: bool = False\n    ):\n""",
        "add force option to abort_request",
    )
    source = replace_once(
        source,
        """        if (\n            not abort_all\n            and self.server_args.tokenizer_worker_num == 1\n""",
        """        if (\n            not abort_all\n            and not force\n            and self.server_args.tokenizer_worker_num == 1\n""",
        "allow cancellation cleanup to force scheduler delivery",
    )
    source = replace_once(
        source,
        """        async def abort_request():\n            await asyncio.sleep(2)\n            if obj.is_single:\n                self.abort_request(obj.rid)\n            else:\n                for rid in obj.rid:\n                    self.abort_request(rid)\n""",
        """        async def abort_request():\n            await asyncio.sleep(2)\n            dispatched_rids = getattr(obj, "_dispatched_rids", None)\n            if dispatched_rids is not None:\n                for rid in dispatched_rids:\n                    self.abort_request(rid, force=True)\n            elif obj.is_single:\n                self.abort_request(obj.rid)\n            else:\n                for rid in obj.rid:\n                    self.abort_request(rid)\n""",
        "force abort only for cancellation-recorded scheduler RIDs",
    )
    source = replace_once(
        source,
        """    def _discard_pending_req_states(self, obj):\n""",
        """    def _discard_pending_req_states(self, obj, dispatched_rids=None):\n""",
        "retain dispatched request states",
    )
    source = replace_once(
        source,
        """        for rid in rids:\n            self.rid_to_state.pop(rid, None)\n\n    def _should_dispatch_to_encoder(\n""",
        """        for rid in rids:\n            if dispatched_rids is None or rid not in dispatched_rids:\n                self.rid_to_state.pop(rid, None)\n\n    def _should_dispatch_to_encoder(\n""",
        "discard only request states not owned by scheduler",
    )

    path.write_text(source, encoding="utf-8")
    print(f"applied disconnect lifecycle fix: {path}")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} PATH")
    apply(pathlib.Path(sys.argv[1]))


if __name__ == "__main__":
    main()
