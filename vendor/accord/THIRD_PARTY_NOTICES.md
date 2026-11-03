# Source provenance

`vendor/messenger/` holds `store.js`, `auth.js` and `errors.js`, copied unchanged from
Enntity Messenger at `08a788e`. Token creation, SHA-256 credential hashing,
constant-time equality, and bearer parsing in `src/common.mjs` are adapted from its
`src/auth.js`, and its SQLite transaction and numbered-migration patterns informed the
local storage helpers. Messenger is MIT licensed, Copyright (c) 2026 Enntity
contributors; its permission notice is reproduced in this repository's LICENSE.

`vendor/lloom/host-memory.mjs` is copied unchanged from LLooM at `bcce316`, and parts of
the telemetry collector are adapted from it; see `vendor/lloom/README.md`. LLooM's
`src/schedule.mjs` and `docs/reservations.md` informed the held-state and
failed-restoration rules. The reservation code here is a separate SQLite state machine
with an independent artifact driver and no model-routing actions. LLooM is MIT licensed,
Copyright (c) 2026 LLooM contributors. Its license notice follows.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Tessera installer and integration approach

The CLI + skill + MCP installation flow, preservation of existing user settings,
and session-start integration design follow Tessera at `09b5c27`, particularly
`Sources/TesseraCLI/Installer.swift` and `docs/control-plane.md`. The Node installer is
an independent implementation. `native/macos-sensors.swift` is extracted from Tessera;
see `native/README.md`. Tessera is MIT licensed.

MIT License

Copyright (c) 2026 Tessera contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
