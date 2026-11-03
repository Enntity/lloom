// SPDX-License-Identifier: MIT
// Agents set up through their own files. Each gets the MCP server, startup instructions
// and, where it can't already see ~/.agents/skills, the skill. Hooks stay Claude and Codex
// only: a wake needs an interface these agents don't share.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireThat } from './common.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const differs=name=>requireThat(false,'INSTALL_CONFLICT',`Existing ${name} Accord MCP registration differs`);

// An earlier install of Accord from another folder or Node: the same server and profile, with
// only the two paths changed. It upgrades in place; any other registration stays its owner's.
export const earlier=(found,{args})=>typeof found?.command==='string'&&Array.isArray(found.args)&&found.args.length===args.length
  &&/[\\/]src[\\/]cli\.mjs$/.test(found.args[0])&&same(found.args.slice(1),args.slice(1));
const named=entry=>Array.isArray(entry?.command)?{command:entry.command[0],args:entry.command.slice(1)}:{command:entry?.command,args:entry?.args};
export const movedEntry=(old,registration,build=r=>r)=>{const found=named(old);return earlier(found,registration)&&same(old,build(found));};
// The registration a text config names right after its Accord marker.
export function namedIn(text,marker,from=0){
  const at=text.indexOf(marker,from);if(at<0)return null;
  const match=/command\s*[=:]\s*("(?:[^"\\\n]|\\.)*")\s*\n\s*args\s*[=:]\s*(\[[^\n]*\])/.exec(text.slice(at));
  try{return match&&{command:JSON.parse(match[1]),args:JSON.parse(match[2])};}catch{return null;}
}
// Swaps an earlier install's block for this one; null when the text holds no such block.
function moved(old,marker,block,registration,from){
  const found=namedIn(old,marker,from);
  return found&&earlier(found,registration)&&old.includes(block(found))?old.replace(block(found),()=>block(registration)):null;
}

function json(name,keys,registration,build) {
  const entry=build(registration);
  return old=>{
    const config=old===null?{}:JSON.parse(old);let node=config;
    for(const key of keys)node=node[key]??={};
    if(node.accord&&!same(node.accord,entry)&&!movedEntry(node.accord,registration,build))differs(name);
    node.accord=entry;return JSON.stringify(config,null,2)+'\n';
  };
}
function toml(registration) {
  const block=({command,args})=>`[mcp_servers.accord]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nenabled = true\n`;
  return old=>{
    if(old?.includes(block(registration)))return old;
    if(old?.includes('[mcp_servers.accord]'))return moved(old,'[mcp_servers.accord]',block,registration)??differs('Grok');
    return (old?old.replace(/\n*$/,'\n\n'):'')+block(registration);
  };
}
// JSON strings and arrays are valid YAML, so paths with spaces need no YAML writer.
function yamlMap(registration) {
  const entry=(indent,{command,args})=>`${indent}accord:\n${indent}${indent}command: ${JSON.stringify(command)}\n${indent}${indent}args: ${JSON.stringify(args)}\n`;
  return old=>{
    const text=old??'',section=text.match(/^mcp_servers:(.*)\n?((?:[ \t]+.*\n?|\n)*)/m);
    if(!section)return (text?text.replace(/\n*$/,'\n\n'):'')+'mcp_servers:\n'+entry('  ',registration);
    requireThat(!section[1].trim(),'INSTALL_CONFLICT','Hermes mcp_servers is not a block mapping');
    const indent=section[2].match(/^([ \t]+)\S/m)?.[1]??'  ';
    if(text.includes(entry(indent,registration)))return text;
    if(new RegExp(`^${indent}accord:`,'m').test(section[2]))return moved(text,`${indent}accord:`,r=>entry(indent,r),registration,section.index)??differs('Hermes');
    const at=section.index+section[0].length-section[2].length;
    return text.slice(0,at)+(text[at-1]==='\n'?'':'\n')+entry(indent,registration)+text.slice(at);
  };
}
// A home-level patch reaches every profile, so `dsh`, `dsh web` and the desktop app share it.
function dshPatch(registration) {
  const entry=({command,args})=>`- insert:\n    - id: mcp-accord\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: accord\n        transport: stdio\n        command: ${JSON.stringify(command)}\n        args: ${JSON.stringify(args)}\n        toolCallTimeoutMs: 60000\n`;
  return old=>{
    if(old?.includes(entry(registration)))return old;
    if(old?.includes('id: mcp-accord'))return moved(old,'id: mcp-accord',entry,registration)??differs('DeepSeek Harness');
    return (old?old.replace(/\n*$/,'\n'):'')+entry(registration);
  };
}

const dshHome=(home,env)=>env.DSH_HOME||join(home,'.dsh');
const zcodeRoots=home=>[join(home,'.zcode'),join(home,'.enntity-zcode')];
export const agentClients={
  opencode:{installed:home=>[join(home,'.config','opencode')],setups(home,registration){
    const root=join(home,'.config','opencode');
    return [{path:join(root,'opencode.json'),merge:json('OpenCode',['mcp'],registration,r=>({type:'local',command:[r.command,...r.args],enabled:true})),instructions:join(root,'AGENTS.md')}];
  }},
  grok:{installed:home=>[join(home,'.grok')],setups(home,registration){
    const root=join(home,'.grok');
    return [{path:join(root,'config.toml'),merge:toml(registration),instructions:join(root,'rules','accord.md'),skill:join(root,'skills','accord','SKILL.md')}];
  }},
  omp:{installed:home=>[join(home,'.omp')],setups(home,registration){
    const root=join(home,'.omp','agent');
    return [{path:join(root,'mcp.json'),merge:json('OMP',['mcpServers'],registration,r=>({type:'stdio',...r})),instructions:join(root,'AGENTS.md')}];
  }},
  hermes:{installed:home=>[join(home,'.hermes')],setups(home,registration){
    const root=join(home,'.hermes');
    return [{path:join(root,'config.yaml'),merge:yamlMap(registration),instructions:join(root,'SOUL.md'),skill:join(root,'skills','coordination','accord','SKILL.md')}];
  }},
  zcode:{installed:zcodeRoots,setups(home,registration){
    const roots=zcodeRoots(home).filter(root=>existsSync(root));
    return (roots.length?roots:[zcodeRoots(home)[0]]).map(root=>({path:join(root,'cli','config.json'),instructions:join(root,'AGENTS.md'),
      merge:json('ZCode',['mcp','servers'],registration,r=>({type:'stdio',...r,enabled:true,timeoutMs:30000}))}));
  }},
  dsh:{installed:(home,env)=>[dshHome(home,env)],setups(home,registration,env){
    const root=dshHome(home,env);
    return [{path:join(root,'cordis.patch.yml'),merge:dshPatch(registration),instructions:join(root,'AGENTS.md')}];
  }},
};
export function detectClients(home,env=process.env) {
  return [...existsSync(join(home,'.config','devin'))?['devin']:[],
    ...Object.keys(agentClients).filter(client=>agentClients[client].installed(home,env).some(path=>existsSync(path)))];
}
