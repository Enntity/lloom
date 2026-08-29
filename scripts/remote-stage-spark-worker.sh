#!/usr/bin/env bash
set -euo pipefail

action=${1:?action required}
artifact=${2:?artifact required}
manifest=${3:?manifest required}
export PATH="$HOME/.local/bin:$HOME/.local/opt/node-v22.17.0-linux-arm64/bin:$PATH"
export NPM_CONFIG_CACHE="$HOME/.cache/npm-release"

release_id=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1])).commit.slice(0,12))' "$manifest")
release_root="$HOME/.lloom/releases/$release_id"
backup_root="$HOME/.lloom/releases/backups"
config_path=${LLOOM_CONFIG:-$HOME/.lloom/config.json}
config_backup="$release_root/config.before.worker.json"
manifest_path="$HOME/.lloom/releases/current.manifest.json"
manifest_backup="$release_root/current.manifest.before.worker.json"
rollback_artifact="$release_root/package.before.worker.tgz"
config_missing="$release_root/config.before.worker.missing"
manifest_missing="$release_root/current.manifest.before.worker.missing"
prepared="$release_root/worker.prepared"

wait_for_gateway() {
  for _ in $(seq 1 60); do lloom models >/dev/null 2>&1 && return; sleep 1; done
  lloom models >/dev/null
}

restore_worker() {
  [[ -f "$prepared" ]] || return 0
  if [[ -f "$rollback_artifact" ]]; then
    npm install --global --prefix "$HOME/.local" "$rollback_artifact" --omit=dev --ignore-scripts || true
  fi
  if [[ -f "$config_backup" ]]; then
    cp "$config_backup" "$config_path" || true
  elif [[ -f "$config_missing" ]]; then
    rm -f "$config_path" || true
  fi
  if [[ -f "$manifest_backup" ]]; then
    cp "$manifest_backup" "$manifest_path" || true
  elif [[ -f "$manifest_missing" ]]; then
    rm -f "$manifest_path" || true
  fi
  systemctl --user restart lloom.service || true
  wait_for_gateway || true
}

case "$action" in
  install)
    expected=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1])).sha256)' "$manifest")
    actual=$(sha256sum "$artifact" | awk '{print $1}')
    [[ "$expected" == "$actual" ]] || { echo "artifact checksum mismatch" >&2; exit 1; }
    mkdir -p "$release_root" "$backup_root"
    cp "$artifact" "$manifest" "$release_root/"
    rm -f "$config_backup" "$config_missing" "$manifest_backup" "$manifest_missing" "$rollback_artifact"
    if [[ -f "$config_path" ]]; then cp "$config_path" "$config_backup"; else touch "$config_missing"; fi
    if [[ -f "$manifest_path" ]]; then cp "$manifest_path" "$manifest_backup"; else touch "$manifest_missing"; fi
    installed="$HOME/.local/lib/node_modules/lloom"
    if [[ -f "$installed/package.json" ]]; then
      packed=$(npm pack "$installed" --json --pack-destination "$backup_root")
      rollback_name=$(printf '%s' "$packed" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].filename))')
      mv "$backup_root/$rollback_name" "$rollback_artifact"
    fi
    touch "$prepared"
    trap 'status=$?; if [[ $status -ne 0 ]]; then echo "LLooM worker staging failed; rolling back" >&2; restore_worker; fi; exit $status' EXIT
    npm install --global --prefix "$HOME/.local" "$artifact" --omit=dev --ignore-scripts
    systemctl --user restart lloom.service
    wait_for_gateway
    cp "$manifest" "$manifest_path"
    trap - EXIT
    echo "staged LLooM worker $release_id"
    ;;
  rollback)
    restore_worker
    rm -f "$prepared"
    echo "rolled back LLooM worker $release_id"
    ;;
  finalize)
    [[ -f "$prepared" ]] || { echo "worker release $release_id was not staged" >&2; exit 1; }
    rm -f "$prepared" "$config_backup" "$config_missing" "$manifest_backup" "$manifest_missing" "$rollback_artifact"
    echo "finalized LLooM worker $release_id"
    ;;
  *)
    echo "unknown action: $action" >&2
    exit 2
    ;;
esac
