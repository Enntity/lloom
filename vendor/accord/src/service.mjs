// SPDX-License-Identifier: MIT
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { requireThat } from './common.mjs';

const xml = s => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function servicePlan({data,home=homedir(),platform=process.platform}={}) {
  data=resolve(data);home=resolve(home);
  const cli=fileURLToPath(new URL('./cli.mjs',import.meta.url));
  if(platform==='darwin'){
    const path=join(home,'Library','LaunchAgents','org.enntity.accord.plist');
    const args=[process.execPath,cli,'up','--data',data];
    const content=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>org.enntity.accord</string><key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer></dict></plist>\n`;
    return {path,content,command:'launchctl',args:['bootstrap',`gui/${process.getuid?.()??0}`,path],scope:'user login service'};
  }
  requireThat(platform==='linux','SERVICE_UNSUPPORTED','Automatic startup supports launchd and systemd user services; use accord up under your supervisor on this platform',400);
  const escape=s=>'"'+s.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')+'"';
  requireThat(!/[\r\n]/.test(data+cli+process.execPath),'BAD_PATH','Newlines in service paths are unsupported');
  return {path:join(home,'.config','systemd','user','accord.service'),
    content:`[Unit]\nDescription=Accord local coordination host\n[Service]\nExecStart=${[process.execPath,cli,'up','--data',data].map(escape).join(' ')}\nRestart=always\nRestartSec=10\n[Install]\nWantedBy=default.target\n`,
    command:'systemctl',args:['--user','enable','--now','accord.service'],scope:'user service; boot without login requires user-manager configuration'};
}
export function installService(options={}) {
  const plan=servicePlan(options);
  requireThat(!existsSync(plan.path)||readFileSync(plan.path,'utf8')===plan.content,'SERVICE_CONFLICT','Existing service file differs; review it before replacing');
  if(!options.dryRun){
    mkdirSync(dirname(plan.path),{recursive:true,mode:0o700});
    if(!existsSync(plan.path))writeFileSync(plan.path,plan.content,{mode:0o600,flag:'wx'});
    if(options.enable){
      requireThat(resolve(options.home??homedir())===resolve(homedir()),'SERVICE_HOME','Cannot enable a service for a different home');
      const running=process.platform==='darwin'
        ? spawnSync('launchctl',['print',`gui/${process.getuid()}/org.enntity.accord`],{stdio:'ignore'}).status===0
        : spawnSync('systemctl',['--user','is-active','--quiet','accord.service'],{stdio:'ignore'}).status===0;
      if(running)return {path:plan.path,dryRun:false,enabled:true,scope:plan.scope,alreadyRunning:true};
      if(process.platform==='linux'){
        const reload=spawnSync('systemctl',['--user','daemon-reload'],{encoding:'utf8'});
        requireThat(reload.status===0,'SERVICE_FAILED','systemd user daemon-reload failed');
      }
      const run=spawnSync(plan.command,plan.args,{encoding:'utf8'});
      requireThat(run.status===0,'SERVICE_FAILED',`${plan.command} did not register the service; inspect the generated service file`);
    }
  }
  return {path:plan.path,dryRun:Boolean(options.dryRun),enabled:Boolean(options.enable&&!options.dryRun),scope:plan.scope};
}
