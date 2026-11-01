// SPDX-License-Identifier: MIT
import { join } from 'node:path';
import { database, transaction, requireThat } from './common.mjs';
import { ArtifactDriver, driverServer } from './driver.mjs';
import { createResourceDriver,validateResource,plugins } from './resource-plugins.mjs';
const schema=`CREATE TABLE registrations(id TEXT PRIMARY KEY,asset TEXT UNIQUE NOT NULL,manifest TEXT NOT NULL);`;
export function driverHost(directory,controlToken){
  const db=database(join(directory,'resource-registry.sqlite'),schema);
  const drivers=new Map([['artifact',new ArtifactDriver(join(directory,'driver.sqlite'))]]);
  for(const row of db.prepare('SELECT * FROM registrations').all())drivers.set(row.id,createResourceDriver(join(directory,`process-${row.id}.sqlite`),JSON.parse(row.manifest)));
  const describe=(resource,driver)=>({id:resource,instance:driver.status().instance,plugin:resource==='artifact'?'artifact':driver.manifest.plugin,
    enforcement:resource==='artifact'?'artifact-API':plugins.find(p=>p.id===driver.manifest.plugin).enforcement,asset:driver.manifest?.asset??'builtin:artifact'});
  const list=()=>[...drivers].map(([r,d])=>describe(r,d));
  const register=input=>{
    const manifest=validateResource(input),encoded=JSON.stringify(manifest);
    const old=db.prepare('SELECT * FROM registrations WHERE id=? OR asset=?').get(manifest.id,manifest.asset);
    requireThat(!old||old.manifest===encoded,'RESOURCE_CONFLICT','Resource ID or physical asset already registered differently');
    requireThat(drivers.size<64||drivers.has(manifest.id),'CAPACITY_LIMIT','At most 64 registered resources');
    // Intent is durable before driver creation; retries and restarts finish the same registration.
    transaction(db,()=>db.prepare('INSERT OR IGNORE INTO registrations VALUES(?,?,?)').run(manifest.id,manifest.asset,encoded));
    if(!drivers.has(manifest.id))drivers.set(manifest.id,createResourceDriver(join(directory,`process-${manifest.id}.sqlite`),manifest));
    return describe(manifest.id,drivers.get(manifest.id));
  };
  const resolveDriver=resource=>{const d=drivers.get(resource);requireThat(d,'RESOURCE_UNKNOWN','Resource is not installed',404);return d;};
  return {server:driverServer(drivers.get('artifact'),controlToken,{resolveDriver,register,list}),
    status:()=>drivers.get('artifact').status(),close:()=>{for(const d of drivers.values())d.close();db.close();}};
}
