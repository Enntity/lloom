// SPDX-License-Identifier: MIT
// What a model reads. Full records stay on the HTTP API; every character here is paid
// for by every agent that calls the tool, so defaults and empties are left out.
const clip=(s,n)=>typeof s==='string'&&s.length>n?s.slice(0,n-1)+'…':s;
const clean=o=>Object.fromEntries(Object.entries(o).filter(([,v])=>v!==undefined&&v!==null&&v!==''&&!(Array.isArray(v)&&!v.length)));
const rank={recent:0,unknown:1,offline:2};
export const participant=p=>clean({address:p.address,label:clip(p.label,60),activity:clip(p.activity,120),state:p.state==='working'?undefined:p.state,
  presence:p.presence==='recent'?undefined:p.presence,location:clip(p.location,80),capabilities:p.capabilities?.slice(0,5).map(c=>clip(c,40))});
const holder=h=>h&&clean({label:clip(h.label,60),address:h.address,deadline:h.deadline,state:h.state==='running'?undefined:h.state});
// The legacy artifact slot and idle pool slots only add noise; pools are summarised once.
export function resources(list=[],pools){
  const shown=list.filter(r=>r.holder||r.state!=='unclaimed'||(r.plugin!=='artifact'&&r.localId!=='artifact'&&!r.pool));
  const entries=shown.map(r=>clean({id:r.id,pool:r.pool,state:r.state,plugin:r.plugin,enforcement:clip(r.enforcement,160),hosts:r.hosts,queued:(r.queued??r.queue?.length)||undefined,holder:holder(r.holder)}));
  // Linked hosts can reuse a pool name, so the full address tells them apart and is what accord_reserve takes.
  const address=r=>`${r.id.split('/')[0]}/${r.pool}`;
  const grouped=pools??[...new Set(list.filter(r=>r.pool).map(address))].map(id=>{const slots=list.filter(r=>r.pool&&address(r)===id);return {id,capacity:slots.length,free:slots.filter(r=>r.state==='unclaimed').length};});
  return clean({resources:entries,pools:grouped});
}
const hostLists=hosts=>{
  const known=new Map();for(const h of hosts)if(h.status==='unknown'||!known.has(h.authority))known.set(h.authority,h.status);
  return clean({hosts:[...known.keys()],unknownHosts:[...known].filter(([,s])=>s==='unknown').map(([a])=>a)});
};
export function bootstrap({address,announced,participants=[],resourceList,pools,hosts=[],recent,observed,inboxPending,deliveryProblems,learnings}){
  const peers=participants.slice(0,5).map(participant);
  return {participants:peers,...clean({address,announced:announced||undefined,moreParticipants:Math.max(0,(recent??peers.length)-peers.length)||undefined,
    ...resources(resourceList,pools),...hostLists(hosts),observed:observed||undefined,inboxPending:inboxPending||undefined,deliveryProblems,
    learnings:(learnings??[]).slice(0,5).map(l=>clean({name:l.name,type:l.type,description:clip(l.description,120),source:l.source,updated:l.updated}))})};
}
export function find(result,query=''){
  const ranked=[...(result.participants??[])].sort((a,b)=>(rank[a.presence]??0)-(rank[b.presence]??0)||(b.lastSeen??0)-(a.lastSeen??0));
  const matched=query?ranked:ranked.filter(p=>p.presence!=='offline'),hosts=result.hosts??[],limit=query?20:12;
  const hostMap=new Map();for(const h of hosts)if(h.status==='unknown'||!hostMap.has(h.authority))hostMap.set(h.authority,{authority:h.authority,status:h.status,...(h.reason?{reason:h.reason}:{})});
  const view=clean({participants:matched.slice(0,limit).map(participant),moreParticipants:(result.moreParticipants??0)+Math.max(0,matched.length-limit)||undefined,
    ...resources(result.resources??hosts.flatMap(h=>h.resources??[]),result.pools),hosts:[...hostMap.values()],
    observed:(result.observed??result.observations?.length)||undefined,inboxPending:result.inboxPending,deliveryProblems:result.deliveryProblems,
    moreResources:result.moreResources,
    next:'Observers are history, not extra peers. Search history with accord_sessions; use accord_resources for full resources.'});
  // Bound Unicode and large fleets too. Counts explicitly signal omitted records.
  while(Buffer.byteLength(JSON.stringify(view))>8192){
    if(view.participants?.length){view.participants.pop();view.moreParticipants=(view.moreParticipants??0)+1;}
    else if(view.resources?.length){view.resources.pop();view.moreResources=(view.moreResources??0)+1;}
    else if(view.pools?.length){view.pools.pop();view.moreResources=(view.moreResources??0)+1;}
    else break;
  }
  return {participants:[],...view};
}
export const reservation=r=>clean(r);
