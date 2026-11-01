// SPDX-License-Identifier: MIT
// Durable, provider-independent attachments to a resource generation.
import { database, transaction, requireThat, text, hash, equal, id } from './common.mjs';
import { workloadPolicy, workloadTransport, workloadCapabilities } from './workload-transport.mjs';
const schema=`
CREATE TABLE identity(id TEXT PRIMARY KEY);
CREATE TABLE fences(claim TEXT PRIMARY KEY, authority TEXT NOT NULL, generation INTEGER NOT NULL, phase TEXT NOT NULL);
CREATE TABLE batches(claim TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(claim,key));
CREATE TABLE bindings(id TEXT PRIMARY KEY,claim TEXT NOT NULL,generation INTEGER NOT NULL,target TEXT NOT NULL,connector TEXT NOT NULL,identity TEXT,status TEXT NOT NULL,launch_key TEXT);
CREATE TABLE audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,claim TEXT NOT NULL,binding TEXT,at INTEGER NOT NULL);
`;
export class WorkloadGuard {
  constructor(driver,file,policyFile,{transport=workloadTransport,policy=workloadPolicy}={}) {
    this.driver=driver;this.registry=database(file,schema);this.policyFile=policyFile;this.transport=transport;this.policy=policy;this.tail=Promise.resolve();this.flights=new Map();
    // Bind the attachment journal to the existing driver. Losing only this file
    // must never turn unknown external work into an empty, releasable claim.
    transaction(this.registry,()=>{if(!this.registry.prepare('SELECT id FROM identity').get())this.registry.prepare('INSERT INTO identity VALUES(?)').run(id());});
    const journal=this.registry.prepare('SELECT id FROM identity').get().id;
    transaction(driver.db,()=>{if(!driver.db.prepare('SELECT id FROM external_workload_journal').get())driver.db.prepare('INSERT INTO external_workload_journal VALUES(1,?)').run(journal);});
    if(driver.db.prepare('SELECT id FROM external_workload_journal').get().id!==journal){this.registry.close();requireThat(false,'WORKLOAD_JOURNAL_REPLACED','Restore the original workload journal before recovery');}
    return new Proxy(this,{get:(self,key)=>key in self?typeof self[key]==='function'?self[key].bind(self):self[key]:typeof driver[key]==='function'?driver[key].bind(driver):driver[key]});
  }
  status(){const s=this.driver.status();return {...s,externalWorkloads:{...workloadCapabilities(this.policyFile,this.driver.manifest.id),phase:s.claim_id?this.fence(s.claim_id)?.phase??'unknown':'idle',registered:s.claim_id?this.rows(s.claim_id).length:0}};}
  close(){this.registry.close();this.driver.close();}
  serial(fn,key){if(key&&this.flights.has(key))return this.flights.get(key);const p=this.tail.then(fn);this.tail=p.catch(()=>{});if(key){this.flights.set(key,p);p.finally(()=>this.flights.delete(key)).catch(()=>{});}return p;}
  auditExternal(kind,claim,binding=null){this.registry.prepare('INSERT INTO audit(kind,claim,binding,at) VALUES(?,?,?,?)').run(kind,claim,binding,Date.now());}
  fence(claim){return this.registry.prepare('SELECT * FROM fences WHERE claim=?').get(claim);}
  rows(claim){return this.registry.prepare('SELECT * FROM bindings WHERE claim=? ORDER BY id').all(claim);}
  active(credential) {
    const s=this.driver.db.prepare('SELECT * FROM state').get();
    requireThat(s.claim_id&&s.phase==='active'&&s.token_hash&&equal(hash(credential),s.token_hash)&&this.fence(s.claim_id)?.phase==='active','STALE_GRANT','Workload requires the current active generation');return s;
  }
  activate(body){return this.serial(async()=>{
    requireThat(!this.registry.prepare("SELECT 1 FROM fences WHERE phase!='idle' AND claim!=?").get(body.claimId),'RECOVERING','External workloads remain unconfirmed');
    const f=this.fence(body.claimId);requireThat(!f||f.phase==='active','REVOKED','External workload generation is revoked');
    const result=await this.driver.activate(body);
    this.registry.prepare("INSERT OR IGNORE INTO fences VALUES(?,?,?,'active')").run(body.claimId,body.authority,body.generation);return result;
  },'activate:'+JSON.stringify(body));}
  start(credential,body){return this.serial(()=>{this.active(credential);return this.driver.start(credential,body);},'start:'+hash(credential)+':'+JSON.stringify(body));}
  inspect(credential){this.active(credential);return this.driver.inspect(credential);}
  externalStatus(credential){const s=this.active(credential);return {claimId:s.claim_id,generation:s.generation,workloads:this.views(s.claim_id)};}
  views(claim){return this.rows(claim).map(r=>({id:r.id,target:JSON.parse(r.target),identity:r.identity?JSON.parse(r.identity):null,state:r.status}));}
  registerExternal(credential,body){return this.serial(()=>this.register(this.active(credential),body,false),'register:'+hash(credential)+':'+JSON.stringify(body));}
  adoptExternal(body){return this.serial(async()=>{
    const s=this.driver.validate(body);
    requireThat(s.claim_id===body.claimId&&s.generation===body.generation,'STALE_GRANT','Adoption must name the held generation');
    // Admin may finish a persisted inspection after a crash, never change owner.
    return this.register({...s,claim_id:body.claimId},body,true);
  },'adopt:'+JSON.stringify(body));}
  async register(s,body,admin) {
    text(body.key,'key',128);
    requireThat(Array.isArray(body.targets)&&body.targets.length>0&&body.targets.length<=32,'INVALID_INPUT','Register 1..32 exact workload identities');
    const targets=body.targets.map(t=>{
      text(t.host,'host',100);text(t.id,'target id',200);
      requireThat(['docker-container','systemd-user-unit'].includes(t.plugin),'PLUGIN_UNSUPPORTED','Unknown external workload plugin');
      requireThat(t.plugin==='docker-container'?/^[a-f0-9]{64}$/.test(t.id):/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,179}\.service$/.test(t.id),'WORKLOAD_IDENTITY','Use an exact workload identity');
      return {host:t.host,plugin:t.plugin,id:t.id};
    });
    const payload=JSON.stringify(targets),old=this.registry.prepare('SELECT payload FROM batches WHERE claim=? AND key=?').get(s.claim_id,body.key);
    requireThat(!old||old.payload===payload,'KEY_CONFLICT','Registration retry changed its targets');
    const records=targets.map(target=>({target,id:hash(s.claim_id+'/'+JSON.stringify(target)),connector:this.policy(this.policyFile,this.driver.manifest.id,target.host,target.plugin)}));
    requireThat(this.rows(s.claim_id).length+records.filter(r=>!this.registry.prepare('SELECT 1 FROM bindings WHERE id=?').get(r.id)).length<=128,'CAPACITY_LIMIT','At most 128 workloads per claim');
    const inspected=new Map();
    if(!admin)for(const r of records){
      if(this.registry.prepare('SELECT identity FROM bindings WHERE id=?').get(r.id)?.identity)continue;
      const observed=await this.transport(r.connector,'inspect',r.target);
      requireThat(observed.exists&&observed.identity&&observed.running===false&&observed.started===false,'WORKLOAD_NOT_OWNED','Prepare a fresh, never-started workload before registering it');
      if(r.target.plugin==='docker-container') {
        requireThat(observed.labels?.['accord.authority']===s.authority&&observed.labels?.['accord.claim']===s.claim_id&&observed.labels?.['accord.generation']===String(s.generation),'WORKLOAD_NOT_OWNED','Container labels must match this grant');
        requireThat(observed.restart==='no'||observed.restart==='','SUPERVISOR_REQUIRED','Automatic Docker restart must be disabled');
      } else requireThat(r.target.id.startsWith('accord-'+hash(s.authority+'/'+s.claim_id+'/'+s.generation).slice(0,20)+'-')&&observed.identity.definition&&observed.killMode==='control-group'&&!observed.triggeredBy&&!observed.autoStart,'WORKLOAD_NOT_OWNED','Prepare a dedicated untriggered control-group unit in this grant namespace');
      inspected.set(r.id,observed);
    }
    // Intent precedes inspection: an interrupted adoption blocks release instead
    // of forgetting a workload that may already be running outside this process.
    transaction(this.registry,()=>{
      this.registry.prepare('INSERT OR IGNORE INTO batches VALUES(?,?,?)').run(s.claim_id,body.key,payload);
      for(const r of records)this.registry.prepare("INSERT OR IGNORE INTO bindings VALUES(?,?,?,?,?,NULL,'pending',NULL)").run(r.id,s.claim_id,s.generation,JSON.stringify(r.target),JSON.stringify(r.connector));
    });
    for(const r of records) {
      const row=this.registry.prepare('SELECT * FROM bindings WHERE id=?').get(r.id);if(row.identity)continue;
      const observed=inspected.get(r.id)??await this.transport(JSON.parse(row.connector),'inspect',r.target);
      requireThat(observed.exists&&observed.identity&&typeof observed.running==='boolean','WORKLOAD_UNKNOWN','Cannot establish exact workload identity');
      if(r.target.plugin==='docker-container') {
        requireThat(observed.identity.id===r.target.id&&typeof observed.identity.engine==='string'&&observed.identity.engine,'WORKLOAD_IDENTITY','Container identity is incomplete');
        requireThat(observed.restart==='no'||observed.restart==='','SUPERVISOR_REQUIRED','Disable Docker restart; register external supervisors separately');
        if(!admin)requireThat(!observed.running&&observed.labels?.['accord.authority']===s.authority&&observed.labels?.['accord.claim']===s.claim_id&&observed.labels?.['accord.generation']===String(s.generation),'WORKLOAD_NOT_OWNED','Create a stopped container labelled for this grant; running or unlabelled adoption requires operator coordination');
      } else {
        requireThat(observed.identity.unit===r.target.id&&observed.identity.machine&&observed.identity.definition&&observed.killMode==='control-group'&&!observed.triggeredBy&&!observed.autoStart,'SUPERVISOR_UNSAFE','Use an identified, untriggered service that controls all its descendants');
      }
      const target={...r.target,...(observed.cgroup?{cgroup:observed.cgroup}:{} )};
      this.registry.prepare("UPDATE bindings SET target=?,identity=?,status='registered' WHERE id=?").run(JSON.stringify(target),JSON.stringify(observed.identity),r.id);
      this.auditExternal('workload.registered',s.claim_id,r.id);
    }
    return {claimId:s.claim_id,generation:s.generation,workloads:this.views(s.claim_id)};
  }
  verifyObservation(value,target) {
    const identity=value?.identity,expected=target.identity;
    requireThat(identity&&typeof value.exists==='boolean'&&typeof value.running==='boolean','WORKLOAD_UNKNOWN','Host observation is incomplete');
    const valid=target.plugin==='docker-container'
      ? identity.engine===expected.engine&&identity.id===expected.id
      : identity.machine===expected.machine&&identity.unit===expected.unit&&(!value.exists||identity.definition===expected.definition);
    requireThat(valid,'WORKLOAD_REPLACED','Host response does not match the registered workload');
    return value;
  }
  rememberStarted(row,result){
    const target=JSON.parse(row.target);if(result.cgroup)target.cgroup=result.cgroup;
    this.registry.prepare("UPDATE bindings SET status='started',target=? WHERE id=?").run(JSON.stringify(target),row.id);
  }
  externalAudit(){return {events:this.registry.prepare('SELECT * FROM audit ORDER BY seq').all()};}
  launchExternal(credential,body){return this.serial(async()=>{
    const s=this.active(credential);text(body.key,'key',128);const r=this.registry.prepare('SELECT * FROM bindings WHERE id=? AND claim=?').get(body.workload,s.claim_id);
    requireThat(r?.identity,'WORKLOAD_UNKNOWN','Registration must finish before launch');
    requireThat(!r.launch_key||r.launch_key===body.key,'KEY_CONFLICT','Retry the original launch key');
    const target={...JSON.parse(r.target),identity:JSON.parse(r.identity)};
    if(r.launch_key) {
      const observed=this.verifyObservation(await this.transport(JSON.parse(r.connector),'inspect',target),target);
      requireThat(observed.started,'START_UNKNOWN','Previous launch is ambiguous; resource remains held');
      this.rememberStarted(r,observed);return {...observed,workload:r.id};
    }
    this.registry.prepare("UPDATE bindings SET launch_key=?,status='starting' WHERE id=?").run(body.key,r.id);
    this.auditExternal('workload.launch_intent',s.claim_id,r.id);
    const result=this.verifyObservation(await this.transport(JSON.parse(r.connector),'start',target),target);
    requireThat(result.started,'START_UNKNOWN','Host did not confirm launch');
    this.rememberStarted(r,result);return {...result,workload:r.id};
  },'launch:'+hash(credential)+':'+JSON.stringify(body));}
  revoke(body){return this.serial(async()=>{
    const s=this.driver.validate(body);requireThat(!s.claim_id||s.claim_id===body.claimId,'OWNER_MISMATCH','Cannot revoke another owner');
    if(this.fence(body.claimId)?.phase==='idle'&&!s.claim_id)return this.driver.revoke(body);
    this.registry.prepare("INSERT INTO fences VALUES(?,?,?,'revoking') ON CONFLICT(claim) DO UPDATE SET phase='revoking'").run(body.claimId,body.authority,body.generation);
    this.auditExternal('workload.fenced',body.claimId);
    const rows=this.rows(body.claimId).sort((a,b)=>(JSON.parse(a.target).plugin==='systemd-user-unit'?0:1)-(JSON.parse(b.target).plugin==='systemd-user-unit'?0:1));
    for(const r of rows) {
      requireThat(r.identity,'WORKLOAD_UNKNOWN','Interrupted registration requires reconciliation; ownership remains held');
      const target={...JSON.parse(r.target),identity:JSON.parse(r.identity)},connector=JSON.parse(r.connector);
      if(r.status==='starting') {
        const inspected=this.verifyObservation(await this.transport(connector,'inspect',target),target);
        requireThat(inspected.started||(target.plugin==='docker-container'&&inspected.exists===false),'START_UNKNOWN','Unconfirmed start may still execute; ownership remains held');
      }
      const stopped=this.verifyObservation(await this.transport(connector,'stop',target),target);
      requireThat(stopped.running===false,'STOP_UNCONFIRMED','Host has not confirmed workload stop');
      this.registry.prepare("UPDATE bindings SET status='stopped' WHERE id=?").run(r.id);this.auditExternal('workload.stopped',body.claimId,r.id);
    }
    // Domain restoration and the driver's release receipt come strictly after
    // every registered supervisor and workload has confirmed stop.
    const result=await this.driver.revoke(body);
    this.registry.prepare("UPDATE fences SET phase='idle' WHERE claim=?").run(body.claimId);this.auditExternal('workload.released',body.claimId);return result;
  },'revoke:'+JSON.stringify(body));}
}
