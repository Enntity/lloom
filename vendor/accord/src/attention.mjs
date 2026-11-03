// SPDX-License-Identifier: MIT
// What one native conversation has been shown, and when it may be woken. All of this
// is a hint: losing it can repeat a message, never acknowledge or delete one.
import { mkdirSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './session-awareness.mjs';
import { integer,requireThat,text } from './common.mjs';

const safeId=/^[a-zA-Z0-9._:-]{1,200}$/,hour=3600000,keep=(map,limit)=>{while(map.size>limit)map.delete(map.keys().next().value);};
export class Attention {
  constructor(store,collaboration,directory,{perHour=6,settleMs=1000}={}){
    Object.assign(this,{store,db:store.db,collaboration,directory,settleMs,since:store.now(),perHour:Number.isInteger(perHour)&&perHour>=0?perHour:6});
    this.shown=new Map();this.wakes=new Map();this.owners=new Map();this.waiters=new Map();this.held=new Map();
    mkdirSync(directory,{recursive:true,mode:0o700});
    collaboration.onDeliver=recipient=>this.arrived(recipient);
  }
  key({source,externalId}){
    requireThat(['codex','claude'].includes(source),'INVALID_INPUT','Unsupported hook source',400);text(externalId,'externalId',200);
    return `${source}-${externalId}`;
  }
  owner({source,externalId}){const b=this.db.prepare('SELECT actor FROM session_bindings WHERE source=? AND external_id=?').get(source,externalId);return b?{id:b.actor}:null;}
  memory(key){const m=this.shown.get(key)??new Map();this.shown.delete(key);this.shown.set(key,m);keep(this.shown,2000);return m;}
  mark(key,ids){const m=this.memory(key);for(const id of ids)m.set(id,true);keep(m,500);}
  unseen(key,owner){const m=this.memory(key);return this.collaboration.newest(owner).filter(x=>!m.has(x.deliveryId));}
  // Names reach a file path, so anything unusual gets no flag and takes the Node path.
  flag(key){return safeId.test(key)?join(this.directory,key):null;}
  clear(key){const file=this.flag(key);if(file)rmSync(file,{force:true});}
  arrived(recipient){
    for(const c of this.db.prepare(`SELECT source,external_id FROM session_bindings WHERE actor=? UNION SELECT source,external_id FROM session_mailbox_aliases WHERE actor=?
      UNION SELECT source,external_id FROM session_views WHERE id=? AND external_id IS NOT NULL`).all(recipient,recipient,recipient)){
      if(!['codex','claude'].includes(c.source))continue;
      const file=this.flag(`${c.source}-${c.external_id}`);if(file)writeFileSync(file,'',{mode:0o600});
    }
    this.poll();
  }
  poll(){for(const check of [...this.waiters.keys()])check();}
  present(args){
    const key=this.key(args),seen=args.seen??[];
    requireThat(Array.isArray(seen)&&seen.length<=100&&seen.every(s=>typeof s==='string'),'INVALID_INPUT','seen must list delivery IDs',400);
    if(args.reset)this.shown.delete(key);
    const owner=this.owner(args);if(!owner){this.clear(key);return {messages:[],presented:true};}
    this.mark(key,seen);if(args.turn)this.resume(args);
    const fresh=this.unseen(key,owner),selected=fresh.slice(0,3);this.mark(key,selected.map(m=>m.deliveryId));
    if(fresh.length<=3)this.clear(key);
    return {presented:true,messages:selected.map(m=>({from:m.from,deliveryId:m.deliveryId,text:redact(m.text).slice(0,700),...(m.text.length>700?{truncated:true}:{})}))};
  }
  wait(check,waitMs,signal,tag){
    requireThat(this.waiters.size<1024&&(this.held.get(tag)??0)<8,'CAPACITY_LIMIT','Too many waiting requests');
    this.held.set(tag,(this.held.get(tag)??0)+1);
    return new Promise(resolve=>{
      let timer;
      const finish=value=>{clearTimeout(timer);this.waiters.delete(poll);signal?.removeEventListener('abort',stop);
        const left=this.held.get(tag)-1;if(left)this.held.set(tag,left);else this.held.delete(tag);resolve(value);};
      const stop=()=>finish(null),poll=()=>{const value=check();if(value)finish(value);};
      timer=setTimeout(stop,waitMs);signal?.addEventListener('abort',stop);this.waiters.set(poll,stop);poll();
    });
  }
  // Older mail waits for the next boundary, so a restart cannot wake every idle session.
  wakeable(key,owner){return this.unseen(key,owner).some(m=>m.kind!=='notification'&&Date.parse(m.at)>=this.since);}
  // Waiting is one wait, not a mode: without this every later Codex turn would be held.
  resume(args){
    const owner=this.owner(args);if(args.source!=='codex'||!owner)return;
    this.store.mutate(()=>this.db.prepare("UPDATE session_views SET state='working' WHERE id=? AND state='waiting'").run(owner.id));
  }
  spent(key){const now=this.store.now(),times=(this.wakes.get(key)??[]).filter(t=>now-t<hour);this.wakes.delete(key);this.wakes.set(key,times);keep(this.wakes,2000);return times;}
  // A wake spends the recipient's tokens, so only a direct message earns one. The budget
  // holds a reply loop to a few turns an hour; held mail stays pending. It carries no text.
  async wake(args,signal){
    const key=this.key(args),{waiter,waitMs=55000,onlyWaiting=false}=args;text(waiter,'waiter',64);integer(waitMs,'waitMs',0,60000);
    this.owners.set(key,waiter);keep(this.owners,2000);this.poll();
    if(onlyWaiting){const owner=this.owner(args),view=owner&&this.db.prepare('SELECT state FROM session_views WHERE id=?').get(owner.id);if(view?.state!=='waiting')return {wake:false,idle:true};}
    const current=()=>this.owners.get(key)===waiter;
    const ready=()=>{
      if(!current())return {superseded:true};
      const owner=this.owner(args);if(!owner||this.spent(key).length>=this.perHour)return null;
      return this.wakeable(key,owner)?{ready:true}:null;
    };
    const result=await this.wait(ready,waitMs,signal,key);
    if(!result)return {wake:false};
    if(result.superseded)return {wake:false,superseded:true};
    await new Promise(r=>setTimeout(r,this.settleMs));// One turn for a burst of mail.
    if(signal?.aborted||!current())return {wake:false,superseded:true};
    const owner=this.owner(args);
    if(!this.wakeable(key,owner))return {wake:false};// A boundary showed it during the settle.
    this.mark(key,this.unseen(key,owner).map(m=>m.deliveryId));this.clear(key);
    this.spent(key).push(this.store.now());if(onlyWaiting)this.resume(args);
    return {wake:true};
  }
  close(){for(const stop of [...this.waiters.values()])stop();}
}
