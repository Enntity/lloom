# Third-Party Notices

LLooM is licensed under MIT. The following files include or describe material derived from third-party projects and remain subject to their upstream licenses.

## MTPLX

The files under `patches/` contain patch fragments and an application helper for MTPLX:

- Project: MTPLX
- Copyright: 2026 Youssof Altoukhi
- Source: <https://github.com/youssofal/MTPLX>
- License: Apache License 2.0; see [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)

LLooM's changes provide a long-context MLX/Metal watchdog workaround. The patches are not an official MTPLX release and do not imply endorsement by the MTPLX maintainers.

Preferred upstream attribution:

> Powered by MTPLX by Youssof Altoukhi — <https://github.com/youssofal/MTPLX>

MTPLX's upstream NOTICE also identifies Apache-2.0 material from `vllm-metal` and `dflash-mlx`. Consult the upstream repository for the complete dependency and model-license notices that apply to an installed MTPLX distribution.

## MiaAI Lab DeepSeek V4 Flash DSpark Hotfixes

The files under `backends/dspark-vllm/packs/miaai-dsv4flash-909776b5/patches/` are vendored from MiaAI Lab's two-DGX-Spark DeepSeek V4 Flash recipe. The adjacent LLooM manifest and pack runner provide provenance, compatibility, enablement policy, and integrity checks:

- Project: DeepSeek-v4-Flash-DSpark-2x-DGX-Spark
- Source: <https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark>
- Revision: `909776b5f43154e373efe1ba6cd8d61a1d17515d`
- License: MIT

Some patch payloads modify or reproduce small portions of vLLM and retain their Apache-2.0 lineage; see [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt). LLooM adapts the launch integration and testability without representing these hotfixes as an official vLLM release.

## ResembleAI Chatterbox

The optional Chatterbox backend installs and interoperates with ResembleAI's `chatterbox-tts` package; LLooM does not vendor that package or its model weights:

- Project: Chatterbox
- Source: <https://github.com/resemble-ai/chatterbox>
- Copyright: 2025 Resemble AI
- License: MIT

LLooM's server adapter preserves Chatterbox's built-in Perth watermarking. Model downloads and their applicable terms remain the responsibility of the installer.

## Qwen Fixed Chat Templates

`assets/chat-templates/qwen-fixed-v21.3.jinja` is copied from Froggeric's Qwen Fixed Chat Templates:

- Project: Qwen Fixed Chat Templates
- Source: <https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates>
- Revision: `23a40b0bd4d197c31d39e3c442fd2cd6100b3971`
- License: Apache License 2.0; see [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)
