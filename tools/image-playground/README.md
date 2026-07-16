# LLooM media playground

A deliberately small local UI for exercising every advertised image and video model through a
remote LLooM host. The model list is loaded from LLooM at runtime. Its prompt-enhancement button
uses the configured Qwen Froggeric model with instructions tailored to Pony XL, FLUX, or LTX.

```sh
LLOOM_REMOTE_HOST=my-spark-host \
node tools/image-playground/server.mjs
```

The remote host must have `$HOME/.config/lloom/env` containing `LLOOM_API_KEY`. Set
`LLOOM_REMOTE_ENV_FILE` when the host uses a different environment-file path. The playground
listens only on `127.0.0.1` and does not expose or copy the key to the browser.

Set `LLOOM_ENHANCER_MODEL` to override the default
`unsloth/Qwen3.6-35B-A3B-NVFP4-Froggeric-vLLM025` prompt enhancer.
