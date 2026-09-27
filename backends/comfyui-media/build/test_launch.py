import os
import subprocess
import sys

LAUNCH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "launch.py")


def test_launch_refuses_to_serve_without_a_single_model():
    for value in (None, "", "  "):
        env = {k: v for k, v in os.environ.items() if k != "LLOOM_MEDIA_MODEL"}
        if value is not None:
            env["LLOOM_MEDIA_MODEL"] = value
        result = subprocess.run([sys.executable, LAUNCH], env=env, capture_output=True, text=True, timeout=30)
        assert result.returncode != 0
        assert "LLOOM_MEDIA_MODEL is required" in result.stderr
