# macOS sensors

`macos-sensors.swift` extracts the read-only GPU and thermal readers from Tessera
commit `8a6e80256cfc8c739d2fd4ff360311d858a8f890`. See LICENSE-TESSERA.
`accord install` compiles it into the private data directory when Apple developer tools
are present; without them, CPU and memory telemetry still work. It prints one JSON
snapshot and exits. IOHID symbols are resolved dynamically;
unavailable sensors produce null. The OS may change this private sensor API.

The helper is built from source for the current architecture and targets macOS 13+.
No prebuilt executable is bundled. Run `accord install` again to build a missing
helper after installing the Apple command line developer tools.
