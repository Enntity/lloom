"""Sanitized public errors.

Nothing that reaches the client may contain a filesystem path, a Comfy
endpoint, or any other backend detail.
"""

from __future__ import annotations


class BridgeError(Exception):
    """An error that is safe to return to the caller."""

    def __init__(self, status_code: int, err_type: str, message: str, code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.err_type = err_type
        self.message = message
        self.code = code

    def body(self) -> dict:
        return {"error": {"message": self.message, "type": self.err_type, "code": self.code or self.err_type}}


def bad_request(message: str, code: str) -> BridgeError:
    return BridgeError(400, "invalid_request_error", message, code)


def unsupported_model(model: str, supported: list[str]) -> BridgeError:
    return BridgeError(
        400,
        "invalid_request_error",
        f"Unsupported model {model!r}. Supported models: {', '.join(supported)}.",
        "unsupported_model",
    )


def busy() -> BridgeError:
    return BridgeError(429, "rate_limit_error", "A generation is already in progress.", "busy")


def backend_unavailable(message: str = "Media backend is unavailable.") -> BridgeError:
    return BridgeError(503, "api_error", message, "backend_unavailable")


def backend_error(message: str = "Media backend failed to complete the request.") -> BridgeError:
    return BridgeError(502, "api_error", message, "backend_error")


def rejected(message: str, code: str) -> BridgeError:
    return BridgeError(400, "invalid_request_error", message, code)
