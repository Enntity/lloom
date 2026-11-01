// SPDX-License-Identifier: MIT
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { requireThat } from '../common.mjs';

export const descriptor = {id:'posix-process-group',version:1,platforms:['darwin','linux'],
  enforcement:'managed-process-group',scope:'Descendants must stay in the registered process group; no device isolation or sandbox.'};
export function groupExists(pgid) {
  requireThat(Number.isSafeInteger(pgid)&&pgid>1,'PROCESS_IDENTITY','Invalid process group');
  try { process.kill(-pgid,0); return true; } catch(e) { if(e.code==='ESRCH')return false; throw e; }
}
export function identity(pid) {
  try {
    const value=execFileSync('/bin/ps',['-p',String(pid),'-o','pgid=','-o','lstart='],{encoding:'utf8'}).trim();
    const match=/^(\d+)\s+(.+)$/.exec(value);return match?{pgid:Number(match[1]),birth:match[2]}:null;
  } catch(e) { if(e.status===1)return null;throw e; }
}
export function launchAnchor(file,runId) {
  requireThat(descriptor.platforms.includes(process.platform),'PLUGIN_UNSUPPORTED','POSIX process groups require macOS or Linux');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../process-anchor.mjs',import.meta.url)),file,runId],
    {detached:true,stdio:['ignore','ignore','ignore','ipc'],env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME??'',LANG:'C'}});
  child.on('error',()=>{});child.unref();child.channel?.unref();return child;
}
export async function signalGroup(run,signal) {
  if(!groupExists(run.pgid))return false;
  // Ask the original anchor to signal its own group. Never kill a recovered PID:
  // a reused PID cannot answer this private, per-run authenticated socket.
  try {
    await new Promise((resolve,reject)=>{
      const req=http.request({socketPath:run.socket,path:'/stop',method:'POST',timeout:300,
        headers:{'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>res.statusCode===200?resolve():reject(Error('Anchor refused control')));});
      req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Anchor unavailable')));
      req.end(JSON.stringify({token:run.control_token,signal}));
    });
  } catch {
    requireThat(!groupExists(run.pgid),'PROCESS_IDENTITY_UNKNOWN','Original anchor unavailable while its group remains; ownership stays held');
  }
  return true;
}
