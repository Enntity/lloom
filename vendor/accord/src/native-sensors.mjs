// SPDX-License-Identifier: MIT
import { existsSync,mkdirSync,renameSync,rmSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source=fileURLToPath(new URL('../native/macos-sensors.swift',import.meta.url));
export const bundledSensors=fileURLToPath(new URL(`../native/bin/accord-sensors-darwin-${process.arch}`,import.meta.url));
export function sensorPath(data){return existsSync(bundledSensors)?bundledSensors:join(data,'native','accord-sensors');}
export function buildSensors({output, dryRun=false, force=false}={}){
  if(process.platform!=='darwin')return {status:'not-applicable'};
  if(existsSync(output)&&!force)return {status:'available',path:output};
  if(dryRun)return {status:'planned',path:output};
  if(spawnSync('/usr/bin/xcode-select',['-p'],{stdio:'ignore',timeout:3000}).status!==0)return {status:'unavailable',reason:'Apple developer tools absent; CPU and memory telemetry still available'};
  mkdirSync(dirname(output),{recursive:true,mode:0o700});
  const temporary=output+'.tmp-'+process.pid;
  const result=spawnSync('/usr/bin/xcrun',['swiftc','-O','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx13.0`,source,'-o',temporary],{encoding:'utf8',timeout:60000,maxBuffer:512000});
  if(result.status!==0){rmSync(temporary,{force:true});return {status:'unavailable',reason:'Native sensor helper compilation failed',detail:result.stderr?.slice(-1500)};}
  renameSync(temporary,output);return {status:'available',path:output};
}
