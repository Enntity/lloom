# LLooM Hear

LLooM Hear analyzes audio on the CPU and returns a Markdown report, structured
measurements, and an optional dashboard image. It estimates loudness, tempo, key,
timbre, and changes in the signal. An optional upstream model can add a generated
description.

## Setup

Install Python 3.11 or newer, `ffmpeg`, and `ffprobe` on the host, then run:

```sh
lloom setup --recipe lloom-hear --additive --apply --yes
lloom runtime-start hear
```

The installer creates a managed Python environment and the `lloom-hear-server`
shim. Direct Python dependencies are pinned in the installer; transitive packages
are resolved by pip. The recipe binds the backend to loopback. Access it through
the authenticated LLooM gateway.

## Request

Send a non-streaming chat completion with an inline audio part:

```sh
curl http://127.0.0.1:8100/v1/chat/completions \
  -H 'Authorization: Bearer <gateway-key>' \
  -H 'Content-Type: application/json' \
  -d '{"model":"hear","stream":false,"messages":[{"role":"user","content":[
    {"type":"input_audio","input_audio":{"data":"<base64>","format":"wav"}},
    {"type":"text","text":"Describe this audio."}
  ]}],"hear":{"interpret":false,"image":true}}'
```

The optional `hear` object accepts `start` and `end`, or `start` and `duration`,
in seconds. A window can also be parsed from text such as
`"what happens from 0:12 to 0:22?"`. Analysis is capped at the configured maximum
duration. Invalid windows and oversized inputs are rejected.

`image_delivery` accepts `inline`, `url`, or `none`. Inline PNG data is returned in
`hear.images`; it is referenced rather than embedded in the Markdown report.
URL delivery is intended for local callers that can reach the backend. The backend
returns Markdown in JSON completions. It does not support streaming or
schema-constrained output.

Inline base64 contributes to the gateway's prompt-size estimate. The recipe uses
a large context allowance to accommodate audio payloads; this does not describe an
upstream language model's context capacity. Keep clips short and observe the
backend's input limits.

## File and URL inputs

Inline audio is enabled by default. Local file parts require both
`LLOOM_HEAR_ALLOW_LOCAL_FILES=true` and `LLOOM_HEAR_ALLOWED_INPUT_DIRS`, a
colon-separated list of readable directories. Paths and symlinks must resolve
inside one of those directories.

Remote audio parts require `LLOOM_HEAR_ALLOW_URL_FETCH=true`. Fetches accept
HTTPS public addresses, refuse redirects, and enforce a download limit. Request,
input, and download limits default to 64 MiB; analysis defaults to 300 seconds.
Use `LLOOM_HEAR_MAX_REQUEST_BYTES`, `LLOOM_HEAR_MAX_INPUT_BYTES`,
`LLOOM_HEAR_MAX_DOWNLOAD_BYTES`, and `LLOOM_HEAR_MAX_ANALYSIS_SECONDS` to
configure those limits.

## Optional interpretation

Interpretation is off by default. Setting `hear.interpret` to `true` sends the
analyzed audio segment and the caller's query to the configured upstream model.
That model may use an external provider. Configure the route and its credentials
before enabling this option.

The operator sets `LLOOM_HEAR_UPSTREAM_URL`, `LLOOM_HEAR_UPSTREAM_MODEL`, and
`LLOOM_HEAR_UPSTREAM_KEY` (or `LLOOM_API_KEY`). The recipe supplies a loopback
gateway URL and a model identifier; it does not provision that model or an API key.
Request-level model selection is restricted to the comma-separated
`LLOOM_HEAR_ALLOWED_INTERPRET_MODELS` list. `LLOOM_HEAR_ALLOW_INTERPRET=true`
changes the default for requests that omit `hear.interpret`.

## Output and limitations

The response contains an ordinary completion and a `hear` extension with
`source`, `dsp`, `interpretation`, `images`, `trust`, and `timings_ms` fields.

- Silence causes DSP abstention. Noise-like signals withhold tempo and key.
  Handle `dsp.abstain`, `tempo.withheld`, and `key.withheld` before reading estimates.
- Tempo can be ambiguous by a factor of two. Key estimates include alternatives
  and ambiguity flags; these are heuristic estimates, not calibrated confidence.
- Section boundaries describe signal changes, not verse/chorus structure.
- Generated interpretation can be wrong. Its prompt asks it to avoid numerical
  measurements, but prompt instructions cannot guarantee that behavior. DSP
  abstention or noise detection suppresses the generated description.
- There is no melody, chord-symbol, stem, or lyric extraction. Use a transcription
  backend for speech.
- Inline image files are removed after encoding. Local URL artifacts expire
  after an hour and are pruned to a bounded store during use.
- At most two analyses are admitted. Abandoned requests retain their slot until
  their work finishes; excess requests receive HTTP 429.
- DSP work runs in threads and cannot be interrupted mid-analysis. Subprocess and
  network deadlines bound those stages; client disconnection does not guarantee
  immediate compute reclamation.

The dashboard aligns spectrogram, chromagram, loudness, and novelty on a common
time axis. No cross-platform accuracy or latency benchmark is claimed here.

## Verification

The recipe test checks planned runtime, backend, aliases, and modality metadata:

```sh
node test/hear-recipe.test.mjs
```

Backend boundary tests run with the managed Hear Python environment and the
`httpx` test-client dependency installed. They use
synthetic inputs and mocked network/media stages, without calling a live provider.

```sh
"${LLOOM_HOME:-$HOME/.lloom}/backends/hear/venv/bin/python" -m unittest discover -s backends/hear/test -v
```
