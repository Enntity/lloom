// SPDX-License-Identifier: MIT
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { requireThat } from './common.mjs';

const xml = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const unxml = s => s.replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&');
export function servicePlan({data,home=homedir(),platform=process.platform,node=process.execPath,cli=fileURLToPath(new URL('./cli.mjs',import.meta.url))}={}) {
  data=resolve(data);home=resolve(home);
  if(platform==='darwin'){
    const path=join(home,'Library','LaunchAgents','org.enntity.accord.plist');
    const args=[node,cli,'up','--data',data];
    const content=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>org.enntity.accord</string><key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer></dict></plist>\n`;
    return {path,content,command:'launchctl',args:['bootstrap',`gui/${process.getuid?.()??0}`,path],scope:'user login service'};
  }
  requireThat(platform==='linux','SERVICE_UNSUPPORTED','Automatic startup supports launchd and systemd user services; use accord up under your supervisor on this platform',400);
  const escape=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';
  requireThat(!/[\r\n]/.test(data+cli+node),'BAD_PATH','Newlines in service paths are unsupported');
  return {path:join(home,'.config','systemd','user','accord.service'),
    content:`[Unit]\nDescription=Accord local coordination host\n[Service]\nExecStart=${[node,cli,'up','--data',data].map(escape).join(' ')}\nRestart=always\nRestartSec=10\n[Install]\nWantedBy=default.target\n`,
    command:'systemctl',args:['--user','enable','--now','accord.service'],scope:'user service; boot without login requires user-manager configuration'};
}
// A service file an earlier install wrote from another folder or Node: exactly what that
// install would write, so a hand-edited file is never taken for one.
function earlierService(text,options){
  const paths=(options.platform??process.platform)==='darwin'
    ? /<key>ProgramArguments<\/key><array><string>([^<]*)<\/string><string>([^<]*)<\/string>/.exec(text)?.slice(1).map(unxml)
    : /^ExecStart=("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")/m.exec(text)?.slice(1).map(s=>{try{return JSON.parse(s).replaceAll('%%','%');}catch{return null;}});
  if(!paths?.every(Boolean)||!/[\\/]src[\\/]cli\.mjs$/.test(paths[1]))return false;
  return servicePlan({...options,node:paths[0],cli:paths[1]}).content===text;
}
export function installService(options={}) {
  const plan=servicePlan(options);
  const old=existsSync(plan.path)?readFileSync(plan.path,'utf8'):null,replaced=old!==null&&old!==plan.content;
  requireThat(!replaced||earlierService(old,options),'SERVICE_CONFLICT','Existing service file differs; review it before replacing');
  const result={path:plan.path,dryRun:Boolean(options.dryRun),enabled:Boolean(options.enable&&!options.dryRun),scope:plan.scope,...(replaced?{replaced:true}:{})};
  if(!options.dryRun){
    mkdirSync(dirname(plan.path),{recursive:true,mode:0o700});
    if(old===null)writeFileSync(plan.path,plan.content,{mode:0o600,flag:'wx'});
    else if(replaced){
      copyFileSync(plan.path,`${plan.path}.backup-${randomUUID()}`);
      const temporary=`${plan.path}.tmp-${randomUUID()}`;
      writeFileSync(temporary,plan.content,{mode:0o600,flag:'wx'});renameSync(temporary,plan.path);
    }
    if(options.enable){
      requireThat(resolve(options.home??homedir())===resolve(homedir()),'SERVICE_HOME','Cannot enable a service for a different home');
      const running=process.platform==='darwin'
        ? spawnSync('launchctl',['print',`gui/${process.getuid()}/org.enntity.accord`],{stdio:'ignore'}).status===0
        : spawnSync('systemctl',['--user','is-active','--quiet','accord.service'],{stdio:'ignore'}).status===0;
      if(process.platform==='linux'&&(replaced||!running)){
        const reload=spawnSync('systemctl',['--user','daemon-reload'],{encoding:'utf8'});
        requireThat(reload.status===0,'SERVICE_FAILED','systemd user daemon-reload failed');
      }
      if(running)return {...result,alreadyRunning:true};
      const run=spawnSync(plan.command,plan.args,{encoding:'utf8'});
      requireThat(run.status===0,'SERVICE_FAILED',`${plan.command} did not register the service; inspect the generated service file`);
    }
  }
  return result;
}
