# LLooM image playground

A deliberately small local UI for exercising an image model through a remote LLooM host.

```sh
LLOOM_REMOTE_HOST=my-spark-host \
LLOOM_IMAGE_MODEL=cyberdelia/CyberRealisticPony-v18 \
node tools/image-playground/server.mjs
```

The remote host must have `$HOME/.config/lloom/env` containing `LLOOM_API_KEY`. Set
`LLOOM_REMOTE_ENV_FILE` when the host uses a different environment-file path. The playground
listens only on `127.0.0.1` and does not expose or copy the key to the browser.
