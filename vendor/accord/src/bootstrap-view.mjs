// SPDX-License-Identifier: MIT
// A join is orientation, not an export of the board or transcript directory.
// Bound the serialized HTTP response so already-running MCP bridges benefit.
import { splitDiscovery, discoveryGuidance } from './discovery-view.mjs';
export const bootstrapByteLimit=4*1024;
const short=(s,n)=>typeof s==='string'?s.slice(0,n):s;
const resource=r=>({id:r.id,localId:r.localId,...(r.pool?{pool:r.pool}:{}),plugin:r.plugin,hosts:r.hosts,state:r.state,driver:r.driver,enforcement:short(r.enforcement,100),
  holder:r.holder?{actor:r.holder.actor,claim:r.holder.claim,label:short(r.holder.label,80),generation:r.holder.generation,state:r.holder.state,deadline:r.holder.deadline}:null});
export function bootstrapView({actor,local,peers,directory,inbox,learnings}){
  const discovered=splitDiscovery([...(directory.participants??[]),...(directory.observations??[])],`${local.authority}/${actor.id}`);
  const view={me:{id:actor.id,role:actor.role,...(actor.session?{session:{id:actor.session.id}}:{})},address:`${local.authority}/${actor.id}`,
    host:{protocol:local.protocol,authority:local.authority,name:short(local.name,80),epoch:local.epoch,observedAt:local.observedAt,paused:local.paused,resource:local.resource?resource(local.resource):undefined,resources:[]},
    peers:[],directory:{hosts:[],participants:[]},inbox:{messages:[]},
    preview:{observations:{available:discovered.observations.length},participants:{returned:0,recent:0,available:discovered.participants.length},resources:{returned:0,available:(local.resources??[]).length},messages:{returned:0,available:inbox.messages.length}},
    next:discoveryGuidance+' More: accord_find, accord_sessions, accord_resources, accord_inbox.'};
  const append=(array,item)=>{array.push(item);if(Buffer.byteLength(JSON.stringify(view))>bootstrapByteLimit-256){array.pop();return false;}return true;};
  const hosts=new Map();for(const h of [...peers,...directory.hosts])if(h.status==='unknown'||!hosts.has(h.authority))hosts.set(h.authority,h);
  for(const h of [...hosts.values()].slice(0,32))append(view.directory.hosts,{authority:h.authority,status:h.status});
  if(local.pools?.length){view.host.pools=[];for(const p of local.pools.slice(0,8))append(view.host.pools,p);}
  for(const r of (local.resources??[]).slice(0,8))append(view.host.resources,resource(r));
  const recent=discovered.participants.filter(p=>p.presence==='recent'&&!['done','failed','exited','cancelled'].includes(p.state));
  view.preview.participants.recent=recent.length;
  for(const p of recent.slice(0,5))append(view.directory.participants,{kind:p.kind,state:p.state,address:p.address,label:short(p.label,60),activity:short(p.activity,120),location:short(p.location,80),capabilities:(p.capabilities??[]).slice(0,5).map(c=>short(c,40)),harness:p.harness,presence:p.presence,lastSeen:p.lastSeen});
  for(const m of inbox.messages.slice(0,1))append(view.inbox.messages,{id:m.id,deliveryId:m.deliveryId,from:m.from,kind:m.kind,text:short(m.text,160),at:m.at,preview:true});
  if(learnings?.length){view.learnings=[];for(const l of learnings.slice(0,5))append(view.learnings,{name:short(l.name,80),type:l.type,description:short(l.description,120),source:short(l.source,20),updated:short(l.updated,24)});}
  view.preview.participants.returned=view.directory.participants.length;
  view.preview.resources.returned=view.host.resources.length;
  view.preview.messages.returned=view.inbox.messages.length;
  return view;
}
