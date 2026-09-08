# SparkGLM under LLooM

Build and qualify SparkGLM separately. LLooM manages the resulting Docker
runtime: admission, worker-first TP2 startup, readiness, stop, routing and
telemetry. This adapter uses the patchers baked into the selected SparkGLM
image; it does not overlay the older Mia launcher implementation.

Materialize a private, immutable-image recipe from the installed LLooM checkout:

```sh
mkdir -p "$HOME/.lloom/sparkglm-recipes"
node backends/sparkglm/materialize.mjs \
  --image-id "$HEAD_IMAGE_ID" --worker-image-id "$WORKER_IMAGE_ID" \
  --source-revision "$SPARKGLM_COMMIT" \
  --output "$HOME/.lloom/sparkglm-recipes/linux-nvidia-dgx-spark-2x-sparkglm-exl3.json"
```

Image IDs must be complete `sha256:` identities present on their respective
nodes; source revision must be a complete commit. When the images are built
independently, verify their serving source and extension hashes match. Omit
`--worker-image-id` when both nodes have the same image. Keep the generated
recipe directory and this backend directory identical on both installed nodes.
Distributed setup invokes the same recipe on the worker.

Review the ordinary setup plan, then apply and explicitly start:

```sh
lloom setup --recipe linux-nvidia-dgx-spark-2x-sparkglm-exl3 \
  --recipes-root "$HOME/.lloom/sparkglm-recipes" --additive --no-auto-host --json
lloom setup --recipe linux-nvidia-dgx-spark-2x-sparkglm-exl3 \
  --recipes-root "$HOME/.lloom/sparkglm-recipes" --additive --no-auto-host --apply --yes --json
lloom runtime-start glm53-flash-exl3-cluster --json
lloom runtime-status glm53-flash-exl3-cluster --json
lloom runtime-stop glm53-flash-exl3-cluster --json
```

Installing the profile does not set keep-warm or resume suspended routes.
Use `lloom route glm53f-local --json` to inspect the strict local canary alias.
Verify a streamed tool-call through that alias and confirm gateway metrics
attribute it to `glm-5.3-flash-exl3`, in addition to checking both rank image
identities and backend health. Run SparkGLM's documented shape warmup and
qualification harness; a successful LLooM health check does not qualify a
kernel or a release.

`--e3` explicitly enables the unqualified E3 large-prefill experiment and must
only select an image containing its source-locked adapter. `--tiny` generates
an isolated `sparkglm-tiny` model/runtime with no production aliases. First
build the documented tinyGLM fixture on each host and expose its snapshot at
`${modelRoot}/sparkglm--tinyglm`. The launcher rejects dummy loading unless
the config identifies the synthetic `tinyglm-v1` fixture and speculation is
disabled. Stop the full runtime before starting the fixture.

`--nvfp4` generates the isolated `sparkglm-nvfp4` runtime for the separately
pinned current compressed-tensors checkpoint. It cannot be combined with
`--tiny` or `--e3`. This initial lane uses 8 GiB KV per rank and 262144 context;
repeat EXL3 with matching limits before comparing performance. Native kernel
execution and model quality require separate evidence. None of these options
changes the production Presence alias or promotes an experimental backend.

`--nvfp4-tiny` selects the separate `sparkglm-tiny-nvfp4` fixture. Build its
reviewed dummy-loader image and metadata from SparkGLM's NVFP4 experiment
first. The image must contain the guarded deterministic FP4 initializer;
ordinary integer dummy weights are uninitialized in the underlying loader.
This option uses no production aliases and cannot enable E3 or real NVFP4
loading. Finish model downloads before full-model cold starts: downloader
buffers count against GB10's shared memory budget.
