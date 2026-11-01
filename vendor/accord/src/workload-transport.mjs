// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { executeWorkload } from './workload-host.mjs';
import { requireThat } from './common.mjs';
export function validateWorkloadConnector(c) {
  requireThat(c&&['local','ssh'].includes(c.transport),'WORKLOAD_POLICY','Use a local or SSH workload connector');
  if(c.socket!==undefined)requireThat(typeof c.socket==='string'&&isAbsolute(c.socket),'WORKLOAD_POLICY','Use an absolute Docker socket path');
  if(c.transport==='ssh') {
    requireThat(typeof c.host==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,200}$/.test(c.host)&&typeof c.node==='string'&&isAbsolute(c.node)&&typeof c.helper==='string'&&isAbsolute(c.helper),'WORKLOAD_POLICY','Invalid installed SSH connector');
    for(const key of ['identityFile','knownHostsFile'])if(c[key]!==undefined)requireThat(typeof c[key]==='string'&&isAbsolute(c[key]),'WORKLOAD_POLICY','Use absolute SSH credential and host-key file paths');
  }
  return c;
}
export function workloadPolicy(file,resource,host,plugin) {
  let p;try{p=JSON.parse(readFileSync(file,'utf8'));}catch{requireThat(false,'WORKLOAD_POLICY','No external workload policy is installed');}
  const rule=p.resources?.[resource],connector=p.hosts?.[host];
  requireThat(p.schema===1&&rule?.hosts?.includes(host)&&rule?.plugins?.includes(plugin)&&connector,'WORKLOAD_POLICY','Host/plugin is not approved for this resource');
  return validateWorkloadConnector(connector);
}
export function workloadCapabilities(file,resource) {
  try {
    const p=JSON.parse(readFileSync(file,'utf8')),r=p.resources?.[resource];
    if(p.schema!==1||!Array.isArray(r?.hosts)||!Array.isArray(r?.plugins))return {enabled:false,hosts:[],plugins:[]};
    const hosts=r.hosts.filter(h=>{try{return !!validateWorkloadConnector(p.hosts?.[h]);}catch{return false;}});
    return {enabled:hosts.length>0,hosts,plugins:r.plugins.filter(p=>['docker-container','systemd-user-unit'].includes(p))};
  }catch{return {enabled:false,hosts:[],plugins:[]};}
}
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export async function workloadTransport(connector,action,target) {
  validateWorkloadConnector(connector);
  if(connector.transport==='local')return executeWorkload({action,target,socket:connector.socket});
  return new Promise((resolve,reject)=>{
    const options=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5'];
    if(connector.identityFile)options.push('-o','IdentitiesOnly=yes','-i',connector.identityFile);
    if(connector.knownHostsFile)options.push('-o','UserKnownHostsFile='+connector.knownHostsFile);
    const p=spawn('/usr/bin/ssh',[...options,connector.host,`${quote(connector.node)} ${quote(connector.helper)}`],{stdio:['pipe','pipe','pipe']});
    let output='',size=0;const timer=setTimeout(()=>{p.kill('SIGKILL');reject(Error('Workload host timed out; state unknown'));},25000);
    p.stdout.on('data',b=>{size+=b.length;if(size>65536){p.kill('SIGKILL');return;}output+=b;});p.stderr.resume();p.on('error',e=>{clearTimeout(timer);reject(e);});
    p.on('exit',code=>{clearTimeout(timer);try{const result=JSON.parse(output);if(result.error)throw Object.assign(Error(result.error.message),{code:result.error.code});requireThat(code===0,'HOST_UNAVAILABLE','Workload host unavailable');resolve(result);}catch(e){reject(e);}});
    p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify({action,target,socket:connector.socket}));
  });
}
