#!/usr/bin/env bash
set -euo pipefail

artifact=${1:?artifact required}
manifest=${2:?manifest required}
runtime=${3:-}
[[ "$runtime" == "-" ]] && runtime=""
entity=${4:-Jinx}
recipe=${5:-}
[[ "$recipe" == "-" ]] && recipe=""
route_catalog=${6:-}
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
config_path=${LLOOM_CONFIG:-$HOME/.lloom/config.json}
config_backup="$release_root/config.before.json"
config_existed="false"
if [[ -f "$config_path" ]]; then
  cp "$config_path" "$config_backup"
  config_existed="true"
fi

rollback() {
  status=$?
  [[ $status -eq 0 ]] && return
  echo "LLooM deployment failed; rolling back" >&2
  if [[ -n "$rollback_artifact" && -f "$rollback_artifact" ]]; then
    npm install --global --prefix "$HOME/.local" "$rollback_artifact" --omit=dev --ignore-scripts || true
  fi
  if [[ "$config_existed" == "true" && -f "$config_backup" ]]; then
    cp "$config_backup" "$config_path" || true
  fi
  systemctl --user restart lloom.service || true
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
if [[ -n "$route_catalog" ]]; then
  node "$HOME/.local/lib/node_modules/lloom/scripts/apply-spark-route-catalog.mjs" \
    "$config_path" "$route_catalog" --apply --yes >/dev/null
fi
if [[ -n "$recipe" ]]; then
  lloom setup --recipe "$recipe" --additive --apply --yes >/dev/null
fi
systemctl --user restart lloom.service
for _ in $(seq 1 60); do lloom models >/dev/null 2>&1 && break; sleep 1; done
lloom models >/dev/null
if [[ -n "$runtime" ]]; then
  runtime_snapshot=$(lloom runtimes "$runtime" 2>/dev/null || true)
  runtime_fields=$(printf '%s' "$runtime_snapshot" | node -e '
    let s = "";
    process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const j = JSON.parse(s);
        const id = process.argv[1];
        const r = j.runtimes?.[id] || {};
        const keepWarm = r.keepWarm === true || (j.keepWarm || []).includes(id);
        console.log(`${r.healthy === true}\t${r.status || "unknown"}\t${keepWarm}`);
      } catch {
        console.log("false\tunknown\tfalse");
      }
    });
  ' "$runtime")
  IFS=$'\t' read -r healthy status keep_warm <<< "$runtime_fields"
  if [[ "$keep_warm" == "true" && ( "$healthy" == "true" || "$status" == "starting" || "$status" == "running" ) ]]; then
    echo "adopting keep-warm startup for $runtime"
  else
    # Non-pinned runtimes need an explicit restart so the new runtime spec is
    # applied. A stopped/failed keep-warm runtime also needs recovery.
    [[ "$keep_warm" == "true" ]] || lloom runtime-stop "$runtime" >/dev/null
    # The runtime was explicitly stopped above before the package/config swap.
    # A request may race the service restart and begin the same new-spec startup;
    # adopt that work instead of force-restarting the freshly loaded cluster.
    lloom runtime-start "$runtime" --no-force >/dev/null
  fi
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
