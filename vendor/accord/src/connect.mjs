// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync,readFileSync,readdirSync,writeFileSync,existsSync,rmSync,lstatSync,chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { configuration } from './config.mjs';
import { request,requireThat,token,hash } from './common.mjs';

const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function ssh(args,input){
  const p=spawn('ssh',args,{stdio:['pipe','pipe','pipe']});let output='',error='';
  p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>error+=d);
  const timer=setTimeout(()=>p.kill('SIGKILL'),15000);p.stdin.on('error',()=>{});p.stdin.end(input??'');
  try{const code=await new Promise((r,j)=>{p.once('error',j);p.once('exit',r);});requireThat(code===0,'SSH_FAILED',error.slice(-1000)||`SSH exited ${code}`);return output;}
  finally{clearTimeout(timer);}
}
async function freePort(){const s=createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
export async function connectHost({host,data,home,remoteCli,remoteNode,remoteData,disconnect=false}){
  requireThat(typeof host==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,150}$/.test(host),'INVALID_HOST','Use a host name or SSH alias',400);
  const config=configuration(data),endpoints=JSON.parse(readFileSync(join(data,'endpoints.json'),'utf8')),endpoint=endpoints.local??endpoints.coordinator,servicePort=new URL(endpoints.coordinator).port;
  const root=join(home,'.config','accord','links');mkdirSync(root,{recursive:true,mode:0o700});
  const stem=hash(host).slice(0,16),stateFile=join(root,stem+'.json');
  const socketRoot=join('/tmp','accord-ssh-'+hash(root).slice(0,16));
  mkdirSync(socketRoot,{mode:0o700,recursive:true});
  const stat=lstatSync(socketRoot);requireThat(stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===process.getuid(),'SSH_PATH','Unsafe control socket directory');chmodSync(socketRoot,0o700);
  const socket=join(socketRoot,stem+'.sock');
  requireThat(socket.length<100,'SSH_PATH','SSH control socket path is too long');
  const base=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8'];
  const command=remoteCli?(remoteNode?quote(remoteNode)+' ':'')+quote(remoteCli):'"$HOME/.local/bin/accord"';
  const remote=(op,body)=>ssh([...base,host,command+' '+op+(remoteData?' --data '+quote(remoteData):'')],body===undefined?undefined:JSON.stringify(body));
  if(existsSync(stateFile)){
    const saved=JSON.parse(readFileSync(stateFile,'utf8'));
    if(disconnect){
      await request(endpoint,config.readToken('admin'),'/v1/links/remove',{key:token(),authority:saved.authority});
      let remoteRemoved=false;try{await remote('link --stdin',{remove:true,authority:config.authority});remoteRemoved=true;}catch{}
      try{await ssh([...base,'-S',socket,'-O','exit',host]);}catch{}
      rmSync(stateFile);return {disconnected:host,remoteRemoved};
    }
    try{await ssh([...base,'-S',socket,'-O','check',host]);return {connected:host,authority:saved.authority,transport:'existing SSH forward'};}catch{
      // The check just proved no master answers. A crashed master leaves its socket behind,
      // and ssh would then run with no control socket while holding the forwarded ports.
      rmSync(socket,{force:true});
      // Reuse credentials and ports. Never replace an established host identity implicitly.
      await ssh([...base,'-M','-S',socket,'-fNT','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',
        '-L',`127.0.0.1:${saved.localPort}:127.0.0.1:${saved.remoteServicePort}`,'-R',`127.0.0.1:${saved.remotePort}:127.0.0.1:${servicePort}`,host]);
      const identity=JSON.parse(await remote('descriptor'));requireThat(identity.authority===saved.authority,'PEER_IDENTITY_CHANGED','Remote authority changed');
      return {connected:host,authority:saved.authority,transport:'reconnected SSH forward'};
    }
  }
  requireThat(!disconnect,'NOT_CONNECTED','No saved connection for this host');
  const identity=JSON.parse(await remote('descriptor'));requireThat(typeof identity.authority==='string','BAD_PEER','Invalid host descriptor');
  const localPort=await freePort(),remotePort=randomInt(20000,55000),remoteServicePort=Number(new URL(identity.url).port);
  const inbound=token(),outbound=token();let started=false,remoteLinked=false,localLinked=false;
  try{
    await ssh([...base,'-M','-S',socket,'-fNT','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',
      '-L',`127.0.0.1:${localPort}:127.0.0.1:${remoteServicePort}`,'-R',`127.0.0.1:${remotePort}:127.0.0.1:${servicePort}`,host]);started=true;
    await remote('link --stdin',{authority:config.authority,url:`http://127.0.0.1:${remotePort}`,inbound:outbound,outbound:inbound});remoteLinked=true;
    await request(endpoint,config.readToken('admin'),'/v1/links',{key:token(),authority:identity.authority,url:`http://127.0.0.1:${localPort}`,inbound,outbound});localLinked=true;
    const result=await request(endpoint,config.readToken('admin'),'/v1/collaboration',{operation:'find',args:{}});
    requireThat(result.hosts.some(h=>h.authority===identity.authority&&h.status==='observed'),'LINK_UNAVAILABLE','New host link did not answer');
    writeFileSync(stateFile,JSON.stringify({host,authority:identity.authority,localPort,remotePort,remoteServicePort}),{mode:0o600,flag:'wx'});
    return {connected:host,authority:identity.authority,transport:'OpenSSH with pinned host keys and bidirectional loopback forwards'};
  }catch(e){
    if(localLinked)await request(endpoint,config.readToken('admin'),'/v1/links/remove',{key:token(),authority:identity.authority}).catch(()=>{});
    if(remoteLinked)await remote('link --stdin',{remove:true,authority:config.authority}).catch(()=>{});
    if(started)await ssh([...base,'-S',socket,'-O','exit',host]).catch(()=>{});
    throw e;
  }
}
// A healthy saved link costs one `ssh -O check`. Each host backs off alone, so one
// unreachable machine cannot delay another. A lost tunnel only makes a peer unknown.
export function superviseLinks({home,data,connect=connectHost,now=Date.now,intervalMs=30000,maxBackoffMs=300000,start=true}){
  const state={},root=join(home,'.config','accord','links');let active=null,timer;
  const hosts=()=>{let files=[];try{files=readdirSync(root);}catch{}
    return files.filter(f=>f.endsWith('.json')).flatMap(f=>{try{return [JSON.parse(readFileSync(join(root,f),'utf8')).host];}catch{return [];}});};
  const restore=async host=>{
    try{await connect({host,data,home});state[host]={failures:0,next:0};}
    catch{const failures=(state[host]?.failures??0)+1;state[host]={failures,next:now()+Math.min(maxBackoffMs,intervalMs*2**failures)};}
  };
  const tick=()=>{if(active)return Promise.resolve();
    active=Promise.all(hosts().filter(host=>(state[host]?.next??0)<=now()).map(restore)).finally(()=>{active=null;});return active;};
  if(start){void tick();timer=setInterval(tick,intervalMs);timer.unref();}
  return {tick,status:()=>state,stop(){clearInterval(timer);}};
}
