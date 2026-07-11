#!/usr/bin/env bash
set -euo pipefail

backup="${1:-$HOME/.lloom/backups/latest}"
backup="$(cd "$backup" && pwd -P)"
test -f "$backup/lloom-home.tar.gz"
test -f "$backup/SHA256SUMS"

cd "$backup"
sha256sum --check SHA256SUMS
tar -tzf lloom-home.tar.gz > /dev/null

before="$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' qwen36-unsloth)"
systemctl --user stop lloom.service || true
tar -xzf lloom-home.tar.gz -C "$HOME"
systemctl --user daemon-reload
loginctl enable-linger "$USER"
systemctl --user enable --now lloom.service

after="$(docker inspect --format '{{.Id}} {{.State.StartedAt}}' qwen36-unsloth)"
test "$before" = "$after"
systemctl --user is-active --quiet lloom.service
curl -fsS http://127.0.0.1:8100/health > /dev/null
printf 'Restored LLooM from %s; port-8000 container unchanged.\n' "$backup"
