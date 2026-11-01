#!/usr/bin/env node
// SPDX-License-Identifier: MIT
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initialize, configuration, ensureBootstrap } from './config.mjs';
import { driverHost } from './driver-host.mjs';
import { coordinator } from './server.mjs';
import { listen, hash, request, requireThat, loopbackUrl } from './common.mjs';
import { AccordClient } from './client.mjs';

import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildSensors,sensorPath } from './native-sensors.mjs';
import { install } from './installer.mjs';
import { ensureAccord } from './product-install.mjs';
import { installService } from './service.mjs';
import { profileAt, discover, notice, runAgent, inheritedClient, enrollProfile } from './bootstrap.mjs';
import { connectHost } from './connect.mjs';
import { validateWorkloadConnector } from './workload-transport.mjs';
import { serveMcp } from './mcp.mjs';

const argv = process.argv.slice(2), requestedCommand = argv.shift() || 'help';
const separator = argv.indexOf('--'), ownArgs = separator < 0 ? argv : argv.slice(0, separator);
const command = ownArgs.includes('--help') || ownArgs.includes('-h') ? 'help' : requestedCommand;
function option(name, fallback) { const i = ownArgs.indexOf(`--${name}`); return i < 0 ? fallback : ownArgs[i + 1]; }
const home = resolve(option('home', homedir()));
const directory = resolve(option('data', process.env.ACCORD_DATA_DIR || join(home,'.local','share','accord')));
const profilePath = resolve(option('profile', process.env.ACCORD_PROFILE || join(home,'.config','accord','connection.json')));
function ready(value) { if (process.send) process.send({ type: 'ready', ...value }); else console.log(JSON.stringify(value)); }
function child(kind, extra = []) {
  return fork(fileURLToPath(import.meta.url), [kind, '--data', directory, ...extra], { stdio: ['ignore','ignore','inherit','ipc'] });
}
function readyChild(proc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { proc.kill(); reject(Error('Service startup timed out')); }, 10000);
    proc.once('error', reject); proc.once('exit', code => { clearTimeout(timeout); reject(Error(`Service exited before ready: ${code}`)); });
    proc.on('message', m => { if (m.type === 'ready') { clearTimeout(timeout); resolve(m); } });
  });
}
try {
  if (command === 'init') {
    console.log(JSON.stringify(initialize(directory)));
  } else if(command==='ensure'){
    console.log(JSON.stringify(await ensureAccord({home,data:directory,profilePath,dryRun:argv.includes('--dry-run'),start:!argv.includes('--no-start')})));
  } else if (command === 'install') {
    const dryRun=argv.includes('--dry-run');
    if(!existsSync(join(directory,'config.json'))){
      if(dryRun){console.log(JSON.stringify({dryRun:true,initialize:directory,home,steps:['create host identity','install CLI and skill','register MCP','write connection profile'],start:!argv.includes('--no-start')}));process.exit(0);}
      initialize(directory);
    }
    const result=install({home,data:directory,dryRun,clients:option('clients','codex,claude'+(existsSync(join(home,'.config','devin'))?',devin':'')).split(',').filter(Boolean)});
    const awarenessConfig=join(directory,'awareness.json');
    if(!dryRun&&!existsSync(awarenessConfig))writeFileSync(awarenessConfig,JSON.stringify({schema:1,roots:[{source:'codex',path:join(home,'.codex','sessions')},{source:'claude',path:join(home,'.claude','projects')}],summary:null,private:false},null,2)+'\n',{mode:0o600,flag:'wx'});
    result.sensors=buildSensors({output:sensorPath(directory),dryRun});
    if(!argv.includes('--no-start'))result.service=installService({home,data:directory,dryRun,enable:true});
    console.log(JSON.stringify(result,null,2));
  } else if(command==='session'){
    const path=resolve(option('session-file',join(home,'.config','accord','shell-session.json')));
    if(argv[0]==='open'){
      requireThat(!existsSync(path),'SESSION_EXISTS','Close the existing session or select another --session-file');
      const c=await enrollProfile(profilePath,{label:option('label','shell agent'),harness:option('harness','cli')});
      mkdirSync(dirname(path),{recursive:true,mode:0o700});
      writeFileSync(path,JSON.stringify({schema:1,url:c.url,...c.session}),{mode:0o600,flag:'wx'});
      console.log(JSON.stringify({sessionFile:path,...await c.bootstrap()},null,2));
    }else{
      requireThat(argv[0]==='close','INVALID_COMMAND','Use session open or session close');
      process.env.ACCORD_SESSION_FILE=path;await inheritedClient().closeSession();rmSync(path);console.log(JSON.stringify({closed:true}));
    }
  } else if(command==='workload'&&argv[0]==='policy'){
    const config=configuration(directory),endpoints=JSON.parse(readFileSync(join(directory,'endpoints.json'),'utf8'));
    const c=new AccordClient(endpoints.coordinator,config.readToken('admin'));const me=await c.me();requireThat(me.role==='admin','FORBIDDEN','Operator required',403);
    const body=JSON.parse(readFileSync(option('file'),'utf8'));
    requireThat(body.schema===1&&body.hosts&&body.resources,'WORKLOAD_POLICY','Expected schema 1, hosts and resources');
    for(const connector of Object.values(body.hosts))validateWorkloadConnector(connector);
    const catalog=await c.resources();
    for(const [id,r]of Object.entries(body.resources)){
      requireThat(catalog.resources.some(x=>x.localId===id&&!x.manager),'WORKLOAD_POLICY','Policy must name a registered local resource');
      requireThat(Array.isArray(r.hosts)&&r.hosts.length>0&&r.hosts.length<=16&&r.hosts.every(h=>body.hosts[h])&&Array.isArray(r.plugins)&&r.plugins.every(p=>['docker-container','systemd-user-unit'].includes(p)),'WORKLOAD_POLICY','Invalid resource connector policy');
    }
    const target=join(directory,'workload-policy.json'),temporary=target+'.'+randomUUID();
    writeFileSync(temporary,JSON.stringify(body,null,2)+'\n',{mode:0o600,flag:'wx'});
    const fd=openSync(temporary,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,target);
    const dd=openSync(directory,'r');try{fsyncSync(dd);}finally{closeSync(dd);}
    console.log(JSON.stringify({installed:true,resources:Object.keys(body.resources),hosts:Object.keys(body.hosts)}));
  } else if(command==='workload'&&argv[0]==='adopt'){
    const config=configuration(directory),endpoints=JSON.parse(readFileSync(join(directory,'endpoints.json'),'utf8'));
    const body=JSON.parse(readFileSync(option('file'),'utf8'));body.key=body.key??option('key',randomUUID());
    console.log(JSON.stringify(await new AccordClient(endpoints.coordinator,config.readToken('admin')).adoptWorkloads(body),null,2));
  } else if(['announce','find','send','inbox','read','sent','reserve','reservation','release','extend','workload'].includes(command)){
    process.env.ACCORD_SESSION_FILE=option('session-file',process.env.ACCORD_SESSION_FILE??join(home,'.config','accord','shell-session.json'));
    const c=inheritedClient(),key=option('key',randomUUID()),host=option('host'),id=option('id');let result;
    if(command==='announce')result=await c.announce({key,label:option('label','agent'),activity:option('activity','available'),state:option('state',undefined),location:option('location',process.cwd()),capabilities:option('capabilities','').split(',').filter(Boolean)});
    if(command==='find')result=await c.find(option('query',''));
    if(command==='send')result=await c.send(option('to'),option('text'),{key,kind:argv.includes('--notify')?'notification':'message'});
    if(command==='inbox')result=await c.waitInbox(Number(option('wait-ms',0)));
    if(command==='read')result=await c.read(id);
    if(command==='sent')result=await c.sent(id);
    if(command==='reserve')result=await c.reserve(option('resource'),{key,host,purpose:option('purpose','reserved'),leaseMs:Number(option('lease-ms',300000)),waitMs:Number(option('queue-ms',3600000))});
    if(command==='reservation')result=await c.reservation(id,host);
    if(command==='release')result=await c.release(id,{key,host});
    if(command==='extend')result=await c.collaborate('renew',{id,key,leaseMs:Number(option('lease-ms',300000))},host);
    if(command==='workload'){
      const actions={start:'start',status:'process',register:'workload-register',launch:'workload-launch',list:'workload-list'};
      requireThat(actions[argv[0]],'INVALID_COMMAND','Use workload start, status, register, launch, list or adopt');
      result=await c.collaborate(actions[argv[0]],{id,key,...(argv[0]==='register'?{targets:JSON.parse(readFileSync(option('file'),'utf8')).targets}:{}),...(argv[0]==='launch'?{workload:option('workload')}:{})},host);
    }
    console.log(JSON.stringify(result,null,2));
  } else if(['sessions','session-read','report','jobs','job','ask','question','overseer','snooze'].includes(command)){
    process.env.ACCORD_SESSION_FILE=option('session-file',process.env.ACCORD_SESSION_FILE??join(home,'.config','accord','shell-session.json'));
    const c=inheritedClient(),body=option('input')?JSON.parse(readFileSync(option('input'),'utf8')):{};
    const op={report:'session-report',snooze:'session-snooze'}[command]??command;
    console.log(JSON.stringify(await c.collaborate(op,{...body,...(option('id')?{id:option('id')}:{}),...(option('query')?{query:option('query')}:{}),key:option('key',randomUUID())},option('host')),null,2));
  } else if(['policy','signal','privacy'].includes(command)){
    const config=configuration(directory),endpoints=JSON.parse(readFileSync(join(directory,'endpoints.json'),'utf8'));
    const body=option('input')?JSON.parse(readFileSync(option('input'),'utf8')):{};
    const operation={policy:'overseer-rule',signal:'overseer-signal',privacy:'source-privacy'}[command];
    if(command==='privacy'){body.source=option('source');requireThat(argv.includes('--on')!==argv.includes('--off'),'INVALID_INPUT','Specify --on or --off');body.private=argv.includes('--on');}
    console.log(JSON.stringify(await request(endpoints.coordinator,config.readToken('admin'),'/v1/collaboration',{operation,args:{...body,key:option('key',randomUUID())}}),null,2));
  } else if(command==='connect'||command==='disconnect'){
    console.log(JSON.stringify(await connectHost({host:argv[0],home,data:directory,remoteCli:option('remote-cli'),remoteNode:option('remote-node'),remoteData:option('remote-data'),disconnect:command==='disconnect'}),null,2));
  } else if(command==='link'){
    requireThat(argv.includes('--stdin'),'INPUT_REQUIRED','Supply the private link descriptor through stdin');
    const body=JSON.parse(readFileSync(0,'utf8')),config=configuration(directory),endpoints=JSON.parse(readFileSync(join(directory,'endpoints.json'),'utf8'));
    console.log(JSON.stringify(await request(endpoints.coordinator,config.readToken('admin'),body.remove?'/v1/links/remove':'/v1/links',{...body,key:randomUUID()})));
  } else if(command==='descriptor'){
    const config=configuration(directory),endpoints=JSON.parse(readFileSync(join(directory,'endpoints.json'),'utf8'));
    console.log(JSON.stringify({authority:config.authority,url:endpoints.coordinator}));
  } else if (command === 'service') {
    requireThat(argv[0]==='install','INVALID_COMMAND','Use accord service install [--enable] [--dry-run]');
    console.log(JSON.stringify(installService({home,data:directory,enable:argv.includes('--enable'),dryRun:argv.includes('--dry-run')}),null,2));
  } else if (command === 'mcp') {
    await serveMcp(profilePath);
  } else if (command === 'run') {
    const separator=argv.indexOf('--');requireThat(separator>=0,'COMMAND_REQUIRED','Use accord run -- COMMAND [ARGS]');
    process.exitCode=await runAgent(profilePath,argv[separator+1],argv.slice(separator+2));
  } else if (['claim','wait','inspect','checkpoint','renew','write','finish','process-start','process-status'].includes(command)) {
    const client=inheritedClient(),key=option('key');
    if(!['inspect','process-status'].includes(command))requireThat(key,'KEY_REQUIRED','Supply --key for safe retries');
    const claimId=option('claim');let result;
    if(command==='claim'||command==='wait'){
      const options={key,taskId:option('task'),resource:option('resource'),leaseMs:Number(option('lease-ms',10000))};
      result=command==='claim'?await client.claim(options):await client.waitClaim({...options,waitMs:Number(option('wait-ms',20000))});
      delete result.resourceToken;delete result.driverUrl;
    }
    if(command==='inspect'){result=await client.inspect(claimId);delete result.resourceToken;delete result.driverUrl;}
    if(command==='checkpoint')result=await client.checkpoint(claimId,option('note'),key);
    if(command==='renew')result=await client.renew(claimId,Number(option('lease-ms',10000)),key);
    if(command==='write')result=await client.writeViaHost({id:claimId},readFileSync(option('input'),'utf8'),key);
    if(command==='process-start')result=await client.startProcess(claimId,key);
    if(command==='process-status')result=await client.processStatus(claimId);
    if(command==='finish')result=await client.finish(claimId,option('receipt'),key);
    console.log(JSON.stringify(result,null,2));
  } else if (command === 'context') {
    console.log(JSON.stringify(await inheritedClient().bootstrap(),null,2));
  } else if (command === 'host' || command === 'doctor') {
    try {
      const host=await discover(profileAt(profilePath));
      if(command==='doctor')console.log(JSON.stringify({status:(host.resources??[host.resource]).every(r=>r.driver==='reachable'&&r.state!=='unknown')?'ready':'degraded',host,profile:profilePath,
        integration:'Connection and authority checked. Restart harnesses after installation; harness loading is not observable here.'},null,2));
      else console.log(argv.includes('--notice')?notice(host):JSON.stringify(host,null,2));
    } catch(error){
      if(argv.includes('--notice')){console.log('Accord: ownership UNKNOWN; host discovery unavailable. Do not infer availability.');process.exitCode=1;}
      else throw error;
    }
  } else if (command === 'join' || command === 'leave') {
    const config=configuration(directory),endpoints=JSON.parse(readFileSync(join(directory,'endpoints.json'),'utf8'));
    const authority=option('authority');requireThat(authority,'AUTHORITY_REQUIRED','Provide --authority from the peer host descriptor');
    const body=command==='join'?{key:randomUUID(),authority,url:loopbackUrl(option('url')),
      credential:readFileSync(option('discovery-file'),'utf8').trim()}:{key:randomUUID(),authority};
    console.log(JSON.stringify(await request(endpoints.coordinator,config.readToken('admin'),command==='join'?'/v1/peers':'/v1/peers/remove',body),null,2));
  } else if (command === 'resource' || command === 'plugins') {
    const config=configuration(directory),endpoints=JSON.parse(readFileSync(join(directory,'endpoints.json'),'utf8'));
    const body=command==='resource'&&argv[0]==='register'?{key:option('key',randomUUID()),manifest:JSON.parse(readFileSync(option('file'),'utf8'))}:undefined;
    requireThat(command==='plugins'||['list','register'].includes(argv[0]),'INVALID_COMMAND','Use resource list or resource register --file MANIFEST');
    console.log(JSON.stringify(await request(endpoints.coordinator,config.readToken('admin'),command==='plugins'?'/v1/plugins':'/v1/resources',body),null,2));
  } else if (command === 'telemetry'||command === 'machine') {
    const session=option('session-file',process.env.ACCORD_SESSION_FILE);let client;
    if(session){process.env.ACCORD_SESSION_FILE=session;client=inheritedClient();}
    else{const p=profileAt(profilePath);await discover(p);client=new AccordClient(p.url,readFileSync(p.discoveryFile,'utf8').trim());}
    console.log(JSON.stringify(await client[command==='machine'?'metadata':'telemetry'](option('host')),null,2));
  } else if (command === 'network') {
    const config=configuration(directory),endpoints=JSON.parse(readFileSync(join(directory,'endpoints.json'),'utf8'));
    console.log(JSON.stringify(await request(endpoints.coordinator,config.readToken('admin'),'/v1/network'),null,2));
  } else if (command === 'driver') {
    const config = configuration(directory), driver = driverHost(directory,config.readToken('driver-control'));
    const server = driver.server;
    const url = await listen(server, Number(option('port', 0)));
    ready({ url, instance: driver.status().instance });
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; server.closeAllConnections(); server.close(() => { driver.close(); process.exit(0); }); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } else if (command === 'serve') {
    const authority=ensureBootstrap(directory);
    const config = configuration(directory);
    const service = coordinator({ db: join(directory, 'coordinator.sqlite'), claimSecret: config.readToken('claim-secret'),
      driverUrl: option('driver-url', 'http://127.0.0.1:8788'), driverToken: config.readToken('driver-control'), driverInstance: config.driverInstance,
      leaderMs: Number(option('leader-ms', 5000)), hostName:option('name',hostname()) });
    const url = await listen(service.server, Number(option('port', 0)));
    writeFileSync(join(directory,'endpoints.json'),JSON.stringify({coordinator:url,authority}),{mode:0o600});
    ready({ url, authority });
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await service.close(); process.exit(0); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  } else if (command === 'up') {
    configuration(directory); // explicit initialization; no overwrite or hidden enrollment
    const driver = child('driver', ['--port', option('driver-port', '8788')]);
    let service;
    const stop = () => { service?.kill('SIGTERM'); driver.kill('SIGTERM'); };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    try {
      const d = await readyChild(driver);
      service = child('serve', ['--driver-url', d.url, '--port', option('port', '8787')]);
      const s = await readyChild(service);
      writeFileSync(join(directory, 'endpoints.json'), JSON.stringify({ coordinator: s.url, driver: d.url }), { mode: 0o600 });
      ready({ url: s.url, data: directory, adminTokenFile: join(directory, 'admin.token') });
      // The supervisor shuts down its owned children when either service exits.
      await Promise.race([new Promise(r => driver.once('exit', r)), new Promise(r => service.once('exit', r))]);
      process.exitCode=1; // Let the service manager restart after an unexpected child exit.
    } finally { stop(); }
  } else if (['board','submit','pause','resume','artifact'].includes(command)) {
    const inherited=Boolean(process.env.ACCORD_SESSION_FILE);
    const config = inherited ? null : configuration(directory);
    const endpoints = inherited ? null : JSON.parse(readFileSync(join(directory, 'endpoints.json'), 'utf8'));
    const client = inherited ? inheritedClient() : new AccordClient(endpoints.coordinator, config.readToken('admin'));
    if(command==='artifact')requireThat(!inherited,'FORBIDDEN','Artifact administration is not a worker-session operation',403);
    let result;
    if (command === 'board') result = await client.board();
    if (command === 'pause' || command === 'resume') result = await client.pause(command === 'pause');
    if (command === 'submit') {
      const input = readFileSync(option('input'), 'utf8'), expected = readFileSync(option('expected'), 'utf8');
      result = await client.submit({ title: option('title', 'Artifact task'), input, expectedHash: hash(expected),resource:option('resource','artifact') });
    }
    if (command === 'artifact') result = await request(endpoints.driver, config.readToken('driver-control'), `/control/artifacts/${option('receipt')}`);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Accord 0.4 preview — discover, message, share; Node 22.13+\n\n  accord install [--no-start] [--dry-run] [--clients codex,claude]\n  accord connect|disconnect SSH_HOST\n  accord session open --label NAME [--session-file FILE]\n  accord session close [--session-file FILE]\n  accord announce --label NAME --activity TEXT [--capabilities a,b]\n  accord find [--query TEXT]\n  accord send --to ADDRESS --text TEXT [--notify] [--key KEY]\n  accord inbox [--wait-ms 20000]\n  accord read --id DELIVERY_ID\n  accord sent --id MESSAGE_ID\n  accord reserve --resource ADDRESS --purpose TEXT [--key KEY]\n  accord reservation|release|extend --id ID [--host AUTHORITY]\n  accord workload start|status|list --id ID [--host AUTHORITY]\n  accord workload register --id ID --file TARGETS.json [--host AUTHORITY]\n  accord workload launch --id ID --workload BINDING_ID [--host AUTHORITY]\n  accord workload policy --data DIR --file POLICY.json (operator only)\n  accord workload adopt --data DIR --file ADOPTION.json (operator only)\n  accord resource list|register --file MANIFEST\n  accord plugins\n  accord process-start|process-status --claim ID [--key KEY]\n  accord doctor\n  accord run -- COMMAND [ARGS]\n  accord context\n  accord claim|wait --key KEY [--task ID]\n  accord inspect --claim ID\n  accord checkpoint --claim ID --key KEY --note TEXT\n  accord renew --claim ID --key KEY --lease-ms MS\n  accord write --claim ID --key KEY --input FILE\n  accord finish --claim ID --key KEY --receipt ID\n  accord host [--notice]\n  accord mcp\n  accord service install [--enable]\n  accord join --url LOOPBACK --authority ID --discovery-file FILE\n  accord leave --authority ID\n  accord sessions [--query TEXT] [--host AUTHORITY]\n  accord session-read --id ID\n  accord report|job|ask|snooze --input JSON_FILE\n  accord jobs|overseer\n  accord policy|signal --input JSON_FILE\n  accord privacy --source SOURCE --on|--off\n  accord question --id ID\n  accord telemetry|machine [--host AUTHORITY]\n  accord network\n  accord init --data DIR\n  accord up --data DIR [--port 8787] [--driver-port 8788]\n  accord board --data DIR\n  accord submit --data DIR --input FILE --expected FILE [--title TEXT]\n  accord pause|resume --data DIR\n  accord artifact --data DIR --receipt ID\n\nOutput is JSON except help and --notice; run inherits its child's output. init creates an admin identity; agents enroll their own sessions.\nRun npm run demo for the isolated two-process recovery proof. No model or GPU is required.`);
  }
} catch (error) {
  console.error(JSON.stringify({ error: { code: error.code || 'STARTUP_FAILED', message: error.message } })); process.exit(1);
}
