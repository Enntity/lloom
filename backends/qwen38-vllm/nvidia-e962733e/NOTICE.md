# NVIDIA Qwen3.8 Flash Next latest-nightly comparison

The initial September 5 trial used PIECEWISE with torch.compile and both hosts
became unresponsive during compilation. Previous-boot NVIDIA allocation errors
are recorded, but do not isolate the cause. That configuration remains rejected.

Recipe v6 uses this guarded source bundle with the sibling
`nvidia-e962733e-resident/entrypoint.sh`: compilation mode 0, FULL_DECODE_ONLY,
and an explicit BF16 KV budget. That distinct configuration passed startup and
functional gates. See the gap-closure evidence for exact final validation.
The entrypoint in this directory is historical and is not selected by v6.

Apache-2.0 upstream vLLM e962733e08d10f7ca65dac4df99e116460b8b174 with
Tony/Tech2Wild ecab8552325655f765173adf66c9981e28197d61 PLE and MTP fixes.
Five files ported with three-way source comparison; original notices retained.
LLooM installer, launcher and tests are MIT.

Retains newer QSA packed sparse selection and prefill/decode optimizations,
compact indexer workspaces, and MTP HC combine-norm. Its native BF16 KV is used;
older FP8/NVFP4 QSA patches are not compatible by simple file replacement.
The PLE state-stride fix, disk-reader option and mixed-quant MTP loader survive
unchanged; modelopt also retains the newer upstream FP8 MoE clamp support.
GPU-resident PLE is selected for the TP2 comparison. Official NVIDIA model
revision fab0aecb760cec45227f6656abcaafa11abca87a is unchanged.

No MiaAI AGPL files are included. See the sibling nvidia-8a728663 NOTICE for
upstream authors and the original eight-file FP8-KV alternative.
