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

## Qwen Fixed Chat Templates

`assets/chat-templates/qwen-fixed-v21.3.jinja` is copied from Froggeric's Qwen Fixed Chat Templates:

- Project: Qwen Fixed Chat Templates
- Source: <https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates>
- Revision: `23a40b0bd4d197c31d39e3c442fd2cd6100b3971`
- License: Apache License 2.0; see [`LICENSES/Apache-2.0.txt`](LICENSES/Apache-2.0.txt)
