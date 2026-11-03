# Host telemetry

Each Accord host reads its own sensors. Agents and other tools can ask that
host directly or ask their local Accord service to forward the request over an
existing authenticated host link. No samples are published to the coordination
database, mailbox, or event journal. There is no background sampling when idle.

```
agent or tool → local Accord → SSH host link → owning host → sensors
```

```sh
accord telemetry                    # live local readings
accord machine                      # local hardware inventory
accord telemetry --host AUTHORITY   # same interface for a linked host
accord machine --host AUTHORITY
```

MCP exposes `accord_telemetry` and `accord_machine`, each with optional `host`.
The SDK exposes `client.telemetry(host)` and `client.metadata(host)`.
HTTP clients use:

- `GET /v1/host/telemetry`
- `GET /v1/host/metadata`
- `GET /v1/hosts/{authority}/telemetry`
- `GET /v1/hosts/{authority}/metadata`

Use a session, administrator, or read-only discovery bearer credential. Host
forwarding uses the installed link credentials and pins the remote authority.
A discovery credential cannot reserve resources or launch work. Link peers cannot
supply shell commands or probe paths through these endpoints.

## Freshness and failure

Telemetry has a two-second memory cache; hardware metadata has a five-minute
cache. Concurrent readers share one collection. A refresh waits at most 2.2
seconds; each subprocess has a 1.5-second timeout, a forced kill on timeout, and
a 512 KiB output cap. A hung collector retains its single flight, so repeated
requests cannot spawn an accumulating probe backlog. Failed collection retries
are delayed by two seconds. Caches vanish on restart.

Responses contain `schema: 1`, `authority`, `hostname`, `sampledAt` (Unix
milliseconds at collection start), `ageMs` (monotonic elapsed time at the host),
`stale`, `status`, `refreshAfterMs`, and either `host` or `machine`. Add local elapsed
time to `ageMs` while displaying a response. Cross-host clock synchronization is
not required to interpret age. HTTP forwarding adds network delay.

Status is `available`, `partial`, `stale`, or `unavailable`. A missing individual
reading is `null`; each collector reports availability and a bounded reason.
Partial means some fields are unavailable or estimated, not that the whole host
is unreachable. CPU utilization is null until two samples exist. On a whole
collector failure a last-good sample may remain with `stale: true`; with no prior
sample the payload is null. An unreachable linked host returns an error, never
another host's readings. Consumers must age or clear their display on errors.

Telemetry is observational. It grants no resource rights, and an idle GPU is not
proof that it is unreserved. Check and acquire through Accord's reservation API.
LLooM admission must reject stale/unavailable memory and decide whether to accept
estimated memory; these endpoint reads do not replace its admission transaction.

## Field coverage

| Data | Fields and sources |
| --- | --- |
| CPU | Utilization percentage from successive OS CPU counters, logical CPUs, model, load averages, uptime |
| Host memory | Total/free/used/available bytes, utilization and pressure utilization percentages; Linux MemAvailable, macOS memory pages, explicitly estimated OS fallback |
| NVIDIA GPU | Per-device name/index, utilization, memory used/total in MiB, temperature C, power W, performance state, SM and memory clocks MHz via nvidia-smi |
| Apple GPU | Utilization via IOKit; hottest SoC die temperature via Tessera's IOHID collector |
| Linux temperatures | Named thermal-zone and hwmon sensors plus hottest reading |
| AMD GPU | Linux amdgpu sysfs utilization, VRAM and GTT separately, temperature and power where readable |
| Storage | Root filesystem total, available and free bytes |
| Network | Linux interface state, speed Mbps and cumulative RX/TX bytes; no traffic sampling loop |
| Hardware inventory | OS/architecture/release, CPU model/count, total host memory, accelerator IDs/vendor/backend; NVIDIA UUID, compute capability, driver and PCI bus; Apple GPU/ANE inventory |

Sensor support varies. Unified-memory NVIDIA systems often report GPU memory as N/A:
host unified memory is reported separately, never copied into a fictitious VRAM
counter. Apple GPU memory, power, clocks, and ANE utilization remain null/unavailable.
AMD is fixture-tested through standard DRM/sysfs, not hardware-qualified. Network
counters on macOS/Windows and vendor-specific topology are not implemented here.

## Adapters

`src/telemetry.mjs` includes optional helpers that shape a response for two related
open-source projects: `lloomMachineInput(response)` for
[LLooM](https://github.com/Enntity/lloom) and `tesseraVitals(response)` for
[Tessera](https://github.com/Enntity/tessera). Neither project is required. The macOS
sensor helper is extracted from Tessera and retains its license and attribution.

Collectors implement `snapshot()` and `metadata()`. They return ordinary objects
and availability records, have no store access, and do not enforce ownership.
The cache accepts an injected collector, allowing a future platform package to
reuse transport and freshness behavior. There is no executable upload/plugin
installation API; administrator-installed code remains the trust boundary.
Resource enforcement plugins remain separate from sensor collectors.

## Installation and qualification

On macOS, `accord install` compiles an optional sensor helper from
`native/macos-sensors.swift` when Apple developer tools are already installed.
Accord ships no prebuilt binary. Missing tools leave CPU/memory available and mark
native sensors unavailable. No sudo, driver installation, or toolchain download
is performed. Linux uses existing nvidia-smi and readable proc/sysfs files.

`npm test` uses injected fixtures for all sensors. It tests cache coalescing,
missing/malformed sensors, bounded hangs, Mac/NVIDIA/AMD field conversions,
authentication, host identity changes, remote outages, and unchanged ownership
and journal counts while polling a held resource. `npm run verify` also runs the
existing process and artifact crash/recovery demos.

`scripts/qualify-telemetry.mjs --confirm-live` is a separate opt-in real-host
qualification. It runs temporary services through the normal SSH connector,
checks direct/forwarded sample identity, no coordination writes, CPU warmup,
cache refresh/restart and host outage.
