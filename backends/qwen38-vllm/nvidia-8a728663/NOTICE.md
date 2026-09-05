# NVIDIA Qwen3.8 Flash Next TP2 overlay bundle

The eight overlay files are unmodified copies from Tony DeAngelo / Tech2Wild,
written by Kai, at
[ecab8552325655f765173adf66c9981e28197d61](https://github.com/tonyd2wild/Qwen3.8-Flash-Next-NVFP4-DGX-Spark/tree/ecab8552325655f765173adf66c9981e28197d61/single-spark-vllm-tp1).
They retain Apache-2.0 licensing and upstream vLLM notices. See LICENSE.
The manifest pins both the input vLLM files and overlay payloads; the installer
refuses any unknown input before writing any file.

The bundle includes disk-backed PLE, piecewise graph splitting, the concurrent
PLE state-stride fix from peakcrosser7 / vLLM PR 55375, QSA FP8 KV support from
andreasgru / PR 54846, and NVIDIA mixed-quant MTP dispatch/loading repairs.
Upstream credits sfxnz and MiaAI for related MTP investigations and fixes.

MiaAI's September 5 release at c2325b22602b51a5faf55fc2bebccc34f3f80b9f was
reviewed for NVIDIA checkpoint, FP8 KV, and reduced draft vocabulary findings.
No AGPL files from that repository or Tony's legacy SGLang reference kernel
are included. Reduced vocabulary remains off: its measured acceptance/copy
regressions need workload-specific evaluation.

LLooM's launcher, guarded installer and tests are MIT. NVIDIA checkpoint files
are downloaded separately at revision fab0aecb760cec45227f6656abcaafa11abca87a;
this bundle does not transform or redistribute weights.
