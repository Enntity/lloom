#!/usr/bin/env python3
"""Regression test for the vLLM #52805 XGrammar termination backport."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HOTFIX = (
    ROOT
    / "backends/dspark-vllm/packs/miaai-dsv4flash-d1b76251-defaults/patches"
    / "hotfix-vllm-xgrammar-termination-52805.sh"
)


SOURCE = '''class XgrammarGrammar:
    def accept_tokens(self, request_id: str, tokens: list[int]) -> bool:
        """Accepts a list of tokens and advances the FSM.

        Returns True if the FSM was advanced successfully.
        Returns False if the FSM failed to advance.
        """
        if self._is_terminated:
            return False
        for token in tokens:
            if not self.matcher.accept_token(token):
                logger.error(
                    "Failed to advance FSM for request %s "
                    "for tokens %s. Please file an issue.",
                    request_id,
                    token,
                )
                return False
            self.num_processed_tokens += 1
        self._is_terminated = self.matcher.is_terminated()
        return True

    def validate_tokens(self, tokens: list[int]) -> list[int]:
        """Checks if the list of tokens are accepted by the FSM in sequence.
        Will not advance the FSM.

        Returns the prefix list of tokens that are accepted by the FSM.
        """
        accepted_tokens = []
        for token in tokens:
            if self.matcher.accept_token(token):
                accepted_tokens.append(token)
            else:
                break
        if len(accepted_tokens) > 0:
            self.matcher.rollback(len(accepted_tokens))
        return accepted_tokens

    def reset(self):
        self.num_processed_tokens = 0
        self.matcher.reset()
'''


class XgrammarTerminationBackportTests(unittest.TestCase):
    def test_patch_is_fail_closed_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "vllm"
            target = root / "v1/structured_output/backend_xgrammar.py"
            target.parent.mkdir(parents=True)
            target.write_text(SOURCE, encoding="utf-8")
            env = {"VLLM_ROOT": str(root)}

            first = subprocess.run(["bash", str(HOTFIX)], env=env, check=True, capture_output=True, text=True)
            self.assertIn("[applied]", first.stdout)
            patched = target.read_text(encoding="utf-8")
            self.assertIn("Tokens after termination are ignored.", patched)
            self.assertIn("if self.matcher.is_terminated():\n                    break", patched)
            self.assertIn("self._is_terminated = False", patched)

            second = subprocess.run(["bash", str(HOTFIX)], env=env, check=True, capture_output=True, text=True)
            self.assertIn("[skip]", second.stdout)
            self.assertEqual(target.read_text(encoding="utf-8"), patched)

            status = subprocess.run(
                ["bash", str(HOTFIX), "--status"], env=env, check=True, capture_output=True, text=True
            )
            self.assertIn("APPLIED", status.stdout)


if __name__ == "__main__":
    unittest.main()
