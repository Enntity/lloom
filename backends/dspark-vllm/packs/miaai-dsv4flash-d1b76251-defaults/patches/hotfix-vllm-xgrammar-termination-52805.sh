#!/usr/bin/env bash
# Backport vLLM PR #52805 to the pinned Anemll vLLM 0.25.2 image.
# MTP can submit a batch containing EOS plus draft tokens. XGrammar must stop
# at EOS; advancing the terminated matcher can desynchronize the FSM and
# livelock EngineCore in sample_tokens.
set -euo pipefail

VLLM_ROOT="${VLLM_ROOT:-/usr/local/lib/python3.12/dist-packages/vllm}"
TARGET="$VLLM_ROOT/v1/structured_output/backend_xgrammar.py"

if [ ! -f "$TARGET" ]; then
  echo "ERROR: missing $TARGET" >&2
  exit 1
fi

python3 - "$TARGET" "${1:-}" <<'PY'
import os
import stat
import sys
import tempfile
from pathlib import Path

target = Path(sys.argv[1])
action = sys.argv[2]
text = target.read_text()

markers = (
    "Tokens after termination are ignored.",
    "if self.matcher.is_terminated():\n                    break",
    "self._is_terminated = False",
)
applied = all(marker in text for marker in markers)
if action == "--status":
    print("vLLM #52805 xgrammar termination:", "APPLIED" if applied else "NOT APPLIED")
    raise SystemExit(0 if applied else 1)
if applied:
    print("[skip] vLLM #52805 xgrammar termination already applied")
    raise SystemExit(0)

old_accept = '''        Returns True if the FSM was advanced successfully.
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
'''
new_accept = '''        Returns True if all grammar-constrained tokens were accepted.
        Tokens after termination are ignored. Returns False if the FSM
        failed to advance.
        """
        if self._is_terminated:
            return True
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
            if self._is_terminated:
                break
        return True
'''
old_validate = '''        accepted_tokens = []
        for token in tokens:
            if self.matcher.accept_token(token):
                accepted_tokens.append(token)
            else:
                break
'''
new_validate = '''        if self._is_terminated:
            return []

        accepted_tokens = []
        for token in tokens:
            if self.matcher.accept_token(token):
                accepted_tokens.append(token)
                if self.matcher.is_terminated():
                    break
            else:
                break
'''
old_reset = '''    def reset(self):
        self.num_processed_tokens = 0
        self.matcher.reset()
'''
new_reset = '''    def reset(self):
        self.matcher.reset()
        self.num_processed_tokens = 0
        self._is_terminated = False
'''

for label, old, new in (
    ("accept_tokens", old_accept, new_accept),
    ("validate_tokens", old_validate, new_validate),
    ("reset", old_reset, new_reset),
):
    if text.count(old) != 1 or text.count(new) != 0:
        raise SystemExit(f"ERROR: ambiguous {label} source in {target}")
    text = text.replace(old, new)

mode = stat.S_IMODE(target.stat().st_mode)
fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
try:
    with os.fdopen(fd, "w") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, mode)
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print("[applied] vLLM PR #52805 xgrammar termination backport")
PY
