// SPDX-License-Identifier: MIT
// Narrow host-side plugins. No shell commands or executable paths come from agents.
import http from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { requireThat, hash } from './common.mjs';
const exec = promisify(execFile);
const run = async (...args) => (await exec('/usr/bin/systemctl', ['--user', ...args], {timeout:20000,maxBuffer:65536})).stdout;
function docker(socket, method, path, body) {
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath:socket,method,path,timeout:20000,headers:{'content-type':'application/json'}},res=>{
      const chunks=[];let size=0;res.on('data',b=>{size+=b.length;if(size>1048576)req.destroy(Error('Docker response too large'));else chunks.push(b);});
      res.on('error',reject);res.on('end',()=>{try{resolve({status:res.statusCode,value:JSON.parse(Buffer.concat(chunks).toString()||'{}')});}catch(e){reject(e);}});
    });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Docker unavailable')));req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
export async function executeWorkload({action,target,socket='/var/run/docker.sock'}) {
  requireThat(['inspect','start','stop'].includes(action),'INVALID_INPUT','Unknown workload action');
  if(target.plugin==='docker-container') {
    requireThat(/^[a-f0-9]{64}$/.test(target.id),'WORKLOAD_IDENTITY','Use the full immutable Docker container ID');
    const info=await docker(socket,'GET','/info');
    requireThat(info.status===200&&typeof info.value.ID==='string'&&info.value.ID,'HOST_UNAVAILABLE','Docker identity unavailable');
    const engine=info.value.ID;
    if(target.identity)requireThat(target.identity.engine===engine,'HOST_REPLACED','Docker engine identity changed');
    const inspect=async()=>{
      const result=await docker(socket,'GET',`/containers/${target.id}/json`);
      if(result.status===404)return {identity:{engine,id:target.id},exists:false,running:false,labels:{}};
      requireThat(result.status===200&&result.value.Id===target.id,'WORKLOAD_UNKNOWN','Container inspection unconfirmed');
      const c=result.value;
      return {identity:{engine,id:c.Id},exists:true,running:!!(c.State.Running||c.State.Restarting||c.State.Paused),labels:c.Config.Labels??{},started:!!c.State.StartedAt&&!c.State.StartedAt.startsWith('0001-'),restart:c.HostConfig.RestartPolicy?.Name??'no'};
    };
    let state=await inspect();
    if(action==='start') {
      requireThat(state.exists,'WORKLOAD_MISSING','Registered container was removed');
      requireThat(state.restart==='no'||state.restart==='','SUPERVISOR_REQUIRED','Automatic Docker restart must be disabled');
      if(state.started)return state;
      const r=await docker(socket,'POST',`/containers/${target.id}/start`);
      requireThat([204,304].includes(r.status),'START_UNCONFIRMED','Docker did not confirm start');
    }
    if(action==='stop'&&state.exists) {
      const disabled=await docker(socket,'POST',`/containers/${target.id}/update`,{RestartPolicy:{Name:'no',MaximumRetryCount:0}});
      requireThat(disabled.status===200,'STOP_UNCONFIRMED','Could not disable container restart');
      const r=await docker(socket,'POST',`/containers/${target.id}/stop?t=10`);
      requireThat([204,304,404].includes(r.status),'STOP_UNCONFIRMED','Docker did not confirm stop');
    }
    state=await inspect();
    requireThat(action!=='stop'||!state.running,'STOP_UNCONFIRMED','Container still running');
    return state;
  }
  if(target.plugin==='systemd-user-unit') {
    requireThat(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,179}\.service$/.test(target.id),'WORKLOAD_IDENTITY','Use a user service unit name');
    const machine=readFileSync('/etc/machine-id','utf8').trim();
    const inspect=async()=>{
      const out=await run('show',target.id,'--property=InvocationID,ActiveState,SubState,KillMode,ControlGroup,LoadState,FragmentPath,DropInPaths,TriggeredBy,ExecMainStartTimestampMonotonic,UnitFileState,WantedBy,RequiredBy,UpheldBy,RefuseManualStop');
      const p=Object.fromEntries(out.trim().split('\n').map(l=>{const at=l.indexOf('=');return [l.slice(0,at),l.slice(at+1)];}));
      requireThat(p.LoadState==='loaded'||p.LoadState==='not-found','WORKLOAD_UNKNOWN','Service state unknown');
      const files=[p.FragmentPath,...(p.DropInPaths??'').split(' ')].filter(Boolean);
      const definition=p.LoadState==='loaded'?hash(files.map(f=>readFileSync(f,'utf8')).join('\n')):null;
      return {identity:{machine,unit:target.id,definition,invocation:p.InvocationID},exists:p.LoadState==='loaded',running:!['inactive','failed'].includes(p.ActiveState),started:Number(p.ExecMainStartTimestampMonotonic)>0,killMode:p.KillMode,cgroup:p.ControlGroup,triggeredBy:[p.TriggeredBy,p.WantedBy,p.RequiredBy,p.UpheldBy].filter(Boolean).join(' '),autoStart:!['disabled','linked','transient','static'].includes(p.UnitFileState)||p.RefuseManualStop==='yes',labels:{}};
    };
    let state=await inspect();
    if(target.identity) {
      requireThat(target.identity.machine===machine&&target.identity.unit===target.id,'HOST_REPLACED','Service host changed');
      if(state.exists)requireThat(state.identity.definition===target.identity.definition,'WORKLOAD_REPLACED','Service definition changed; reconciliation required');
    }
    if(action==='start') {
      requireThat(state.exists&&state.killMode==='control-group'&&!state.triggeredBy&&!state.autoStart,'SUPERVISOR_UNSAFE','Use a dedicated, untriggered control-group service');
      if(!state.started){await run('start',target.id);state=await inspect();}
    }
    const stoppedGroup=target.cgroup||state.cgroup;
    if(action==='stop'&&state.running) {
      requireThat(state.killMode==='control-group','SUPERVISOR_UNSAFE','Service must stop its whole control group');
      await run('stop',target.id);state=await inspect();
    }
    if(action==='stop') {
      requireThat(!state.running,'STOP_UNCONFIRMED','Supervisor is still active');
      const group=stoppedGroup;
      if(group)requireThat(group.startsWith('/')&&!group.includes('..'),'WORKLOAD_IDENTITY','Invalid control group');
      if(group&&existsSync('/sys/fs/cgroup'+group)) {
        const visit=p=>{if(existsSync(p+'/cgroup.procs'))requireThat(!readFileSync(p+'/cgroup.procs','utf8').trim(),'STOP_UNCONFIRMED','Supervisor descendants remain');for(const e of readdirSync(p,{withFileTypes:true}))if(e.isDirectory())visit(p+'/'+e.name);};
        visit('/sys/fs/cgroup'+group);
      }
    }
    return state;
  }
  requireThat(false,'PLUGIN_UNSUPPORTED','Unsupported external workload plugin');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    let input='';for await(const b of process.stdin){input+=b;requireThat(input.length<=32768,'INVALID_INPUT','Input too large');}
    console.log(JSON.stringify(await executeWorkload(JSON.parse(input))));
  }catch(e){console.log(JSON.stringify({error:{code:e.code??'HOST_UNAVAILABLE',message:e.code?e.message:'Workload host operation failed'}}));process.exitCode=1;}
}
