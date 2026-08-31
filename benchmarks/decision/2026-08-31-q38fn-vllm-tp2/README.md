# Qwen3.8 Flash Next vLLM TP2 decision

Date: 2026-08-31

## Fixed serving stack

- Two DGX Sparks, TP=2 plus expert parallel over the private RoCE fabric
- MiaAI upstream commit `169fbad266f2791335a3102f0d3d625e7c295563`
- vLLM ARM64 image manifest `sha256:3b0e188ffceb3d07e09c3cb5215433a0020eacf02d7f882ed3a8bfd15454477e`
- RadixArk model revision `7b719225242aacd3dbd3f9407468c2ee9a9d2594`
- Native 262,144 context, BF16 hybrid KV, GPU memory utilization 0.835, prefix caching, decode-only graphs
- Entity-shaped prompts of 80-220 KB, 384 output-token ceiling, tools enabled, five-second stagger
- Production `q38fn` local member suspended during all probes; benchmark traffic used `q38fn-local`

## Concurrency sweep

Aggregate completion throughput is completion tokens divided by suite makespan. Tool-call completion lengths are intentionally workload-realistic and stochastic, so the production knee uses repeated gateway results plus the direct-backend cross-check.

| MTP | Path | Concurrency | Pass | Aggregate tok/s | Makespan (s) |
| --- | --- | ---: | :---: | ---: | ---: |
| 3 | gateway | 2 | yes | 18.17 | 53.15 |
| 3 | gateway | 3 | yes | 21.49 | 45.83 |
| 3 | direct | 4 | yes | 23.60 | 52.70 |
| 3 | direct | 5 | no | 20.66 | 72.60 |
| 3 | direct | 6 | yes | 27.27 | 77.15 |
| 3 | direct | 7 | yes | 26.12 | 86.06 |
| 3 | direct | 8 | yes | 23.95 | 101.66 |
| 3 | gateway | 4 | yes | 22.16 | 62.41 |
| 3 | gateway | 5 | yes | 22.66 | 64.79 |
| 3 | gateway | 6 | yes | 21.98 | 79.92 |
| 3 | gateway | 6 repeat | yes | 23.86 | 79.73 |
| 3 | gateway | 7 | yes | 29.13 | 85.92 |
| 3 | gateway | 7 repeat | yes | 25.25 | 89.20 |
| 3 | gateway | 8 | yes | 27.95 | 101.47 |
| 3 | gateway | 8 repeat | yes | 27.46 | 101.79 |
| 1 | gateway | 7 | yes | 24.66 | 90.99 |
| 1 | gateway | 8 | no | 21.54 | 117.94 |

Across the direct run and two gateway runs, MTP-3 concurrency 7 averaged 26.83 tok/s versus 26.45 tok/s at concurrency 8. In the repeated gateway probes, the oldest request completed in 85.1-88.0 seconds at seven versus 94.1-101.0 seconds at eight. Its decode rate was 5.7-5.9 tok/s at seven versus 3.7-4.7 tok/s at eight.

## Speculative decode

MTP-3 accepted 10,901 of 18,030 draft tokens (60.46%). Acceptance by draft position was 4,530/6,010 (75.37%), 3,556/6,010 (59.17%), and 2,815/6,010 (46.84%). Despite the weaker third position, MTP-3 outperformed MTP-1 on the matched entity workload.

The MTP-1 concurrency-8 probe completed every client stream but left two backend sequences generating. That failed the benchmark's clean-drain gate and disqualifies MTP-1 independently of its lower throughput.

## Decision

Use MTP-3 with `maxActiveRequests: 7`. Keep the LLooM queue bounded at eight additional requests. Seven is the measured throughput knee across the combined direct and gateway evidence; eight provides no repeatable aggregate advantage and materially degrades oldest-request fairness.
