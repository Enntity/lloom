// SPDX-License-Identifier: MIT
// A provider performs domain effects; Accord alone grants and revokes ownership.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ArtifactDriver } from './driver.mjs';
import { workloadJournalMigration } from './workload-schema.mjs';
import { transaction, requireThat, text, integer, loopbackUrl, request, equal, hash } from './common.mjs';
export const managedPlugin = {id:'managed-http',enforcement:'provider-confirmed prepare, workload stop, and restoration; unavailable provider remains held'};
const migration = `ALTER TABLE state ADD COLUMN phase TEXT NOT NULL DEFAULT 'idle';`;
export function managedManifest(v) {
  requireThat(v?.schema===1 && /^[a-z][a-z0-9-]{0,63}$/.test(v.id) && v.id!=='artifact','RESOURCE_MANIFEST','Invalid managed resource ID',400);
  text(v.asset,'asset',200); const url=new URL(v.endpoint); loopbackUrl(url.origin);
  requireThat(!url.username&&!url.password&&!url.search&&!url.hash,'RESOURCE_MANIFEST','Invalid provider endpoint',400);
  const endpoint=url.origin+url.pathname.replace(/\/+$/,'');
  requireThat(isAbsolute(v.tokenFile??''),'RESOURCE_MANIFEST','Use an absolute provider credential file',400);
  // The provider owns its hold policy; Accord applies it when a reservation renews.
  if(v.maxOwnershipMs!==undefined)integer(v.maxOwnershipMs,'maxOwnershipMs',60000,2592000000);
  requireThat(v.allowIndefinite===undefined||typeof v.allowIndefinite==='boolean','RESOURCE_MANIFEST','allowIndefinite must be boolean',400);
  return {schema:1,id:v.id,asset:v.asset,plugin:managedPlugin.id,endpoint,tokenFile:v.tokenFile,label:String(v.label??v.id).slice(0,120),hosts:(v.hosts??[]).slice(0,32).map(String),
    ...(v.maxOwnershipMs!==undefined?{maxOwnershipMs:v.maxOwnershipMs}:{}),...(v.allowIndefinite?{allowIndefinite:true}:{})};
}
export class ManagedDriver extends ArtifactDriver {
  constructor(file,manifest) {
    super(file,{recover:false,migrations:[migration,workloadJournalMigration]}); this.manifest=managedManifest(manifest); this.tail=Promise.resolve(); this.flights=new Map();
    // Only a grant the provider had confirmed may resume; an interrupted one is revoked.
    const old=this.status();
    if(old.claim_id)transaction(this.db,()=>{this.db.prepare("UPDATE state SET phase=CASE WHEN phase IN ('active','recovering') THEN 'recovering' ELSE 'interrupted' END,token_hash=NULL").run();this.audit('restart.recovering',old.generation,old.claim_id);});
  }
  status(){return {...super.status(),...this.db.prepare('SELECT phase FROM state').get()};}
  serial(key,fn){if(this.flights.has(key))return this.flights.get(key);const p=this.tail.then(fn);this.tail=p.catch(()=>{});this.flights.set(key,p);p.finally(()=>this.flights.delete(key)).catch(()=>{});return p;}
  async call(action,body){
    const result=await request(this.manifest.endpoint,readFileSync(this.manifest.tokenFile,'utf8').trim(),`/${action}`,body,30000);
    requireThat(result?.claimId===body.claimId && result.generation===body.generation && result.authority===body.authority && result[action]===true,'PROVIDER_UNCONFIRMED','Provider did not confirm this generation',503);
    return result;
  }
  async availability(){
    try{const p=await request(this.manifest.endpoint,readFileSync(this.manifest.tokenFile,'utf8').trim(),'/availability',{},500);
      return {label:this.manifest.label,hosts:this.manifest.hosts,blocked:p.available!==true};
    // Only the provider's own answer withdraws a resource; silence or any other error keeps it.
    }catch(e){return {label:this.manifest.label,hosts:this.manifest.hosts,blocked:true,...(e.status===404&&e.code==='resource_unknown'?{withdrawn:true}:{})};}
  }
  activate(body){return this.serial(`activate:${hash(JSON.stringify(body))}`,async()=>{
    transaction(this.db,()=>{
      const old=this.validate(body);text(body.credentialHash,'credentialHash',64);
      if(body.generation===old.generation&&old.claim_id===body.claimId&&old.phase==='recovering'){
        // The coordinator resumes the claim this driver still holds; the provider reconfirms it below.
        this.db.prepare("UPDATE state SET epoch=?,token_hash=?,phase='preparing'").run(body.epoch,body.credentialHash);
        this.audit('grant.resuming',body.generation,body.claimId);
      }else if(body.generation===old.generation){
        const secret=this.db.prepare('SELECT token_hash FROM state').get().token_hash;
        requireThat(old.claim_id===body.claimId && ['preparing','active'].includes(old.phase) && equal(secret,body.credentialHash),'REVOKED','Generation cannot reactivate');
      }else{
        requireThat(!old.claim_id,'DRIVER_BUSY','Previous workload and restoration remain unconfirmed');
        this.db.prepare("UPDATE state SET authority=?,epoch=?,generation=?,claim_id=?,token_hash=?,phase='preparing'").run(body.authority,body.epoch,body.generation,body.claimId,body.credentialHash);
      }
    });
    if(this.status().phase!=='active'){
      await this.call('prepare',body);
      this.db.prepare("UPDATE state SET phase='active'").run();this.audit('grant.active',body.generation,body.claimId);
    }
    return {active:true,instance:body.instance,claimId:body.claimId,generation:body.generation};
  });}
  revoke(body){return this.serial(`revoke:${hash(JSON.stringify(body))}`,async()=>{
    transaction(this.db,()=>{
      const old=this.validate(body);
      requireThat(!old.claim_id||old.claim_id===body.claimId,'OWNER_MISMATCH','Cannot revoke another owner');
      if(!old.claim_id && old.generation===body.generation && old.phase==='idle')return;
      this.db.prepare("UPDATE state SET authority=?,epoch=?,generation=?,claim_id=?,token_hash=NULL,phase='stopping'").run(body.authority,body.epoch,body.generation,body.claimId);
    });
    if(this.status().phase!=='idle'){
      await this.call('stop',body);this.audit('workload.stopped',body.generation,body.claimId);
      await this.call('restore',body);this.audit('provider.restored',body.generation,body.claimId);
    }
    const receipt=super.revoke(body);this.db.prepare("UPDATE state SET phase='idle'").run();return receipt;
  });}
  start(credential,body){return this.serial(`start:${hash(credential)}:${body.key}`,async()=>{
    const s=this.db.prepare('SELECT * FROM state').get();
    requireThat(s.phase==='active'&&s.claim_id&&equal(hash(credential),s.token_hash),'STALE_GRANT','Workload requires an active grant');text(body.key,'key',128);
    return this.call('start',{key:body.key,authority:s.authority,epoch:s.epoch,generation:s.generation,claimId:s.claim_id});
  });}
  inspect(credential){const s=this.db.prepare('SELECT * FROM state').get();requireThat(s.phase==='active'&&equal(hash(credential),s.token_hash),'STALE_GRANT','Workload requires an active grant');return this.call('inspect',{authority:s.authority,generation:s.generation,claimId:s.claim_id});}
}
