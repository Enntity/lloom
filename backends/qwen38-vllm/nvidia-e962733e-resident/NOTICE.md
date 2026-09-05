# Sufyan-reference full-decode TP2 launcher

Uses pinned vLLM e962733e and the guarded PLE/MTP source bundle in sibling
`nvidia-e962733e` (Apache-2.0; original authors credited there). Launcher MIT.
Matches Sufyan fe8c291d: official NVIDIA quant, GPU-resident FP8 PLE, BF16 KV,
MTP3, TP2, full decode CUDA graphs, compilation mode 0, native 262144 context.
LLooM adds private routing, admission and explicit 20 GiB KV allocation per rank.
Prefix caching remains disabled. The prior failed experiment on this image
used PIECEWISE with torch.compile; this is a distinct configuration.
See docs/q38fn-gap-closure-2026-09-05.md for measured evidence and limitations.
