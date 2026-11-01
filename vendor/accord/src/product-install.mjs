// SPDX-License-Identifier: MIT
// Shared product bootstrap. Reuse the pinned host; never initialize a second authority.
import { existsSync,readFileSync,mkdirSync,writeFileSync,rmSync,statSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installService } from './service.mjs';
import { profileAt,discover } from './bootstrap.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function ensureAccord({home=homedir(),data=join(home,'.local/share/accord'),profilePath=join(home,'.config/accord/connection.json'),dryRun=false,start=true,clients=['codex','claude']}={}){
  if(dryRun)return {installed:false,reused:existsSync(profilePath),profilePath,planned:existsSync(profilePath)?[]:['initialize Accord','install CLI, skill and MCP',...(start?['enable Accord user service']:[])]};
  const lock=join(dirname(profilePath),'bootstrap.lock');mkdirSync(dirname(lock),{recursive:true,mode:0o700});
  let locked=false;
  for(const end=Date.now()+60000;Date.now()<end;){
    try{mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,'pid'),String(process.pid),{mode:0o600});locked=true;break;}
    catch(e){if(e.code!=='EEXIST')throw e;}
    try{const pid=Number(readFileSync(join(lock,'pid'),'utf8'));if(!Number.isSafeInteger(pid)||pid<2)throw Error('Invalid installer lock');try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){rmSync(lock,{recursive:true});continue;}throw e;}}
    catch(e){if(e.code==='ENOENT'&&existsSync(lock)&&Date.now()-statSync(lock).mtimeMs>60000){rmSync(lock,{recursive:true});continue;}}
    await sleep(100);
  }
  if(!locked)throw Error('Another Accord installer is still running; no configuration changed');
  try{
    if(existsSync(profilePath)){
      const saved=JSON.parse(readFileSync(profilePath,'utf8'));
      if(saved.schema!==1||!saved.authority)throw Error('Invalid existing Accord profile; refusing a second authority');
      if(start){
        try{await discover(profileAt(profilePath));}
        catch(first){
          if(!saved.endpointFile)throw first;
          const service=process.platform==='darwin'?join(home,'Library/LaunchAgents/org.enntity.accord.plist'):join(home,'.config/systemd/user/accord.service');
          if(existsSync(service)){
            if(home!==homedir())throw first;
            const exec=promisify(execFile);
            if(process.platform==='darwin'){
              await exec('launchctl',['bootstrap',`gui/${process.getuid()}`,service],{timeout:5000}).catch(()=>{});
              await exec('launchctl',['kickstart',`gui/${process.getuid()}/org.enntity.accord`],{timeout:5000});
            }else await exec('systemctl',['--user','start','accord.service'],{timeout:10000});
          }else installService({home,data:dirname(saved.endpointFile),enable:true});
          await ready(profilePath);
        }
      }
      return {installed:false,reused:true,profilePath,authority:saved.authority};
    }
    await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'install','--home',home,'--data',data,'--clients',clients.join(','),...(start?[]:['--no-start'])],{timeout:60000,maxBuffer:1024*1024});
    if(start)await ready(profilePath);
    return {installed:true,reused:false,profilePath};
  }finally{rmSync(lock,{recursive:true});}
}

async function ready(profile){let last;for(const until=Date.now()+15000;Date.now()<until;){try{return await discover(profileAt(profile));}catch(e){last=e;}await sleep(200);}throw last;}
