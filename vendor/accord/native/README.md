# macOS sensors

`macos-sensors.swift` extracts the read-only GPU and thermal readers from Tessera
commit `8a6e80256cfc8c739d2fd4ff360311d858a8f890`. See LICENSE-TESSERA.
It prints one JSON snapshot and exits. IOHID symbols are resolved dynamically;
unavailable sensors produce null. The OS may change this private sensor API.

Run `npm run build:sensors` on macOS to build the current architecture's helper
with the installed Swift toolchain. The bundled arm64 executable targets macOS
13+. CPU/memory collection works without this executable. The source installer
can build a missing helper into its private data directory.
