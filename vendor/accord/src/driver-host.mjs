// SPDX-License-Identifier: MIT
import { WorkloadGuard } from './workload-guard.mjs';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { database, transaction, requireThat } from './common.mjs';
import { ArtifactDriver, driverServer } from './driver.mjs';
import { createResourceDriver,validateResource,plugins } from './resource-plugins.mjs';
const schema=`CREATE TABLE registrations(id TEXT PRIMARY KEY,asset TEXT UNIQUE NOT NULL,manifest TEXT NOT NULL);`;
export function driverHost(directory,controlToken){
  const db=database(join(directory,'resource-registry.sqlite'),schema);
  const create=(file,manifest)=>{const driver=createResourceDriver(file,manifest);return ['managed-http','posix-process-group'].includes(manifest.plugin)?new WorkloadGuard(driver,file+'.workloads',join(directory,'workload-policy.json')):driver;};
  const drivers=new Map([['artifact',new ArtifactDriver(join(directory,'driver.sqlite'))]]);
  for(const row of db.prepare('SELECT * FROM registrations').all())drivers.set(row.id,create(join(directory,`process-${row.id}.sqlite`),JSON.parse(row.manifest)));
  // Ownership policy may change in place; the registration row is its current declaration.
  const ownership=resource=>{const row=db.prepare('SELECT manifest FROM registrations WHERE id=?').get(resource),{maxOwnershipMs,allowIndefinite}=row?JSON.parse(row.manifest):{};return {maxOwnershipMs,allowIndefinite};};
  const identity=manifest=>JSON.stringify({...manifest,maxOwnershipMs:undefined,allowIndefinite:undefined});
  const describe=(resource,driver)=>({id:resource,instance:driver.status().instance,plugin:resource==='artifact'?'artifact':driver.manifest.plugin,
    enforcement:resource==='artifact'?'artifact-API':plugins.find(p=>p.id===driver.manifest.plugin).enforcement,asset:driver.manifest?.asset??'builtin:artifact',...ownership(resource)});
  const list=()=>[...drivers].map(([r,d])=>describe(r,d));
  const register=input=>{
    const manifest=validateResource(input),encoded=JSON.stringify(manifest);
    const old=db.prepare('SELECT * FROM registrations WHERE id=? OR asset=?').get(manifest.id,manifest.asset);
    requireThat(!old||identity(JSON.parse(old.manifest))===identity(manifest),'RESOURCE_CONFLICT','Resource ID or physical asset already registered differently');
    requireThat(drivers.size<64||drivers.has(manifest.id),'CAPACITY_LIMIT','At most 64 registered resources');
    // Intent is durable before driver creation; retries and restarts finish the same registration.
    transaction(db,()=>db.prepare('INSERT INTO registrations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET manifest=excluded.manifest').run(manifest.id,manifest.asset,encoded));
    if(!drivers.has(manifest.id))drivers.set(manifest.id,create(join(directory,`process-${manifest.id}.sqlite`),manifest));
    return describe(manifest.id,drivers.get(manifest.id));
  };
  // An idle resource leaves with its registration and files when its provider no longer
  // offers it, or when an administrator retires it.
  const withdraw=async({id,requested=false})=>{
    const d=id==='artifact'?null:drivers.get(id),idle=()=>{const s=d.status();return !s.claim_id&&(s.phase??'idle')==='idle';};
    const offered=async()=>!requested&&(d.manifest.plugin!=='managed-http'||!(await d.availability()).withdrawn);
    if(!d||!idle()||await offered()||!idle()||drivers.get(id)!==d)return {id,removed:false};
    drivers.delete(id);d.close();transaction(db,()=>db.prepare('DELETE FROM registrations WHERE id=?').run(id));
    const file=join(directory,`process-${id}.sqlite`);
    for(const f of [file,file+'.workloads'])for(const suffix of ['','-wal','-shm'])rmSync(f+suffix,{force:true});
    return {id,removed:true};
  };
  const resolveDriver=resource=>{const d=drivers.get(resource);requireThat(d,'RESOURCE_UNKNOWN','Resource is not installed',404);return d;};
  return {server:driverServer(drivers.get('artifact'),controlToken,{resolveDriver,register,list,withdraw}),
    status:()=>drivers.get('artifact').status(),close:()=>{for(const d of drivers.values())d.close();db.close();}};
}
