# Changelog

All notable changes to LLooM will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends to use [Semantic Versioning](https://semver.org/) for public releases.

## [Unreleased]

### Added

- Guarded `lloom remove-model` planning and apply support with shared-resource protection, config backups, and opt-in weight deletion.
- One-step `lloom add-model <ref> --go` backend installation, model download, configuration, runtime startup, warmup, and health verification.
- Immutable recipe-version archives with index-declared current/history metadata and validation.
- MLX Audio speech and transcription discovery, named voice profiles, and Qwen3-TTS support.
- Reasoning normalization across OpenAI-compatible, Responses, and Anthropic-compatible protocol surfaces.
- Qwen3.6 35B-A3B OptiQ recipe and context benchmark helper.
- A separate DGX Spark ThinkingCap Qwen3.6-27B NVFP4 candidate recipe on released vLLM 0.25, preserving the established Unsloth default while token-efficiency and quality evidence are collected.
- Public project governance, security, contribution, CI, and release metadata.

### Fixed

- Keep-warm startup now admits models in priority order, preserves already loaded runtimes, and warns and continues when a model does not fit.
- MLX LM installs into a LLooM-managed Python environment, avoiding macOS externally-managed Python failures.
- `lloom down` now stops the managed gateway service as well as its managed model backends.
- DGX Spark Unsloth Qwen3.6-27B now defaults to the measured released vLLM 0.25.0 runtime instead of nightly.
- Detached CLI runtime starts no longer keep the command process open through inherited output pipes.
- Native chat-client artifacts remain chat-only while discovery APIs advertise all supported model kinds.

## [0.2.3] - 2026-07-17

### Changed

- Compacted the live-topology HUD into a single-line period and metrics cluster, moved live status beside the title, automatically refit the camera when switching model scopes, and accelerated model-card settling.

## [0.2.2] - 2026-07-17

### Added

- Live-topology aging for cold models after 60 minutes without activity, with a fixed control to reveal the full inactive catalog.

## [0.2.1] - 2026-07-17

### Added

- Persistent aggregate gateway metrics with daily rollups, restart recovery, and Today / 7 Days / 30 Days / All Time dashboard periods.
- Image-edit routing and long-running media request handling for the DGX Spark image lanes.

### Changed

- The dashboard is now centered on the live topology with fixed overlays, model inspection and controls, and an explicit active-compute animation.

## [0.2.0] - 2026-07-08

### Added

- Local-first gateway, runtime manager, guarded setup flows, community recipe packs, benchmark evidence, and generated client integrations.
- OpenAI-compatible chat, Responses, embeddings, image, speech, and transcription routes.
- Anthropic-compatible Messages support, including streaming and tool use.
- Apple Silicon and NVIDIA DGX Spark backend and recipe coverage.

[Unreleased]: https://github.com/enntity/lloom/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/enntity/lloom/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/enntity/lloom/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/enntity/lloom/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/enntity/lloom/releases/tag/v0.2.0
