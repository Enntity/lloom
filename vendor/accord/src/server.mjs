// SPDX-License-Identifier: MIT
import { ResourceManagers } from './resource-managers.mjs';
import { awarenessRuntime } from './awareness-runtime.mjs';
import { SessionAwareness } from './session-awareness.mjs';
import { Overseer } from './overseer.mjs';
import { dirname,join } from 'node:path';
import { createTelemetry } from './telemetry.mjs';
import { createCollectors } from './telemetry-collectors.mjs';
import { sensorPath } from './native-sensors.mjs';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { plugins,validateResource } from './resource-plugins.mjs';
import { Collaboration } from './collaboration.mjs';
import { MemoryPanorama, memoryConfig, peerEntries } from './memory-panorama.mjs';
import { Attention } from './attention.mjs';
import { Store } from './store.mjs';
import { bootstrapView } from './bootstrap-view.mjs';
import { find as compactFind } from './compact.mjs';
import { createHttp, bearer, readBody, hash, request, integer, requireThat, loopbackUrl, text } from './common.mjs';

export function coordinator({ db, claimSecret, driverUrl, driverToken, driverInstance, leaderMs = 5000, tickMs = 100, hostName = 'local', telemetryCollectors }) {
  integer(leaderMs, 'leaderMs', 500, 30000); integer(tickMs, 'tickMs', 10, 1000);
  const parsed = new URL(driverUrl);
  requireThat(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) && !parsed.username && !parsed.password,
    'BAD_DRIVER_URL', 'This release supports a loopback HTTP driver only', 400);
  const store = new Store(db, { leaderMs });
  try { store.takeLeadership(); } catch (e) { store.close(); throw e; }
  const collaboration=new Collaboration(store,db);
  const memory=new MemoryPanorama(store,memoryConfig());
  const managers=new ResourceManagers(store,dirname(db));
  const awareness=new SessionAwareness(store),overseer=new Overseer(store,awareness,collaboration);
  managers.onRunning=row=>{try{collaboration.granted(overseer.actor,{key:`grant:${row.id}`,reservation:row.id,actor:row.actor,resource:row.resource,queuedAt:row.created_at});}catch{/* A notice is a hint. */}};
  const attention=new Attention(store,collaboration,join(dirname(db),'attention'),{perHour:Number(process.env.ACCORD_WAKE_PER_HOUR||6)});
  const telemetry=createTelemetry({authority:store.authority,hostName,collectors:telemetryCollectors??createCollectors({nativeHelper:sensorPath(dirname(db))})});
  const observationRuntime=awarenessRuntime(dirname(db),awareness);
  const secretFor = claim => createHmac('sha256', claimSecret).update(claim.id).digest('base64url');
  const sessionSecret = sessionId => createHmac('sha256', claimSecret).update(`session:${sessionId}`).digest('base64url');
  const instanceFor=resource=>resource==='artifact'?driverInstance:store.binding(resource)?.instance;
  const driverPath=(path,resource='artifact')=>resource==='artifact'?path:`${path}?resource=${encodeURIComponent(resource)}`;
  const grant = claim => ({ instance: instanceFor(claim.resource), authority: store.authority, epoch: store.epoch, generation: claim.generation, claimId: claim.id });
  let closed = false, busy = false, unhealthy = false;
  let reportFailure;
  const failed = new Promise(resolve => { reportFailure = resolve; });
  function fail(error) {
    if (closed || unhealthy) return;
    unhealthy = true;
    reportFailure(error);
  }

  // Pending claim states are a durable outbox: retries use the exact attempt and generation.
  async function reconcile() {
    if (busy || closed || unhealthy) return;
    busy = true;
    try {
      store.sweep();
      collaboration.schedule();
      void managers.reconcile().catch(()=>{});
      for (const claim of store.pending()) {
        if (closed) break;
        try {
          store.assertLeader();
          const activating = claim.state === 'preparing';
          const response = await request(driverUrl, driverToken, driverPath(activating ? '/control/activate' : '/control/revoke',claim.resource), {
            ...grant(claim), ...(activating ? { credentialHash: hash(secretFor(claim)) } : {})
          }, 600);
          requireThat(response.instance === instanceFor(claim.resource) && response.claimId === claim.id && response.generation === claim.generation && (activating ? response.active === true : response.released === true),
            'BAD_DRIVER_RECEIPT', 'Driver did not confirm this generation', 503);
          if (activating) {
            store.activated(claim.id);
            // Activation is a no-op if the claim changed meanwhile; never report a grant that didn't happen.
            try { if(store.claim(claim.id).state==='running')collaboration.grantedClaim(overseer.actor,claim); } catch { /* A notice is a hint. */ }
          } else {
            store.released(claim.id);
            try { collaboration.endedClaim(overseer.actor,claim); } catch { /* A notice is a hint. */ }
          }
        } catch (error) {
          // This generation can never activate there, so waiting for its deadline only idles the resource.
          if (claim.state === 'preparing' && ['REVOKED','RECOVERING'].includes(error.code)) store.refused(claim.id, error.code);
          else store.driverError(claim.id, ['DRIVER_REPLACED','STALE_FENCE','WRONG_AUTHORITY','REVOKED'].includes(error.code) ? error.code : 'DRIVER_UNAVAILABLE');
        }
      }
    } catch (error) { fail(error); } finally { busy = false; }
  }
  const heartbeat = setInterval(() => {
    if (!closed && !unhealthy) { try { store.beat(); } catch (error) { fail(error); } }
  }, Math.min(500, leaderMs / 3));
  const timer = setInterval(reconcile, tickMs);
  let monitoring=false;
  const overseerTimer=setInterval(async()=>{if(closed||unhealthy||monitoring)return;monitoring=true;try{
    overseer.quiet();
    const rules=overseer.rules().filter(r=>r.enabled&&r.kind==='idle-resource');
    if(rules.length){
      const resources=[...(await host()).resources,...await managers.resources()];
      await Promise.all(rules.map(async rule=>{
        let resource=resources.find(r=>r.id===rule.resource||r.localId===rule.resource);
        const authority=rule.resource.includes('/')?rule.resource.split('/')[0]:store.authority;
        if(!resource&&authority!==store.authority)try{resource=(await collaboration.forward(authority,'resources',{},overseer.actor)).resources.find(r=>r.id===rule.resource);}catch{}
        const holder=resource?.holder;
        const localHolder=holder?.originActor?{...holder,actor:holder.originActor}:holder;
        let samples=[];try{samples=await Promise.all((rule.telemetryHosts??[store.authority]).map(h=>h===store.authority?telemetry.telemetry():collaboration.forward(h,'telemetry',{},overseer.actor)));}catch{}
        const known=samples.length===(rule.telemetryHosts?.length??1)&&samples.every(s=>!s.stale&&Number.isFinite(s.host?.gpu?.utilization)&&Number.isSafeInteger(s.sampledAt));
        overseer.resource(rule,{resource:rule.resource,holder:localHolder,utilization:known?Math.max(...samples.map(s=>s.host.gpu.utilization)):null,observedAt:known?Math.min(...samples.map(s=>s.sampledAt)):null,stale:!known});
      }));
    }
    overseer.dispatch();
  }catch{/* Keep ownership reconciliation independent of observation failures. */}finally{monitoring=false;}},10000);
  const mailTimer=setInterval(()=>{if(!closed&&!unhealthy)void collaboration.flush().catch(()=>{});},1000);
  memory.start();
  function describe(actor, claimId) {
    const claim = store.owned(actor, claimId);
    return { ...claim, task: store.task(claim.task_id), driverUrl,
      ...(claim.state === 'running' && claim.deadline > store.now() ? { resourceToken: secretFor(claim) } : {}) };
  }
  async function host() {
    // Host discovery needs current ownership, not the entire retained journal.
    store.assertLeader();
    const board={paused:store.db.prepare("SELECT value FROM meta WHERE key='paused'").get().value==='true',
      claims:store.db.prepare("SELECT * FROM claims WHERE state!='closed'").all(),
      resources:store.db.prepare('SELECT r.id,b.plugin,b.asset,b.enforcement,p.pool FROM resources r LEFT JOIN resource_bindings b ON b.id=r.id LEFT JOIN resource_pools p ON p.resource=r.id ORDER BY r.id').all()};
    const resources=await Promise.all(board.resources.map(async resource=>{
      let status,driverError;
      try {
        status=await request(driverUrl,driverToken,driverPath('/control/status',resource.id),undefined,600);
        requireThat(status.instance===instanceFor(resource.id)&&(!status.authority||status.authority===store.authority),'DRIVER_REPLACED','Driver identity mismatch');
      }catch(error){driverError=error.code==='DRIVER_REPLACED'?error.code:'DRIVER_UNAVAILABLE';}
      const holder=board.claims.find(c=>c.resource===resource.id&&c.state!=='closed');
      const session=holder&&(store.db.prepare('SELECT label FROM participants WHERE actor=?').get(holder.actor)??store.db.prepare('SELECT label FROM sessions WHERE id=?').get(holder.actor));
      const origin=holder&&store.db.prepare('SELECT authority,session_id FROM remote_routes WHERE actor=?').get(holder.actor);
      const queue=store.db.prepare("SELECT r.id,r.actor,r.queued_until queuedUntil,t.title purpose,t.created_at queuedAt FROM reservations r JOIN tasks t ON t.id=r.task_id WHERE t.resource=? AND r.pool IS NULL AND t.state='queued' ORDER BY t.created_at,t.rowid LIMIT 100").all(resource.id);
      return {id:`${store.authority}/${resource.id}`,localId:resource.id,...(resource.pool?{pool:resource.pool}:{}),plugin:resource.plugin??'artifact',asset:resource.asset??'builtin:artifact',
        label:status?.label??resource.id,maxOwnershipMs:store.ownershipLimit(resource.id),externalWorkloads:status?.externalWorkloads??null,hosts:status?.hosts??[],queue,state:!driverError&&!status?.blocked&&!holder&&!status.claim_id?(queue.length?'queued':'unclaimed'):holder?'held':'unknown',enforcement:resource.enforcement??'artifact-API',driver:driverError||'reachable',
        holder:holder?{claim:holder.id,actor:holder.actor,address:origin?`${origin.authority}/${origin.session_id}`:`${store.authority}/${holder.actor}`,label:session?.label??holder.actor,generation:holder.generation,state:holder.state,deadline:holder.deadline,task:holder.task_id}:null};
    }));
    store.assertLeader();
    return {protocol:'accord/1',authority:store.authority,name:hostName,epoch:store.epoch,observedAt:store.now(),paused:board.paused,pools:collaboration.pools(resources),
      resource:resources.find(r=>r.localId==='artifact'),resources,capabilities:['sessions','checkpoints','fenced-artifacts','peer-discovery','registered-processes','collaboration','messaging','reservations','host-telemetry','host-metadata','session-search','session-summaries','overseer','jobs','questions','resource-managers'],
      admission:'Availability is an observation. Only a successful claim grants ownership.'};
  }
  async function catalog() {
    const resources=[...(await host()).resources,...await managers.resources()],pools=collaboration.pools(resources);
    return {resources,capabilities:['reservation-windows-v1'],...(pools.length?{pools}:{})};
  }
  async function network() {
    const peers = store.db.prepare('SELECT * FROM peers ORDER BY authority').all();
    return Promise.all(peers.map(async peer => {
      const checkedAt = Date.now();
      try {
        const remote = await request(peer.url, peer.credential, '/v1/host', undefined, 1000);
        requireThat(remote.protocol === 'accord/1' && remote.authority === peer.authority && remote.resource?.id === `${peer.authority}/artifact`,
          'PEER_IDENTITY_CHANGED', 'Pinned host identity does not match');
        return {authority:peer.authority, endpoint:peer.url, status:'observed', checkedAt, host:remote};
      } catch (error) {
        return {authority:peer.authority, endpoint:peer.url, status:'unknown', checkedAt,
          reason:error.code === 'PEER_IDENTITY_CHANGED' ? error.code : 'PEER_UNAVAILABLE'};
      }
    }));
  }
  async function sessionsAcrossHosts(actor,args={}) {
    const local=awareness.list(args), hosts=[];
    const remote=await Promise.all(store.db.prepare('SELECT authority FROM links ORDER BY authority LIMIT 32').all().map(async peer=>{
      try { const result=await collaboration.forward(peer.authority,'sessions',args,actor);hosts.push({authority:peer.authority,status:'observed'});return result.sessions; }
      catch { hosts.push({authority:peer.authority,status:'unknown'});return []; }
    }));
    return {sessions:[...local.sessions,...remote.flat()].sort((a,b)=>b.progressAt-a.progressAt).slice(0,200),hosts};
  }
  async function memoriesAcrossHosts(actor,args={}) {
    const local=memory.list(args), hosts=[];
    const remote=await Promise.all(store.db.prepare('SELECT authority FROM links ORDER BY authority LIMIT 32').all().map(async peer=>{
      try { const result=await collaboration.forward(peer.authority,'memories',args,actor);hosts.push({authority:peer.authority,status:'observed'});
        return peerEntries(result,peer.authority); }
      catch { hosts.push({authority:peer.authority,status:'unknown'});return []; }
    }));
    return {entries:[...local.entries,...remote.flat()].sort((a,b)=>b.updated.localeCompare(a.updated)).slice(0,args.limit??10),hosts,sources:local.sources,lastScan:local.lastScan};
  }
  function nativeActor(view) {
    const binding=store.db.prepare('SELECT b.actor FROM session_bindings b JOIN sessions s ON s.id=b.actor WHERE b.source=? AND b.external_id=? AND s.closed_at IS NULL AND s.expires_at>?').get(view.source,view.external_id,store.now());
    return {id:binding?.actor??view.id,role:'worker'};
  }
  async function collaborate(actor,operation,args={},signal) {
    if(['telemetry','metadata','memory'].includes(operation))return telemetry[operation]();
    if(operation==='hosts')return {authority:store.authority,hosts:[{authority:store.authority,local:true},...store.db.prepare('SELECT authority FROM links ORDER BY authority').all().map(h=>({...h,local:false}))]};
    if(operation==='bridge-inbox'){requireThat(actor.role==='admin','FORBIDDEN','Host adapter required',403);text(args.source,'source',64);return {deliveries:store.db.prepare('SELECT id,source,external_id FROM session_views WHERE source=? AND private=0 AND hidden=0 ORDER BY observed_at DESC LIMIT 200').all(args.source).flatMap(s=>collaboration.inbox(nativeActor(s)).messages.slice(0,10).map(m=>({...m,session:s.id,externalId:s.external_id}))).slice(0,100)};}
    if(operation==='manager-configure')return managers.configure(actor,args);
    if(operation==='manager-schedules'){requireThat(actor.role==='admin','FORBIDDEN','Operator required',403);return managers.schedules();}
    if(operation==='summary-configure')return observationRuntime.configureSummary(actor,args);
    if(operation==='session-bind')return awareness.bind(actor,args);
    if(['context-inbox','context-wait'].includes(operation)) {
      requireThat(actor.role==='admin','FORBIDDEN','Trusted local hook required',403);attention.key(args);
      if(operation==='context-wait')return attention.wake(args,signal);
      if(args.actor)awareness.bind(actor,{key:'hook-bind:'+hash(JSON.stringify([args.source,args.externalId,args.actor])),source:args.source,externalId:args.externalId,actor:args.actor});
      return attention.present(args);
    }

    if(operation==='source-privacy')return awareness.privacy(actor,args);
    if(operation==='question-dismiss')return awareness.dismiss(actor,args);
    if(operation==='session-report')return awareness.report(actor,args);
    if(operation==='heartbeat')return awareness.heartbeat(actor);
    if(operation==='sessions')return awareness.list(args);
    if(operation==='session-read')return awareness.read(args.id,args);
    if(operation==='memories')return memory.list(args);
    if(operation==='memory-read')return memory.read(args.id);
    if(operation==='session-snooze')return awareness.snooze(actor,args);
    if(operation==='jobs')return awareness.jobs();
    if(operation==='job')return awareness.job(actor,args);
    if(operation==='ask')return awareness.ask(actor,args);
    if(operation==='answer')return awareness.answer(actor,args);
    if(operation==='question')return awareness.question(actor,args.id);
    if(operation==='overseer')return {rules:overseer.rules(),...overseer.incidents()};
    if(operation==='overseer-rule')return overseer.configure(actor,args);
    if(operation==='overseer-signal')return overseer.signal(actor,args);
    if(operation==='announce'){const result=collaboration.announce(actor,args);awareness.announce(actor,args);return result;}
    if(operation==='find'){const result=await collaboration.find(args.query??'',true,collaboration.address(actor));return args.detail===true?result:compactFind(result,args.query??'');}
    if(operation==='send'){const r=collaboration.send(actor,args);void collaboration.flush().catch(()=>{});return collaboration.sent(actor,r.id);}
    if(operation==='inbox'){
      integer(args.waitMs??0,'waitMs',0,3600000);
      if(args.waitMs)await attention.wait(()=>collaboration.pendingCount(actor)>0||null,args.waitMs,signal,actor.id);
      return collaboration.inbox(actor,{all:args.all===true});
    }
    if(operation==='notify')return collaboration.notify(actor,args);
    if(operation==='read')return collaboration.read(actor,args);
    if(operation==='sent')return collaboration.sent(actor,args.id);
    if(operation==='resources')return catalog();
    if(operation==='reserve'&&!store.db.prepare('SELECT 1 FROM session_views WHERE id=?').get(actor.id))awareness.report(actor,{key:'reservation-session-view',title:actor.session?.label??'Resource holder',state:'working'});
    if(operation==='reserve'&&managers.owns(args.resource))return managers.reserve(actor,args);
    if(['reservation','release','renew'].includes(operation)&&store.db.prepare('SELECT 1 FROM manager_requests WHERE id=?').get(args.id)){if(operation==='reservation')return managers.status(actor,args.id);if(operation==='release')return managers.release(actor,args);return managers.renew(actor,args);}
    if(operation==='reserve'){const r=collaboration.reserve(actor,args);void reconcile();return collaboration.reservation(actor,r.id);}
    if(operation==='reservation')return collaboration.reservation(actor,args.id);
    if(operation==='release'){const r=collaboration.release(actor,args.id,args);void reconcile();return r;}
    if(['renew','start','process','workload-register','workload-launch','workload-list'].includes(operation)){
      const r=collaboration.reservation(actor,args.id);
      requireThat(r.claimId,'NOT_RUNNING','Reservation has not acquired the resource');
      if(operation==='renew')return store.renew(actor,r.claimId,args);
      const claim=store.owned(actor,r.claimId,true);
      requireThat(claim.resource!=='artifact','WRONG_DRIVER','This is not a process resource');
      if(operation.startsWith('workload-'))return request(driverUrl,secretFor(claim),driverPath(operation==='workload-launch'?'/v1/workloads/start':'/v1/workloads',claim.resource),operation==='workload-list'?undefined:{key:args.key,targets:args.targets,workload:args.workload},30000);
      return request(driverUrl,secretFor(claim),driverPath('/v1/processes',claim.resource),operation==='start'?{key:args.key}:undefined);
    }
    requireThat(false,'UNKNOWN_OPERATION','Unknown collaboration operation',400);
  }
  const html = readFileSync(new URL('./ui.html', import.meta.url));
  const server = createHttp(async (req, res, url) => {
    let responseActor;
    const handle=async()=>{
    if (url.pathname === '/' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      res.end(html); return;
    }
    if (req.method === 'GET' && ['/ui.js','/ui.css'].includes(url.pathname)) {
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
      res.end(readFileSync(new URL(`.${url.pathname}`, import.meta.url))); return;
    }
    requireThat(!unhealthy && !closed, 'UNAVAILABLE', 'Coordinator cannot acknowledge durable work', 503);
    store.assertLeader();
    if (url.pathname === '/.well-known/accord' && req.method === 'GET') return {protocol:'accord/1', authority:store.authority, ...collaboration.linkProof(url.searchParams)};
    const credential = bearer(req);
    if (url.pathname === '/v1/sessions' && req.method === 'POST') {
      const enroller = store.purpose(credential, 'enroll');
      const body = await readBody(req);
      requireThat(body.authority === store.authority, 'AUTHORITY_MISMATCH', 'Session enrollment must name this authority', 409);
      const session = store.openSession(enroller, body, sessionSecret);
      const sessionToken = sessionSecret(session.sessionId);
      const current=store.authenticate(sessionToken).session; // Explicit closure is never undone by replay.
      return {...session, expiresAt:current.persistent?null:current.expires_at,persistent:Boolean(current.persistent),credential:sessionToken};
    }
    if (url.pathname === '/v1/host' && req.method === 'GET') {
      try { responseActor=store.authenticate(credential); } catch { store.purpose(credential, 'discover'); }
      return host();
    }
    const telemetryRoute=/^\/v1\/(?:host|hosts\/([^/]+))\/(telemetry|metadata|memory)$/.exec(url.pathname);
    if(telemetryRoute&&req.method==='GET'){
      let reader;try{reader=responseActor=store.authenticate(credential);}catch{store.purpose(credential,'discover');reader={id:'telemetry-reader'};}
      const [,target,kind]=telemetryRoute;
      return target&&target!==store.authority?collaboration.forward(target,kind,{},reader):telemetry[kind]();
    }
    if(url.pathname==='/v1/federation'&&req.method==='POST'){
      const peer=collaboration.peer(credential),body=await readBody(req);
      // Observations must not provision proxy actors or write coordination state.
      if(['telemetry','metadata','memory'].includes(body.operation))return {authority:store.authority,value:await telemetry[body.operation]()};
      if(['sessions','session-read','jobs','overseer','memories','memory-read'].includes(body.operation)){
        requireThat(peer.share_sessions,'NOT_SHARED','This host does not share session activity with this link',403);
        return {authority:store.authority,value:await collaborate(null,body.operation,body.args)};
      }
      const actor=collaboration.remoteActor(peer,body.actor,body.identity);
      let value;
      if(body.operation==='directory')value={participants:collaboration.directory(body.args?.query??''),resources:[...(await host()).resources,...await managers.resources()]};
      else if(body.operation==='deliver'){
        requireThat(body.args?.from===`${peer.authority}/${body.actor}`,'FORBIDDEN','Sender does not match linked host',403);
        value=collaboration.deliver(body.args);
      }else{
        requireThat(['resources','reserve','reservation','release','renew','start','process','workload-register','workload-launch','workload-list','telemetry','metadata','sessions','session-read','jobs','job','overseer','session-snooze','memories','memory-read'].includes(body.operation),'FORBIDDEN','Operation cannot be forwarded',403);
        value=await collaborate(actor,body.operation,body.args);
      }
      store.assertLeader();return {authority:store.authority,value};
    }
    const actor = store.authenticate(credential);
    responseActor=actor;
    if(url.pathname==='/v1/awareness'&&req.method==='GET')return {authority:store.authority,adapters:observationRuntime.status(),...await sessionsAcrossHosts(actor,{query:url.searchParams.get('query')??''}),...awareness.jobs(),...overseer.incidents(),questions:actor.role==='admin'?store.db.prepare("SELECT id,actor,question,options,created_at FROM human_questions WHERE state='pending'").all():[]};
    if(url.pathname==='/v1/links'&&req.method==='POST')return collaboration.addLink(actor,await readBody(req));
    if(url.pathname==='/v1/links/share'&&req.method==='POST')return collaboration.shareSessions(actor,await readBody(req));
    if(url.pathname==='/v1/links/remove'&&req.method==='POST'){
      requireThat(actor.role==='admin','FORBIDDEN','Administrator required',403);
      const body=await readBody(req);return store.command(actor,body,'link.remove',()=>{store.db.prepare('DELETE FROM links WHERE authority=?').run(body.authority);return {removed:body.authority};});
    }
    if(url.pathname==='/v1/collaboration'&&req.method==='POST'){
      const body=await readBody(req);
      if(body.host&&body.host!==store.authority){
        requireThat(['resources','reserve','reservation','release','renew','start','process','workload-register','workload-launch','workload-list','telemetry','metadata','sessions','session-read','jobs','job','overseer','session-snooze','memories','memory-read'].includes(body.operation),'FORBIDDEN','Operation cannot be forwarded',403);
        return collaboration.forward(body.host,body.operation,body.args,actor);
      }
      if(body.operation==='sessions'&&!body.host)return sessionsAcrossHosts(actor,body.args);
      if(body.operation==='memories'&&!body.host)return memoriesAcrossHosts(actor,body.args);
      const gone=new AbortController();res.once('close',()=>gone.abort());
      return collaborate(actor,body.operation,body.args,gone.signal);
    }
    if (url.pathname === '/v1/bootstrap' && req.method === 'GET') {
      if(!store.db.prepare('SELECT actor FROM participants WHERE actor=?').get(actor.id))collaboration.announce(actor,{key:'bootstrap-registration',label:actor.session?.label??actor.id,capabilities:[],activity:'available'});
      const [local,peers,directory]=await Promise.all([host(),network(),collaboration.find('',true,collaboration.address(actor))]);
      store.authenticate(credential);
      return bootstrapView({actor,local,peers,directory,inbox:collaboration.inbox(actor),learnings:memory.learnings()});
    }
    if (url.pathname === '/v1/network' && req.method === 'GET') return {hosts:[{status:'observed',host:await host()},...await network()]};
    if(url.pathname==='/v1/plugins'&&req.method==='GET')return {plugins};
    if(url.pathname==='/v1/resources'&&req.method==='GET')return catalog();
    if(url.pathname==='/v1/workloads/adopt'&&req.method==='POST'){
      requireThat(actor.role==='admin','FORBIDDEN','Operator adoption requires administrator authority',403);
      const body=await readBody(req),claim=store.db.prepare('SELECT * FROM claims WHERE id=?').get(body.claimId);
      requireThat(claim&&['running','revoking'].includes(claim.state)&&body.generation===claim.generation&&body.authority===store.authority,'STALE_GRANT','Name the exact held claim, generation and authority');
      const result=await request(driverUrl,driverToken,driverPath('/control/workloads',claim.resource),{...grant(claim),key:body.key,targets:body.targets},30000);
      store.assertLeader();return result;
    }
    if(url.pathname==='/v1/resources'&&req.method==='POST'){
      requireThat(actor.role==='admin','FORBIDDEN','Administrator required',403);
      const body=await readBody(req);text(body.key,'key',128);
      const register=async(manifest,key,pool)=>{
        validateResource(manifest);
        const entry={key,manifest,...(pool?{pool}:{})};
        if(store.db.prepare('SELECT 1 FROM commands WHERE actor=? AND key=?').get(actor.id,key))return store.registerResource(actor,entry,{});
        return store.registerResource(actor,entry,await request(driverUrl,driverToken,'/control/resources',manifest));
      };
      const {capacity,...manifest}=body.manifest??{};
      if(capacity===undefined)return register(manifest,body.key);
      // A pool is ordinary single-holder resources, so fencing and recovery stay per slot.
      // A provider has one workload per registration and no slot identity, so one holder's
      // release would stop and restore under another. It must offer distinct resources.
      requireThat(manifest.plugin!=='managed-http','INVALID_INPUT','Managed providers cannot be pooled',400);
      integer(capacity,'capacity',2,32);
      const existing=collaboration.slots(manifest.id),names=Array.from({length:capacity},(_,i)=>`${manifest.id}-${i}`);
      requireThat(!store.db.prepare('SELECT 1 FROM resources WHERE id=?').get(manifest.id),'RESOURCE_CONFLICT','A resource already uses this name');
      requireThat(existing.length<=capacity,'RESOURCE_CONFLICT','A pool cannot shrink');
      // Refuse before the first slot, so a bad request leaves nothing half registered.
      requireThat(!names.some(name=>!existing.includes(name)&&store.db.prepare('SELECT 1 FROM resources WHERE id=?').get(name)),'RESOURCE_CONFLICT','A slot name is already in use');
      requireThat(store.db.prepare('SELECT count(*) n FROM resources').get().n+capacity-existing.length<=64,'CAPACITY_LIMIT','At most 64 registered resources');
      const slots=[];// A retry after a failure completes the missing slots.
      for(const [i,id] of names.entries())slots.push(await register({...manifest,id,asset:`${manifest.asset}#${i}`},`pool:${id}`,manifest.id));
      return {pool:manifest.id,slots};
    }
    if (url.pathname === '/v1/peers' && req.method === 'POST') {
      requireThat(actor.role === 'admin', 'FORBIDDEN', 'Administrator required', 403);
      const body = await readBody(req); text(body.authority, 'authority', 100); text(body.credential, 'credential', 200);
      body.url = loopbackUrl(body.url);
      const remote = await request(body.url, body.credential, '/v1/host');
      requireThat(remote.protocol === 'accord/1' && remote.authority === body.authority, 'PEER_IDENTITY_CHANGED', 'Pinned authority does not match');
      return store.addPeer(actor, body);
    }
    if (url.pathname === '/v1/peers/remove' && req.method === 'POST') return store.removePeer(actor, await readBody(req));
    const sessionClose = /^\/v1\/sessions\/([a-f0-9-]+)\/close$/.exec(url.pathname);
    if (sessionClose && req.method === 'POST') {
      const result = store.endSession(actor, sessionClose[1], await readBody(req)); void reconcile(); return result;
    }
    if (url.pathname === '/v1/me' && req.method === 'GET') return actor;
    if (url.pathname === '/health' && req.method === 'GET') return { status: 'ready', epoch: store.epoch };
    if (url.pathname === '/v1/board' && req.method === 'GET') {
      const after = integer(Number(url.searchParams.get('after') || 0), 'after', 0, Number.MAX_SAFE_INTEGER);
      return store.board(after);
    }
    if (url.pathname === '/v1/tasks' && req.method === 'POST') return store.submit(actor, await readBody(req));
    if (url.pathname === '/v1/claim' && req.method === 'POST') {
      const { claimId } = store.acquire(actor, await readBody(req));
      void reconcile(); return describe(actor, claimId);
    }
    if (url.pathname === '/v1/steer' && req.method === 'POST') return store.steer(actor, await readBody(req));
    const cancellation = /^\/v1\/tasks\/([a-f0-9-]+)\/cancel$/.exec(url.pathname);
    if (cancellation && req.method === 'POST') {
      const result = store.cancel(actor, cancellation[1], await readBody(req)); void reconcile(); return result;
    }
    const match = /^\/v1\/claims\/([a-f0-9-]+)(?:\/(checkpoint|finish|renew))?$/.exec(url.pathname);
    if (match && req.method === 'GET' && !match[2]) return describe(actor, match[1]);
    if (match && req.method === 'POST' && match[2] === 'checkpoint') return store.checkpoint(actor, match[1], await readBody(req));
    if (match && req.method === 'POST' && match[2] === 'renew') return store.renew(actor, match[1], await readBody(req));
    const write = /^\/v1\/claims\/([a-f0-9-]+)\/artifact$/.exec(url.pathname);
    if (write && req.method === 'POST') {
      const body = await readBody(req);
      store.authenticate(credential); const claim = store.owned(actor, write[1], true);
      requireThat(claim.resource==='artifact','WRONG_DRIVER','Use the process driver for this resource');
      return request(driverUrl, secretFor(claim), '/v1/artifacts', body);
    }
    const processRoute=/^\/v1\/claims\/([a-f0-9-]+)\/process$/.exec(url.pathname);
    if(processRoute&&['GET','POST'].includes(req.method)){
      const body=req.method==='POST'?await readBody(req):undefined;
      store.authenticate(credential);const claim=store.owned(actor,processRoute[1],true);
      requireThat(claim.resource!=='artifact','WRONG_DRIVER','Use the artifact operation for this resource');
      return request(driverUrl,secretFor(claim),driverPath('/v1/processes',claim.resource),body);
    }
    if (match && req.method === 'POST' && match[2] === 'finish') {
      const body = await readBody(req);
      // Validate ownership before accessing receipts, including on repeated requests.
      store.owned(actor, match[1]);
      const prior = store.db.prepare('SELECT * FROM commands WHERE actor=? AND key=?').get(actor.id, body.key || '');
      if (prior) return store.finish(actor, match[1], body, {}); // command dedup checks payload before invoking callback
      store.owned(actor, match[1], true);
      requireThat(typeof body.receiptId === 'string' && /^[a-f0-9-]+$/.test(body.receiptId), 'INVALID_INPUT', 'receiptId required', 400);
      const receipt = await request(driverUrl, driverToken, driverPath(`/control/receipts/${body.receiptId}`,store.claim(match[1]).resource));
      const result = store.finish(actor, match[1], body, receipt);
      void reconcile(); return result;
    }
    requireThat(false, 'NOT_FOUND', 'Unknown route', 404);
    };
    const pending=()=>{try{return collaboration.pendingCount(responseActor);}catch{return 'unknown';}};
    const deliveryProblems=()=>collaboration.deliveryProblems(responseActor);
    let result;
    try{result=await handle();}catch(error){if(responseActor?.role==='worker'){error.inboxPending=pending();error.deliveryProblems=deliveryProblems();}throw error;}
    // One indexed local count, no extra client request, no body duplication.
    // Discovery, federation and operator views never inherit another actor's mail.
    if(responseActor?.role==='worker'&&result&&typeof result==='object') {
      const inboxPending=pending();
      const problems=deliveryProblems();
      if(inboxPending||problems)return {...result,...(inboxPending?{inboxPending}:{}),...(problems?{deliveryProblems:problems}:{})};
    }
    return result;
  });
  return {
    server, store, reconcile, failed,
    async close() {
      closed = true; attention.close(); await observationRuntime.close();clearInterval(timer); clearInterval(heartbeat);clearInterval(mailTimer);clearInterval(overseerTimer);memory.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      while (busy||collaboration.sending||monitoring||managers.busy) await new Promise(resolve => setTimeout(resolve, 10));
      collaboration.close();try { store.releaseLeadership(); } finally { store.close(); }
    }
  };
}
