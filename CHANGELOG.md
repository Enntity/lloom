# Changelog

All notable changes to LLooM will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends to use [Semantic Versioning](https://semver.org/) for public releases.

## [Unreleased]

### Added

- Immutable recipe-version archives with index-declared current/history metadata and validation.
- MLX Audio speech and transcription discovery, named voice profiles, and Qwen3-TTS support.
- Reasoning normalization across OpenAI-compatible, Responses, and Anthropic-compatible protocol surfaces.
- Qwen3.6 35B-A3B OptiQ recipe and context benchmark helper.
- Public project governance, security, contribution, CI, and release metadata.

### Fixed

- DGX Spark Unsloth Qwen3.6-27B now defaults to the measured released vLLM 0.25.0 runtime instead of nightly.
- Detached CLI runtime starts no longer keep the command process open through inherited output pipes.
- Native chat-client artifacts remain chat-only while discovery APIs advertise all supported model kinds.

## [0.2.0] - 2026-07-08

### Added

- Local-first gateway, runtime manager, guarded setup flows, community recipe packs, benchmark evidence, and generated client integrations.
- OpenAI-compatible chat, Responses, embeddings, image, speech, and transcription routes.
- Anthropic-compatible Messages support, including streaming and tool use.
- Apple Silicon and NVIDIA DGX Spark backend and recipe coverage.

[Unreleased]: https://github.com/enntity/lloom/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/enntity/lloom/releases/tag/v0.2.0
