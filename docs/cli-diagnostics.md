# Gateway diagnostics

Gateway commands distinguish authentication (401), authorization (403), connection refusal,
timeout, HTTP request rejection, and server errors. They do not retry rejected admin requests
without authentication. An offline local fallback is used only by commands that explicitly
support it, and only after a connection refusal.

For a service-managed installation, set `LLOOM_ADMIN_API_KEY` in the calling environment,
or pass `--admin-api-key-env VARIABLE_NAME` to select another environment variable.
An explicitly selected variable overrides a saved credential and must be set and nonempty.
The option accepts the variable name; never pass the credential value on the command line.
The default variable overrides the saved credential. Otherwise the configured admin key
is used, falling back to an inference key only when no admin key is configured.

With `--json` (or `--format json`), failures are written to stderr as
`{ "ok": false, "error": { "code": "gateway_auth_failed", "kind": "auth", "status": 401, "message": "..." } }`.
Known safe LLooM codes are also returned as `error.upstreamCode`. Arbitrary upstream
messages and codes are excluded because they can echo credentials. Authentication and
authorization errors exit with status 3; other failures exit with status 1.
