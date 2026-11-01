// SPDX-License-Identifier: MIT
// Tessera's board/send/inbox conventions, with Messenger's durable delivery store.
import { dirname, join } from 'node:path';
import { redact } from './session-awareness.mjs';
import { MessengerStore } from '../vendor/messenger/store.js';
import { hash, id, token, text, integer, requireThat, loopbackUrl, request } from './common.mjs';

export class Collaboration {
  constructor(store, file) {
    this.store=store; this.db=store.db;
    this.messages=new MessengerStore(join(dirname(file),'messages.sqlite'),{leaseMs:1000});
    this.sending=false;
  }
  close(){this.messages.close();}
  address(actor){return `${this.store.authority}/${actor.id}`;}
  principal(address) {
    const handle='a'+hash(address).slice(0,60);
    return this.messages.principalByHandle(handle) ?? this.messages.createPrincipal({handle,displayName:address.slice(0,120)}).principal;
  }
  announce(actor,body) {
    return this.store.command(actor,body,'announce',()=>{
      text(body.label,'label',120);text(body.activity??'available','activity',1000);
      requireThat(Array.isArray(body.capabilities??[])&&(body.capabilities??[]).length<=20,'INVALID_INPUT','Use at most 20 capabilities',400);
      for(const c of body.capabilities??[])text(c,'capability',80);
      requireThat(typeof (body.location??'')==='string'&&(body.location??'').length<=500,'INVALID_INPUT','location must be <=500 characters',400);
      this.db.prepare('INSERT INTO participants VALUES(?,?,?,?,?,?) ON CONFLICT(actor) DO UPDATE SET label=excluded.label,capabilities=excluded.capabilities,activity=excluded.activity,location=excluded.location,updated_at=excluded.updated_at')
        .run(actor.id,body.label,JSON.stringify(body.capabilities??[]),body.activity??'available',body.location??'',this.store.now());
      this.store.emit('participant.updated',{actor:actor.id});
      return {address:this.address(actor)};
    });
  }
  directory(query='') {
    requireThat(typeof query==='string'&&query.length<=200,'INVALID_INPUT','Search must be <=200 characters',400);
    const found=[];
    const rows=this.db.prepare(`SELECT p.*,s.harness,s.expires_at,s.closed_at,v.source,v.state observed_state,v.progress_at FROM participants p
      LEFT JOIN sessions s ON s.id=p.actor LEFT JOIN session_views v ON v.id=p.actor
      WHERE NOT EXISTS (SELECT 1 FROM remote_routes r WHERE r.actor=p.actor)
      AND NOT EXISTS (SELECT 1 FROM session_views v WHERE v.id=p.actor AND v.hidden=1)
      ORDER BY p.updated_at DESC`).iterate();
    for(const p of rows){
      const native=['codex','claude','tessera'].includes(p.source),lastSeen=native?p.progress_at:p.updated_at;
      const ended=p.closed_at!==null||(p.expires_at!==null&&p.expires_at<=this.store.now())||native&&['done','failed','exited','cancelled'].includes(p.observed_state);
      const value={address:`${this.store.authority}/${p.actor}`,label:p.label,capabilities:JSON.parse(p.capabilities),activity:p.activity,location:p.location,harness:p.harness??'service',lastSeen,
        presence:ended?'offline':native&&p.observed_state==='unknown'||this.store.now()-lastSeen>120000?'unknown':'recent'};
      if(JSON.stringify(value).toLowerCase().includes(query.toLowerCase()))found.push(value);
      if(found.length===200)break;
    }
    return found;
  }
  addLink(actor,body) {
    requireThat(actor.role==='admin','FORBIDDEN','Administrator required',403);
    return this.store.command(actor,body,'link',()=>{
      text(body.authority,'authority',100);text(body.outbound,'outbound',200);text(body.inbound,'inbound',200);
      requireThat(body.authority!==this.store.authority,'SELF_PEER','Cannot link to self');
      const url=loopbackUrl(body.url),old=this.db.prepare('SELECT * FROM links WHERE authority=?').get(body.authority);
      requireThat(old||this.db.prepare('SELECT count(*) n FROM links').get().n<32,'CAPACITY_LIMIT','At most 32 links');
      requireThat(!old||(old.url===url&&old.outbound===body.outbound&&old.inbound_hash===hash(body.inbound)),'LINK_CONFLICT','Remove an existing link before changing its identity or credentials');
      this.db.prepare('INSERT OR IGNORE INTO links VALUES(?,?,?,?)').run(body.authority,url,body.outbound,hash(body.inbound));
      this.store.emit('host.linked',{authority:body.authority,url});return {authority:body.authority,url};
    });
  }
  peer(credential) {
    const peer=this.db.prepare('SELECT * FROM links WHERE inbound_hash=?').get(hash(credential));
    requireThat(peer,'FORBIDDEN','Unknown host link',403);return peer;
  }
  async forward(authority,operation,args,actor) {
    const link=this.db.prepare('SELECT * FROM links WHERE authority=?').get(authority);
    requireThat(link,'HOST_UNKNOWN','Host is not linked',404);
    const descriptor=await request(link.url,'','/.well-known/accord',undefined,700);
    requireThat(descriptor.authority===authority,'PEER_IDENTITY_CHANGED','Linked host identity changed');
    const result=await request(link.url,link.outbound,'/v1/federation',{operation,args,actor:actor.id,identity:this.db.prepare('SELECT label FROM participants WHERE actor=?').get(actor.id)??this.db.prepare('SELECT label FROM sessions WHERE id=?').get(actor.id)},operation.startsWith('workload-')?30000:['telemetry','metadata'].includes(operation)?3500:undefined);
    requireThat(result.authority===authority,'PEER_IDENTITY_CHANGED','Linked host identity changed');
    if(operation==='resources'&&Array.isArray(result.value?.resources))return {...result.value,resources:result.value.resources.map(r=>({...r,holder:this.localHolder(r.holder)}))};
    return result.value;
  }
  localHolder(holder) {
    if(!holder?.actor?.startsWith('remote-'))return holder;
    // Reverse only our own authenticated origin's deterministic proxy identity.
    // Works with older peers too; directory text alone never establishes ownership.
    for(const row of this.db.prepare('SELECT p.actor,p.label FROM participants p WHERE NOT EXISTS (SELECT 1 FROM remote_routes r WHERE r.actor=p.actor)').iterate()) {
      if(holder.actor===`remote-${hash(this.store.authority+'/'+row.actor)}`)
        return {...holder,originActor:row.actor,address:`${this.store.authority}/${row.actor}`,label:row.label};
    }
    return holder;
  }
  remoteActor(peer,actorId,identity) {
    requireThat(typeof actorId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(actorId),'INVALID_INPUT','Invalid remote session',400);
    const actor={id:`remote-${hash(peer.authority+'/'+actorId)}`,role:'worker'};
    if(identity!==undefined){requireThat(identity&&typeof identity==='object','INVALID_INPUT','Invalid remote identity',400);text(identity.label,'remote label',120);}
    this.store.mutate(()=>{
      if(!this.db.prepare('SELECT id FROM actors WHERE id=?').get(actor.id))this.store.provision(actor.id,token(),'worker');
      this.db.prepare('INSERT OR IGNORE INTO remote_routes VALUES(?,?,?)').run(actor.id,peer.authority,actorId);
      // The authenticated origin supplies display metadata; it grants no authority.
      if(identity)this.db.prepare("INSERT INTO participants VALUES(?,?,'[]','','',?) ON CONFLICT(actor) DO UPDATE SET label=excluded.label").run(actor.id,redact(identity.label),this.store.now());
    });
    return actor;
  }
  async find(query='',network=true) {
    const hosts=[{authority:this.store.authority,status:'observed',participants:this.directory(query)}];
    if(network)hosts.push(...await Promise.all(this.db.prepare('SELECT authority FROM links').all().map(async p=>{
      try{return {authority:p.authority,status:'observed',...await this.forward(p.authority,'directory',{query},{id:'directory'})};}
      catch(e){return {authority:p.authority,status:'unknown',reason:e.code??'HOST_UNAVAILABLE',participants:[]};}
    })));
    return {hosts,participants:hosts.flatMap(h=>h.participants)};
  }
  send(actor,body) {
    return this.store.command(actor,body,'send',()=>{
      text(body.to,'to',220);text(body.text,'text',4000);
      requireThat(body.to.split('/').length===2,'INVALID_INPUT','Use the recipient address from find',400);
      requireThat(body.to!==this.address(actor),'SELF_MESSAGE','Send to another participant; self-messages are not supported',400);
      const authority=body.to.split('/')[0];
      requireThat(authority===this.store.authority||this.db.prepare('SELECT 1 FROM links WHERE authority=?').get(authority),'HOST_UNKNOWN','Recipient host is not linked',404);
      requireThat(this.db.prepare("SELECT count(*) n FROM message_outbox WHERE state='queued'").get().n<100000,'CAPACITY_LIMIT','Pending message limit reached');
      requireThat(body.delivery===undefined||['inbox','native-prompt'].includes(body.delivery),'INVALID_INPUT','Unknown delivery preference',400);
      const messageId=id(),envelope={id:messageId,from:this.address(actor),to:body.to,text:body.text,kind:body.kind==='notification'?'notification':'message',delivery:body.delivery??'inbox'};
      this.db.prepare("INSERT INTO message_outbox(id,actor,envelope,state,error,created_at) VALUES(?,?,?,'queued',NULL,?)").run(messageId,actor.id,JSON.stringify(envelope),this.store.now());
      this.store.emit('message.queued',{id:messageId,from:envelope.from,to:envelope.to});return {id:messageId,state:'queued'};
    });
  }
  deliver(envelope) {
    text(envelope.id,'id',128);text(envelope.from,'from',220);text(envelope.text,'text',4000);
    const [authority,recipient]=String(envelope.to).split('/');
    requireThat(authority===this.store.authority&&this.db.prepare('SELECT 1 FROM participants WHERE actor=?').get(recipient),'RECIPIENT_UNKNOWN','Recipient is not registered',404);
    const from=this.principal(envelope.from),to=this.principal(envelope.to);
    const conversation=this.messages.createConversation(from,{members:[to.handle]});
    this.messages.sendMessage(from,{conversationId:conversation.id,clientMessageId:envelope.id,body:envelope.text,data:{id:envelope.id,from:envelope.from,to:envelope.to,kind:envelope.kind,delivery:envelope.delivery==='native-prompt'?'native-prompt':'inbox'}});
    return {id:envelope.id,state:'delivered'};
  }
  async flush() {
    if(this.sending)return;this.sending=true;
    try{
      // Bounded batches, with independent destinations so one offline host cannot starve another.
      const pending=this.db.prepare("SELECT * FROM message_outbox WHERE state='queued' ORDER BY last_attempt,created_at LIMIT 32").all();
      await Promise.all(pending.map(async row=>{
        const envelope=JSON.parse(row.envelope);
        try{
          this.store.mutate(()=>this.db.prepare('UPDATE message_outbox SET last_attempt=? WHERE id=?').run(this.store.now(),row.id));
          const authority=envelope.to.split('/')[0];
          if(authority===this.store.authority)this.deliver(envelope);
          else await this.forward(authority,'deliver',envelope,{id:row.actor});
          this.store.mutate(()=>{this.db.prepare("UPDATE message_outbox SET state='delivered',error=NULL WHERE id=?").run(row.id);this.store.emit('message.delivered',{id:row.id});});
        }catch(e){this.store.mutate(()=>this.db.prepare('UPDATE message_outbox SET error=? WHERE id=?').run(e.code??'HOST_UNAVAILABLE',row.id));}
      }));
    }finally{this.sending=false;}
  }
  inboxActors(actor){return [...new Set([actor.id,
    ...this.db.prepare('SELECT v.id FROM session_bindings b JOIN session_views v ON v.source=b.source AND v.external_id=b.external_id WHERE b.actor=? AND v.private=0').all(actor.id).map(r=>r.id),
    ...this.db.prepare(`SELECT a.actor id FROM session_bindings b JOIN session_mailbox_aliases a USING(source,external_id)
      LEFT JOIN session_views v ON v.id=a.actor LEFT JOIN source_privacy p ON p.source=a.source
      WHERE b.actor=? AND COALESCE(v.private,0)=0 AND COALESCE(p.private,0)=0`).all(actor.id).map(r=>r.id)
  ])];}
  pendingCount(actor) {
    // Count canonical Messenger deliveries without fetching bodies or claiming them.
    const at=new Date().toISOString();let count=0;
    for(const a of this.inboxActors(actor)) {
      const principal=this.messages.principalByHandle('a'+hash(this.address({id:a})).slice(0,60));if(!principal)continue;
      count+=this.messages.db.prepare(`SELECT count(*) n FROM deliveries WHERE recipient_id=?
        AND (available_at IS NULL OR available_at<=?) AND (state='pending' OR (state IN ('offered','read') AND lease_expires_at<=?))`).get(principal.id,at,at).n;
    }
    return count;
  }
  // Read state lives in Messenger. UI adapters must not acknowledge on receipt or cache it
  // as another mailbox. History is a bounded view of the same canonical deliveries.
  inbox(actor,{all=false}={}) {
    const messages=this.inboxActors(actor).flatMap(id=>{
      const principal=this.principal(this.address({id}));
      if(!all)return this.messages.peekInbox(principal,{limit:100}).map(d=>({id:d.message.data.id,deliveryId:d.id,...d.message.data,text:d.message.body,at:d.message.createdAt,read:false}));
      return this.messages.listConversations(principal,{limit:100}).flatMap(c=>
        this.messages.listMessages(principal,c.id,{after:Math.max(0,c.latestSeq-100),limit:100})
          .filter(m=>m.delivery).map(m=>({...m.data,deliveryId:m.delivery.id,text:m.body,at:m.createdAt,read:m.delivery.state==='acknowledged'})));
    });
    const ordered=messages.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.id.localeCompare(b.id));
    return {messages:all?ordered.slice(-100):ordered.slice(0,100)};
  }
  notify(actor,body) {
    // Operator notifications use the existing Messenger inbox, not another notice store.
    const operator={id:'admin',role:'admin'};
    if(!this.db.prepare('SELECT 1 FROM participants WHERE actor=?').get(operator.id))
      this.announce(operator,{key:'operator-inbox',label:'Operator',activity:'Human attention inbox',capabilities:[]});
    return this.send(actor,{key:body.key,to:this.address(operator),text:body.text,kind:'notification'});
  }
  read(actor,body) {
    text(body.deliveryId,'deliveryId',100);
    let principal,row;
    for(const id of this.inboxActors(actor)){
      const p=this.principal(this.address({id}));try{row=this.messages.ownedDelivery(p.id,body.deliveryId);principal=p;break;}catch{}
    }
    requireThat(row,'NOT_OWNER','Delivery does not belong to this session',403);
    if(row.state==='acknowledged')return {read:true};
    const delivery=this.messages.claimInbox(principal,{deliveryId:body.deliveryId})[0];
    requireThat(delivery,'RETRY','Read confirmation is recovering; retry shortly');
    this.messages.acknowledge(principal,delivery.id,{leaseToken:delivery.leaseToken});return {read:true};
  }
  sent(actor,id) {
    const row=this.db.prepare('SELECT id,state,error FROM message_outbox WHERE id=? AND actor=?').get(id,actor.id);
    requireThat(row,'NOT_FOUND','Unknown outgoing message',404);return row;
  }
  reserve(actor,body) {
    return this.store.command(actor,body,'reserve',()=>{
      text(body.resource,'resource',100);text(body.purpose??'reserved','purpose',200);
      integer(body.leaseMs??300000,'leaseMs',500,300000);integer(body.waitMs??3600000,'waitMs',1000,86400000);
      requireThat(this.db.prepare('SELECT id FROM resources WHERE id=?').get(body.resource),'RESOURCE_UNKNOWN','Unknown resource',404);
      requireThat(this.db.prepare("SELECT count(*) n FROM tasks WHERE kind='reservation' AND state IN ('queued','preparing','running','recovering','releasing','cancelling')").get().n<5000,'CAPACITY_LIMIT','Active reservation limit reached');
      const reservationId=id(),taskId=id(),now=this.store.now();
      this.db.prepare("INSERT INTO tasks(id,title,input,expected_hash,resource,state,created_at,max_attempts,kind) VALUES(?,?,?,'',?,'queued',?,1,'reservation')")
        .run(taskId,body.purpose??'reserved','',body.resource,now);
      this.db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?)').run(reservationId,actor.id,taskId,body.leaseMs??300000,now+(body.waitMs??3600000));
      this.store.emit('reservation.queued',{id:reservationId,actor:actor.id,resource:body.resource});return {id:reservationId};
    });
  }
  reservation(actor,reservationId) {
    const row=this.db.prepare('SELECT r.*,t.resource,t.state task_state FROM reservations r JOIN tasks t ON t.id=r.task_id WHERE r.id=?').get(reservationId);
    requireThat(row,'NOT_FOUND','Unknown reservation',404);requireThat(row.actor===actor.id,'NOT_OWNER','Reservation belongs to another session',403);
    const claim=this.db.prepare('SELECT * FROM claims WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(row.task_id);
    return {id:row.id,resource:row.resource,state:claim?.state==='closed'?claim.outcome:claim?.state??row.task_state,
      authority:this.store.authority,generation:claim?.generation??null,workloadUnitPrefix:claim?'accord-'+hash(this.store.authority+'/'+claim.id+'/'+claim.generation).slice(0,20)+'-':null,claimId:claim?.id??null,deadline:claim?.deadline??null,queuedUntil:row.queued_until,error:claim?.error??null};
  }
  release(actor,reservationId,body) {
    return this.store.command(actor,body,`release:${reservationId}`,()=>{
      const r=this.reservation(actor,reservationId),row=this.db.prepare('SELECT task_id FROM reservations WHERE id=?').get(reservationId);
      if(r.claimId){
        const claim=this.store.claim(r.claimId);
        if(['preparing','running'].includes(claim.state)){
          this.db.prepare("UPDATE claims SET state='releasing',outcome='released' WHERE id=?").run(claim.id);
          this.db.prepare("UPDATE tasks SET state='releasing' WHERE id=?").run(row.task_id);
        }
      }else this.db.prepare("UPDATE tasks SET state='cancelled' WHERE id=?").run(row.task_id);
      this.store.emit('reservation.release_requested',{id:reservationId});return this.reservation(actor,reservationId);
    });
  }
  schedule() {
    const waiting=this.db.prepare("SELECT r.*,t.resource FROM reservations r JOIN tasks t ON t.id=r.task_id WHERE t.state='queued' ORDER BY t.created_at,t.rowid").all();
    const seen=new Set();
    for(const row of waiting){
      const session=this.db.prepare('SELECT * FROM sessions WHERE id=?').get(row.actor);
      if(row.queued_until<=this.store.now()||session&&(session.closed_at!==null||session.expires_at<=this.store.now())){
        this.store.mutate(()=>this.db.prepare("UPDATE tasks SET state='cancelled' WHERE id=?").run(row.task_id));continue;
      }
      if(seen.has(row.resource))continue;seen.add(row.resource);
      try{this.store.acquire({id:row.actor,role:'worker'},{key:`reservation:${row.id}`,taskId:row.task_id,leaseMs:row.lease_ms});}
      catch(e){if(!['RESOURCE_BUSY','PAUSED'].includes(e.code))throw e;}
    }
  }
}
