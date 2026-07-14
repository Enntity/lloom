#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRelease, inherit, parseArgs } from "./release-lib.mjs";

const flags = parseArgs(process.argv.slice(2));
const host = String(flags.host || process.env.ENNTITY_SPARK_HOST || "").trim();
if (!host) throw new Error("Pass --host user@host or set ENNTITY_SPARK_HOST");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = await buildRelease({ root, allowDirty: !!flags["allow-dirty"], runTests: !flags["skip-tests"] });
const remoteDir = `/tmp/lloom-release-${release.manifest.commit.slice(0, 12)}`;
const ssh = options(flags, false), scp = options(flags, true);
const scpHost = scpHostSpec(host);
await inherit("ssh", [...ssh, host, `mkdir -p '${remoteDir}'`], root);
await inherit("scp", [...scp, release.artifact, release.manifestPath, `${scpHost}:${remoteDir}/`], root);
await inherit("scp", [...scp, path.join(root, "scripts", "remote-install-spark.sh"), `${scpHost}:${remoteDir}/install.sh`], root);
const remoteArgs = ["bash", `${remoteDir}/install.sh`, `${remoteDir}/${path.basename(release.artifact)}`, `${remoteDir}/${path.basename(release.manifestPath)}`];
if (flags.runtime) remoteArgs.push(String(flags.runtime));
else remoteArgs.push("-");
remoteArgs.push(String(flags.entity || "Jinx"));
await inherit("ssh", [...ssh, host, ...remoteArgs], root);
console.log(JSON.stringify({ deployed: true, host, entity: flags.entity || "Jinx", runtime: flags.runtime || null, commit: release.manifest.commit, sha256: release.manifest.sha256 }, null, 2));

function options(input, isScp) {
  const args = [];
  if (input["host-key-alias"]) args.push("-o", `HostKeyAlias=${input["host-key-alias"]}`);
  if (input.port) args.push(isScp ? "-P" : "-p", String(input.port));
  return args;
}

function scpHostSpec(value) {
  const at = value.lastIndexOf("@");
  const user = at >= 0 ? value.slice(0, at + 1) : "";
  const address = at >= 0 ? value.slice(at + 1) : value;
  return address.includes(":") && !address.startsWith("[") ? `${user}[${address}]` : value;
}
