# Hybrid prefix-cache corrections

The block-size diagnosis and two corrections derive from
`blazux/qwen3.8-Flash-DGX` at
`bd60fcb1b492ca920f74df7462f05da7b6d98f73`,
`src/patch_mamba_block_size.py` (Apache-2.0).

https://github.com/blazux/qwen3.8-Flash-DGX/blob/bd60fcb1b492ca920f74df7462f05da7b6d98f73/src/patch_mamba_block_size.py

Target source remains copyright the vLLM contributors, Apache-2.0.
The installer adds exact input-hash guards, validates both files before mutation,
and accepts only the known original or known patched state on rerun.
No model weights, QSA kernel, draft vocabulary, or quantization are changed.

The retention-1600 configuration passed repeated-prefix semantic equivalence,
structured tools and continuation, vision, bounded queue admission, and exact
239K-context retrieval on TP2. See docs/q38fn-prefix-cache-2026-09-09.md and the
September 9 benchmark evidence for controls, tradeoffs and final live status.
