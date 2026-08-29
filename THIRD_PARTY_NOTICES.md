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

The files under `backends/dspark-vllm/packs/miaai-dsv4flash-d1b76251-defaults/patches/` are vendored from MiaAI Lab's two-DGX-Spark DeepSeek V4 Flash recipe. The adjacent LLooM manifest and pack runner provide provenance, compatibility, enablement policy, and integrity checks. The `miaai-dsv4flash-d1b76251` and earlier `miaai-dsv4flash-909776b5` packs remain packaged for recipe-v8 and recipe-v7 rollback:

- Project: DeepSeek-v4-Flash-DSpark-2x-DGX-Spark
- Source: <https://github.com/MiaAI-Lab/DeepSeek-v4-Flash-DSpark-2x-DGX-Spark>
- Current revision: `d1b76251535daef578d8751b04b39c29ad7ecdf9`
- Archived revision: `909776b5f43154e373efe1ba6cd8d61a1d17515d`
- License: MIT

Some patch payloads modify or reproduce small portions of vLLM and retain their Apache-2.0 lineage; see [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt). LLooM adapts the launch integration and testability without representing these hotfixes as an official vLLM release.

## MiaAI Lab GLM-5.3 Flash EXL3 Runtime Overlays

The chat template and fail-closed runtime patchers under `backends/glm53-exl3/`
are vendored from MiaAI Lab's two-DGX-Spark GLM-5.3 Flash EXL3 recipe. LLooM
adds an immutable container/model pin, declarative distributed lifecycle, and a
sidecar-coexistence memory profile:

- Project: GLM-5.3-Flash-EXL3-2x-DGX-Sparks
- Source: <https://github.com/MiaAI-Lab/GLM-5.3-Flash-EXL3-2x-DGX-Sparks>
- Revision: `0e2e78f3de83624e6733b918724da27fc9040156`
- License: MIT

The XGrammar patcher source-exactly backports portions of vLLM PRs 52805 and
53046 and retains their Apache-2.0 lineage; see
[`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt). The model checkpoints and
DFlash2 drafter remain subject to their own upstream licenses.

## MiaAI Lab Qwen3.8 Flash Next SM121 Kernels

The QSA fallback, NVFP4 KV-cache implementation, and source patcher under
`backends/qwen38-sglang/` are vendored from MiaAI Lab's two-DGX-Spark
Qwen3.8 Flash Next recipe. LLooM adds a managed-container installer,
immutable image/model pins, distributed lifecycle configuration, and a
sidecar-oriented memory profile:

- Project: Qwen3.8-Flash-Next-Dual-DGX-Sparks
- Source: <https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Dual-DGX-Sparks>
- Revision: `f87d586e269df171089a879ee33a5356c0570e70`
- License: MIT

The vendored files retain their upstream technical commentary. The adjacent
`NOTICE.md` records exact source hashes. These patches are an SM121 community
compatibility path, not an official SGLang or Qwen release.

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
