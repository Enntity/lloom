// SPDX-License-Identifier: MIT
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { ArtifactDriver } from './driver.mjs';
import { processSchema } from './process-schema.mjs';
import { workloadJournalMigration } from './workload-schema.mjs';
import { transaction, requireThat, text, integer, hash, equal, id, token } from './common.mjs';
import * as posix from './plugins/posix-process-group.mjs';

export const processPlugin = posix.descriptor;
export function validateManifest(value) {
  requireThat(value&&value.schema===1&&/^[a-z][a-z0-9-]{0,63}$/.test(value.id)&&value.id!=='artifact','RESOURCE_MANIFEST','Invalid resource schema or ID',400);
  requireThat(value.plugin===posix.descriptor.id,'PLUGIN_UNSUPPORTED','Install a supported enforcement plugin; hardware labels alone confer no isolation',400);
  text(value.asset,'asset',200);requireThat(Array.isArray(value.command)&&value.command.length>0&&value.command.length<=64&&isAbsolute(value.command[0]),'RESOURCE_MANIFEST','Use an absolute executable and argument array',400);
  value.command.forEach(v=>{requireThat(typeof v==='string'&&v.length<=2000&&!v.includes('\0'),'RESOURCE_MANIFEST','Invalid executable argument',400);});
  requireThat(typeof value.cwd==='string'&&isAbsolute(value.cwd),'RESOURCE_MANIFEST','Use an absolute working directory',400);
  integer(value.terminationGraceMs??200,'terminationGraceMs',0,5000);
  const env=value.env??{};requireThat(env&&typeof env==='object'&&!Array.isArray(env)&&Object.keys(env).length<=32,'RESOURCE_MANIFEST','Invalid environment',400);
  for(const [k,v] of Object.entries(env))requireThat(/^[A-Z_][A-Z0-9_]*$/.test(k)&&typeof v==='string'&&v.length<=2000&&!v.includes('\0'),'RESOURCE_MANIFEST','Invalid environment entry',400);
  return {schema:1,id:value.id,asset:value.asset,plugin:value.plugin,command:value.command,cwd:resolve(value.cwd),env,terminationGraceMs:value.terminationGraceMs??200};
}
export class ProcessDriver extends ArtifactDriver {
  constructor(file,manifest){
    super(file,{recover:false,migrations:[processSchema,workloadJournalMigration]});this.file=resolve(file);this.plugin=posix;
    this.manifest=validateManifest(manifest);
    transaction(this.db,()=>{
      const prior=this.db.prepare('SELECT manifest FROM process_config').get();
      requireThat(!prior||prior.manifest===JSON.stringify(this.manifest),'RESOURCE_CONFLICT','Registered workload definition changed');
      this.db.prepare('INSERT OR IGNORE INTO process_config VALUES(1,?)').run(JSON.stringify(this.manifest));
      const old=this.status();
      if(old.claim_id){this.db.prepare("UPDATE state SET phase='recovering',token_hash=NULL").run();this.audit('restart.recovering',old.generation,old.claim_id);}
    });
  }
  status(){return {...super.status(),phase:this.db.prepare('SELECT phase FROM state').get().phase,enforcement:posix.descriptor.enforcement};}
  activate(body){
    return transaction(this.db,()=>{
      const old=this.validate(body);text(body.credentialHash,'credentialHash',64);
      requireThat(!old.claim_id||old.phase==='active','RECOVERING','Old process ownership has not been stopped');
      if(body.generation===old.generation){
        const secret=this.db.prepare('SELECT token_hash FROM state').get().token_hash;
        requireThat(old.claim_id===body.claimId&&equal(secret,body.credentialHash),'REVOKED','Generation is no longer active');
      }else{
        requireThat(!old.claim_id,'DRIVER_BUSY','Prior process owner has not been revoked');
        this.db.prepare("UPDATE state SET authority=?,epoch=?,generation=?,claim_id=?,token_hash=?,phase='active'")
          .run(body.authority,body.epoch,body.generation,body.claimId,body.credentialHash);
        this.audit('grant.active',body.generation,body.claimId);
      }
      this.db.prepare('UPDATE state SET epoch=?').run(body.epoch);
      return {active:true,instance:old.instance,generation:body.generation,claimId:body.claimId};
    });
  }
  authenticated(credential){const state=this.db.prepare('SELECT * FROM state').get();requireThat(state.phase==='active'&&state.claim_id&&equal(hash(credential),state.token_hash),'STALE_GRANT','Resource credential is not an active process grant');return state;}
  start(credential,body){
    let child,run;
    try {
      transaction(this.db,()=>{
        const state=this.authenticated(credential);text(body.key,'key',128);
        run=this.db.prepare('SELECT * FROM runs WHERE claim_id=?').get(state.claim_id);
        if(run){requireThat(run.effect_key===body.key,'ALREADY_STARTED','One workload per claim; retry its original key');return;}
        requireThat(this.db.prepare('SELECT count(*) AS n FROM runs').get().n<10000,'CAPACITY_LIMIT','Process journal limit reached',503);
        const runId=id();child=posix.launchAnchor(this.file,runId);
        requireThat(child.pid>1,'SPAWN_FAILED','Could not launch the process anchor');
        const birth=posix.identity(child.pid);requireThat(birth?.pgid===child.pid,'PROCESS_IDENTITY','Anchor is not an isolated process group');
        this.db.prepare("INSERT INTO runs(id,claim_id,generation,effect_key,pgid,birth,phase,control_token,socket,started_at) VALUES(?,?,?,?,?,?,'starting',?,?,?)")
          .run(runId,state.claim_id,state.generation,body.key,child.pid,birth.birth,token(),join(mkdtempSync('/tmp/accord-p-'),'control.sock'),Date.now());
        this.audit('process.launch_committed',state.generation,state.claim_id);run=this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
      });
      // Crash before commit or before arm cannot execute the configured workload.
      if(child)child.send('arm',()=>{});
      return this.runView(run);
    }catch(e){try{child?.disconnect();}catch{}throw e;}
  }
  runView(run){return {id:run.id,claimId:run.claim_id,generation:run.generation,state:run.phase,pgid:run.pgid,exitCode:run.exit_code,error:run.error,stoppedAt:run.stopped_at};}
  inspect(credential){const state=this.authenticated(credential),run=this.db.prepare('SELECT * FROM runs WHERE claim_id=?').get(state.claim_id);return run?this.runView(run):{state:'not-started'};}
  receipt(runId){
    const run=this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId);requireThat(run,'NOT_FOUND','Unknown process run',404);
    requireThat(run.exit_code===0&&!run.error,'PROCESS_NOT_SUCCEEDED','Workload has not exited successfully');
    return {id:run.id,claimId:run.claim_id,generation:run.generation,sha256:hash(run.output),bytes:Buffer.byteLength(run.output),at:run.started_at,kind:'process-output'};
  }
  async revoke(body){
    transaction(this.db,()=>{const old=this.validate(body);requireThat(!old.claim_id||old.claim_id===body.claimId,'OWNER_MISMATCH','Cannot revoke another process owner');
      this.db.prepare("UPDATE state SET phase='stopping',token_hash=NULL,authority=?,epoch=?,generation=?").run(body.authority,body.epoch,body.generation);
    });
    const runs=this.db.prepare("SELECT * FROM runs WHERE claim_id=? AND phase!='stopped'").all(body.claimId);
    for(const run of runs){
      if(posix.groupExists(run.pgid)){
        if(run.stop_at===null){await posix.signalGroup(run,'SIGTERM');this.db.prepare('UPDATE runs SET stop_at=? WHERE id=?').run(Date.now(),run.id);this.audit('process.term_sent',run.generation,run.claim_id);}
        else if(Date.now()-run.stop_at>=this.manifest.terminationGraceMs){await posix.signalGroup(run,'SIGKILL');this.audit('process.kill_sent',run.generation,run.claim_id);}
        requireThat(!posix.groupExists(run.pgid),'STOP_PENDING','Process group has not disappeared; ownership remains held',503);
      }
      transaction(this.db,()=>{this.db.prepare("UPDATE runs SET phase='stopped',stopped_at=? WHERE id=?").run(Date.now(),run.id);this.audit('process.stopped',run.generation,run.claim_id);});
      rmSync(dirname(run.socket),{recursive:true,force:true});
    }
    const receipt=super.revoke(body);this.db.prepare("UPDATE state SET phase='idle'").run();return {...receipt,proof:'all-recorded-process-groups-absent'};
  }
}
