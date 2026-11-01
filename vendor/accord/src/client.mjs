// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
import { request, requireThat, loopbackUrl } from './common.mjs';

export class AccordClient {
  constructor(url, credential) { this.url = loopbackUrl(url); this.credential = credential; }
  static async enroll(url, enrollment, {label, harness = 'cli', ttlMs, key = randomUUID(), authority} = {}) {
    requireThat(authority, 'AUTHORITY_REQUIRED', 'Pin the expected host authority before enrollment');
    const descriptor = await request(url, '', '/.well-known/accord');
    requireThat(descriptor.authority === authority, 'AUTHORITY_MISMATCH', 'Host identity changed; enrollment refused');
    const result = await request(url, enrollment, '/v1/sessions', {key, label, harness, authority, ...(ttlMs!==undefined ? {ttlMs} : {})});
    requireThat(result.authority === authority, 'AUTHORITY_MISMATCH', 'Enrollment returned a different authority');
    const client = new AccordClient(url, result.credential); client.session = result; return client;
  }
  registerResource(manifest,key=randomUUID()){return request(this.url,this.credential,'/v1/resources',{key,manifest});}
  resources(){return request(this.url,this.credential,'/v1/resources');}
  startProcess(claimId,key){return request(this.url,this.credential,`/v1/claims/${claimId}/process`,{key});}
  processStatus(claimId){return request(this.url,this.credential,`/v1/claims/${claimId}/process`);}
  bootstrap() { return request(this.url, this.credential, '/v1/bootstrap',undefined,6000); }
  telemetry(host) { return request(this.url,this.credential,host?`/v1/hosts/${encodeURIComponent(host)}/telemetry`:'/v1/host/telemetry',undefined,5000); }
  metadata(host) { return request(this.url,this.credential,host?`/v1/hosts/${encodeURIComponent(host)}/metadata`:'/v1/host/metadata',undefined,5000); }
  host() { return request(this.url, this.credential, '/v1/host'); }
  network() { return request(this.url, this.credential, '/v1/network'); }
  closeSession() { return request(this.url, this.credential, `/v1/sessions/${this.session.sessionId}/close`, {key:randomUUID()}); }
  async waitClaim({waitMs = 20000, onWait = () => {}, ...options} = {}) {
    requireThat(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 30000, 'INVALID_INPUT', 'waitMs must be 0..30000');
    const until = performance.now() + waitMs;
    for (;;) {
      try { return await this.claim(options); }
      catch (error) {
        if (!['NO_WORK','TASK_BUSY','RESOURCE_BUSY','PAUSED','DEPENDENCY'].includes(error.code)) throw error;
        await onWait(error.code);
        if (performance.now() >= until) throw Object.assign(Error('No grant acquired before wait deadline'), {code:'WAIT_TIMEOUT'});
        await new Promise(resolve => setTimeout(resolve, Math.min(100, until - performance.now())));
      }
    }
  }
  me() { return request(this.url, this.credential, '/v1/me'); }
  collaborate(operation,args={},host) { return request(this.url,this.credential,'/v1/collaboration',{operation,args,...(host?{host}:{})},4000); }
  announce({key=randomUUID(),...args}) {return this.collaborate('announce',{...args,key});}
  find(query=''){return this.collaborate('find',{query});}
  send(to,text,{key=randomUUID(),kind='message',delivery='inbox'}={}){return this.collaborate('send',{to,text,key,kind,delivery});}
  inbox(){return this.collaborate('inbox');}
  read(deliveryId){return this.collaborate('read',{deliveryId});}
  sent(id){return this.collaborate('sent',{id});}
  reserve(resource,{host,key=randomUUID(),purpose='reserved',leaseMs=300000,waitMs=3600000}={}){
    if(resource.includes('/'))[host,resource]=resource.split('/');
    return this.collaborate('reserve',{resource,key,purpose,leaseMs,waitMs},host);
  }
  reservation(id,host){return this.collaborate('reservation',{id},host);}
  release(id,{host,key=randomUUID()}={}){return this.collaborate('release',{id,key},host);}
  async waitInbox(waitMs=20000){
    requireThat(Number.isInteger(waitMs)&&waitMs>=0&&waitMs<=20000,'INVALID_INPUT','waitMs must be 0..20000');
    const until=performance.now()+waitMs;
    do{const inbox=await this.inbox();if(inbox.messages.length||performance.now()>=until)return inbox;
      await new Promise(r=>setTimeout(r,250));}while(true);
  }
  board(after = 0) { return request(this.url, this.credential, `/v1/board?after=${after}`); }
  submit(input, key = randomUUID()) { return request(this.url, this.credential, '/v1/tasks', { ...input, key }); }
  claim({ taskId, resource, leaseMs = 10000, key = randomUUID() } = {}) {
    return request(this.url, this.credential, '/v1/claim', { ...(taskId ? { taskId } : {}), ...(resource?{resource}:{}), leaseMs, key });
  }
  inspect(claimId) { return request(this.url, this.credential, `/v1/claims/${claimId}`); }
  checkpoint(claimId, note, key = randomUUID()) { return request(this.url, this.credential, `/v1/claims/${claimId}/checkpoint`, { note, key }); }
  renew(claimId, leaseMs = 10000, key = randomUUID()) { return request(this.url, this.credential, `/v1/claims/${claimId}/renew`, { leaseMs, key }); }
  cancel(taskId, key = randomUUID()) { return request(this.url, this.credential, `/v1/tasks/${taskId}/cancel`, { key }); }
  finish(claimId, receiptId, key = randomUUID()) { return request(this.url, this.credential, `/v1/claims/${claimId}/finish`, { receiptId, key }); }
  writeViaHost(claim, content, key = randomUUID()) { return request(this.url, this.credential, `/v1/claims/${claim.id}/artifact`, { content, key }); }
  write(claim, content, key = randomUUID()) { return request(claim.driverUrl, claim.resourceToken, '/v1/artifacts', {content, key}); }
  pause(paused, key = randomUUID()) { return request(this.url, this.credential, '/v1/steer', { paused, key }); }
}

// The callback must honor signal, or use a registered workload. A returned promise
// means release was confirmed, not merely that a release request was accepted.
export async function withReservation(client, resource, work, {
  leaseMs=300000, waitMs=3600000, releaseWaitMs=30000, purpose='working', host, signal
}={}) {
  signal?.throwIfAborted();
  const requestKey=randomUUID();
  let reservation, acquireError;
  for(let attempt=0;attempt<3;attempt++) {
    try { reservation=await client.reserve(resource,{key:requestKey,host,leaseMs,waitMs,purpose});break; }
    catch(error) { acquireError=error; }
  }
  if(!reservation) throw Object.assign(Error('Reservation outcome unknown; retry this request key before starting work'),{cause:acquireError,requestKey,resource});
  if(resource.includes('/')) host=resource.split('/')[0];
  const controller=new AbortController(), abort=()=>controller.abort(signal?.reason??Error('Cancelled'));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const sleep=()=>new Promise(resolve=>setTimeout(resolve,100));
  let timer, renewal=null, lost;
  const terminal=new Set(['failed','released','cancelled','succeeded']);
  try {
    const until=Date.now()+waitMs;
    for(;;) {
      controller.signal.throwIfAborted();
      const state=await client.reservation(reservation.id,host);
      if(state.state==='running') break;
      if(terminal.has(state.state)) throw Error(`Reservation ended: ${state.state}`);
      if(Date.now()>=until) throw Error('Reservation wait timed out');
      await sleep();
    }
    timer=setInterval(()=>{
      if(renewal)return;
      renewal=client.collaborate('renew',{id:reservation.id,key:randomUUID(),leaseMs},host)
        .catch(error=>{lost=error;controller.abort(error);}).finally(()=>{renewal=null;});
    },Math.max(100,Math.floor(leaseMs/3)));
    const result=await work({reservationId:reservation.id,host,signal:controller.signal});
    if(lost)throw lost;controller.signal.throwIfAborted();return result;
  } finally {
    clearInterval(timer);await renewal;signal?.removeEventListener('abort',abort);
    const releaseKey=randomUUID(),until=Date.now()+releaseWaitMs;
    let confirmed=false,lastError;
    do {
      try {
        await client.release(reservation.id,{host,key:releaseKey});
        const state=await client.reservation(reservation.id,host);
        if(terminal.has(state.state)){confirmed=true;break;}
      } catch(error){lastError=error;}
      await sleep();
    } while(Date.now()<until);
    if(!confirmed)throw Object.assign(Error('Resource release is unconfirmed; recovery still owns the resource'),{cause:lastError,reservationId:reservation.id,host});
  }
}
