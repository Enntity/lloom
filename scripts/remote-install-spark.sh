#!/usr/bin/env bash
set -euo pipefail

artifact=${1:?artifact required}
manifest=${2:?manifest required}
runtime=${3:-}
export PATH="$HOME/.local/bin:$HOME/.local/opt/node-v22.17.0-linux-arm64/bin:$PATH"
export NPM_CONFIG_CACHE="$HOME/.cache/npm-release"

expected=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1])).sha256)' "$manifest")
actual=$(sha256sum "$artifact" | awk '{print $1}')
[[ "$expected" == "$actual" ]] || { echo "artifact checksum mismatch" >&2; exit 1; }
release_id=$(node -e 'const fs=require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1])).commit.slice(0,12))' "$manifest")
release_root="$HOME/.lloom/releases/$release_id"
backup_root="$HOME/.lloom/releases/backups"
mkdir -p "$release_root" "$backup_root"
cp "$artifact" "$manifest" "$release_root/"
rollback_artifact=""

rollback() {
  status=$?
  [[ $status -eq 0 ]] && return
  echo "LLooM deployment failed; rolling back" >&2
  if [[ -n "$rollback_artifact" && -f "$rollback_artifact" ]]; then
    npm install --global --prefix "$HOME/.local" "$rollback_artifact" --omit=dev --ignore-scripts || true
    systemctl --user restart lloom.service || true
  fi
  exit "$status"
}
trap rollback EXIT

installed="$HOME/.local/lib/node_modules/lloom"
if [[ -f "$installed/package.json" ]]; then
  packed=$(npm pack "$installed" --json --pack-destination "$backup_root")
  rollback_name=$(printf '%s' "$packed" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].filename))')
  rollback_artifact="$backup_root/$rollback_name"
fi

if [[ -n "$runtime" ]]; then
  for _ in $(seq 1 240); do
    active=$(lloom runtimes "$runtime" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const r=j.runtimes[process.argv[1]];console.log((r.activeRequests||0)+(r.queuedRequests||0))}catch{console.log(1)}})' "$runtime")
    [[ "$active" == "0" ]] && break
    sleep 1
  done
  [[ "${active:-1}" == "0" ]] || { echo "runtime did not drain" >&2; exit 1; }
fi

npm install --global --prefix "$HOME/.local" "$artifact" --omit=dev --ignore-scripts
systemctl --user restart lloom.service
for _ in $(seq 1 60); do lloom models >/dev/null 2>&1 && break; sleep 1; done
lloom models >/dev/null
if [[ -n "$runtime" ]]; then
  lloom runtime-stop "$runtime" >/dev/null
  lloom runtime-start "$runtime" >/dev/null
  for _ in $(seq 1 900); do
    healthy=$(lloom runtimes "$runtime" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.runtimes[process.argv[1]].healthy?"true":"false")}catch{console.log("false")}})' "$runtime")
    [[ "$healthy" == "true" ]] && break
    sleep 1
  done
  [[ "${healthy:-false}" == "true" ]] || { echo "runtime failed health check" >&2; exit 1; }
fi
cp "$manifest" "$HOME/.lloom/releases/current.manifest.json"
trap - EXIT
echo "deployed LLooM $release_id"
