#!/usr/bin/env bash
set -euo pipefail

stamp="${1:-$(date +%Y%m%d-%H%M%S)}"
root="${LLOOM_BACKUP_ROOT:-$HOME/.lloom/backups}"
backup="$root/$stamp"
mkdir -p "$backup/metadata"
chmod 700 "$root" "$backup" "$backup/metadata"
cp "$HOME/.local/bin/lloom-restore" "$backup/restore-lloom.sh"
chmod 700 "$backup/restore-lloom.sh"

docker inspect qwen36-unsloth > "$backup/metadata/qwen36-unsloth.inspect.json"
docker ps --no-trunc --filter name=qwen36-unsloth --format '{{json .}}' > "$backup/metadata/qwen36-unsloth.ps.json"
systemctl --user cat lloom.service > "$backup/metadata/lloom.service.effective"
systemctl --user show lloom.service > "$backup/metadata/lloom.service.properties"
loginctl show-user "$USER" > "$backup/metadata/user-linger.properties"
{
  date -Is
  hostnamectl 2>/dev/null || true
  "$HOME/.local/bin/node" --version
  docker --version
  docker inspect --format '{{.Id}} {{.State.StartedAt}} {{.State.Running}} {{.RestartCount}}' qwen36-unsloth
} > "$backup/metadata/runtime.txt"

tar -czf "$backup/lloom-home.tar.gz" -C "$HOME" \
  .lloom/config.json \
  .config/lloom/env \
  .config/systemd/user/lloom.service \
  .local/lib/node_modules/lloom \
  .local/opt/node-v22.17.0-linux-arm64 \
  .local/bin/node \
  .local/bin/npm \
  .local/bin/npx \
  .local/bin/lloom \
  .local/bin/lloom-host

(cd "$backup" && sha256sum lloom-home.tar.gz restore-lloom.sh metadata/* > SHA256SUMS)
chmod 600 "$backup/lloom-home.tar.gz" "$backup/SHA256SUMS" "$backup"/metadata/*
ln -sfn "$backup" "$root/latest"
printf '%s\n' "$backup"
