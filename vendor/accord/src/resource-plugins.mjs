// SPDX-License-Identifier: MIT
import { ManagedDriver,managedManifest,managedPlugin } from './managed-driver.mjs';
import { ArtifactDriver } from './driver.mjs';
import { validateManifest as processManifest,ProcessDriver,processPlugin } from './process-driver.mjs';
import { requireThat,text } from './common.mjs';
export const cooperativePlugin={id:'cooperative',enforcement:'cooperative agreement only; no external process or device control'};
export const plugins=[cooperativePlugin,processPlugin,managedPlugin];
export function validateResource(value){
  if(value?.plugin==='managed-http')return managedManifest(value);
  if(value?.plugin!=='cooperative')return processManifest(value);
  requireThat(value.schema===1&&/^[a-z][a-z0-9-]{0,63}$/.test(value.id)&&value.id!=='artifact','RESOURCE_MANIFEST','Invalid resource schema or ID',400);
  text(value.asset,'asset',200);return {schema:1,id:value.id,asset:value.asset,plugin:'cooperative'};
}
class CooperativeDriver extends ArtifactDriver {
  constructor(file,manifest){super(file);this.manifest=manifest;}
  start(){requireThat(false,'WRONG_DRIVER','Cooperative resources have no managed workload',400);}
  inspect(){return {state:'unmanaged',enforcement:cooperativePlugin.enforcement};}
  write(){requireThat(false,'WRONG_DRIVER','Cooperative resources do not control external effects',400);}
}
export function createResourceDriver(file,manifest){return manifest.plugin==='managed-http'?new ManagedDriver(file,manifest):manifest.plugin==='cooperative'?new CooperativeDriver(file,manifest):new ProcessDriver(file,manifest);}
