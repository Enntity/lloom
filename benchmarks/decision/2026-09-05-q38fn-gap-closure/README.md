# Qwen TP2 published-performance gap closure

Recipe v6 deployed and verified, September 5, 2026, 20:21 UTC. Both ranks run
the final 20 GiB-per-rank configuration. The public q38fn alias is resumed,
local first and cloud second; an attributed public local canary passed.

| Measurement | Previous deployed v5 | Final v6 | Published reference |
| --- | ---: | ---: | ---: |
| Sufyan short prose, C1 median, tok/s | 30.095 | 41.969 | 43.2 |
| Same test median TTFT | 214.9 ms | 165.2 ms | 170 ms |
| sparkDash hash-map prose, C1, tok/s | Not measured | 52.263 | Mia 52.1 before / 54.4 latest |
| Cold prefill, C1 | Not measured on this prompt | 2941 tok/s, 30044 tokens | Mia 2962 at 32806 tokens |

The matched Sufyan test improved **39.46%** and is **2.85% below** the reference.
Three sequential runs use the exact prompt, thinking off, greedy, 200-token cap,
natural stop and `(completion_tokens - 1) / (stream_end - first_content)`.
All three completed with 95 output tokens and exact local attribution.

The hash-map test uses sparkDash's prompt and current 400-token default, a
32-token warmup, forced length, greedy and first-to-last-content timing. Three
runs measured 52.19–52.54 tok/s; the median is reported. Acceptance is 69.15%
including warmup versus 51.75% on the shorter Sufyan prose. This illustrates why
prompts cannot be mixed when comparing MTP speed. Mia does not publish her
capture's maxTokens setting; this is a protocol comparison, not proof of the
identical historical run. Her latest result also uses reduced draft vocabulary.
Our forced-length hash test is a speed probe, not a complete-answer quality gate.

The cold prefill probe retrieves the exact final passcode from 30044 tokens in
10.214s. Prefix caching is disabled. Its prompt differs from Mia's; the two
prefill values show the same approximate range, not an exact A/B win.

## Configuration and provenance

See [the deployment note](../../../docs/q38fn-gap-closure-2026-09-05.md),
[final-recipe.json](final-recipe.json). Host-specific configuration receipts remain private.
Official NVIDIA revision `fab0aecb760cec45227f6656abcaafa11abca87a`, vLLM
`e962733e08d10f7ca65dac4df99e116460b8b174`, immutable ARM64 digest, TP2, GPU-resident
FP8 PLE, BF16 KV, full draft vocabulary, MTP3, compilation mode 0 and
FULL_DECODE_ONLY. Prefix caching and expert parallelism remain off.

The final 20 GiB BF16 KV allocation provides **1372997 token slots / 5.24 native
262144-token contexts**. LLooM permits four active requests and eight queued.
This is cache capacity, not a validated four-full-context retrieval claim.
The initial 12 GiB candidate had 824088 slots, measured 41.874 tok/s, and passed
five functional plus twelve queue checks before the permanent promotion.

Source references:

- [Sufyan fe8c291d](https://github.com/sfxnz/Qwen3.8-Flash-Next-NVFP4-vLLM-2x-DGX-Spark/tree/fe8c291de4efba34d5dcedbc8e19ebcf66bc1bc2): launcher, image and matched prose benchmark.
- [Tony ecab8552](https://github.com/tonyd2wild/Qwen3.8-Flash-Next-NVFP4-DGX-Spark/tree/ecab8552325655f765173adf66c9981e28197d61): reviewed PLE state-stride and mixed MTP loader corrections; source notices retained.
- [Mia c2325b22](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Dual-DGX-Sparks/tree/c2325b22602b51a5faf55fc2bebccc34f3f80b9f): comparison captures; no Mia AGPL serving code copied.
- [sparkDash cc44d352](https://github.com/MiaAI-Lab/sparkDash/tree/cc44d3527e7ddd339f513bb205dce4f37072beff): inspected benchmark protocol; the local harness is independently written.

## Evidence files and boundaries

`qwen-resident-*` files are the first 12 GiB trial. `qwen-v6-*` files are the
permanent 20 GiB configuration. The helper scripts authenticate from managed
local state without storing keys. All inference goes through `q38fn-local` or
the public `q38fn` gateway alias; private backend reads collect metrics only.
Final startup logs are restricted to the final restart time window.

Other large local runtimes remain disabled and unpinned. Bounded memory guards
watch only the candidate container; their aggregate minima are reported below; raw host samples remain private.
The public cloud member was verified while local was suspended; that tests
cloud route availability, not an induced mid-stream failover. The local-first
route is verified separately after final gates.

The archived v5 recipe, image, source assets and both checkpoints remain
available for managed rollback. No model was loaded alongside DeepSeek. No
million-token or GLM intelligence-parity claim follows from these speed tests.

## Final validation

Five smoke checks (including streaming structured tools and vision), twelve
concurrent/repeated-context requests and six complete prose/code/reasoning
answers passed. All were attributed locally. The queue reached four active
and two queued, then drained to zero. Code inspection confirmed the merge
implementation preserves inputs and handles empty tails; both arithmetic
answers gave the correct 12:09 arrival. Prose was coherent and relevant.
The six-answer generated-token median, including low reasoning, improved
from v5's 36.352 to **55.072 tok/s**; this is separate from the thinking-off
published-prompt measurements.

Minimum MemAvailable through final loading and tests was **17.92 GiB leader /
21.98 GiB worker**. Neither bounded guard triggered; both were stopped after
validation. The figures above describe the final configuration, rather than the earlier staged trial. At the validation snapshot the logical cluster was running, pinned, idle and error-free.

Focused recipe source guards, interchange, ESLint and diff checks passed.
The final package contains 582 files and its installation smoke passed after
rerunning outside the sandbox to permit the required loopback test listener.
No unrelated dirty gateway source was deployed. This public record includes portable recipes, synthetic results and reproduction harnesses. Machine configuration receipts and operational logs are retained locally.
