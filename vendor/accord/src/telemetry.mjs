// SPDX-License-Identifier: MIT
import { readHostMemory } from '../vendor/lloom/host-memory.mjs';
import { performance } from 'node:perf_hooks';
import { createCollectors } from './telemetry-collectors.mjs';

// Read-through, memory-only caches. No timers run while idle; a hung collector
// keeps its single flight so timeout cannot create an unbounded probe backlog.
export function createTelemetry({authority,hostName,collectors=createCollectors(),now=Date.now,clock=()=>performance.now(),timeoutMs=2200,liveTtlMs=2000,metadataTtlMs=300000}={}) {
  function cache(collect,field,ttlMs) {
    let value=null,sampledAt=null,sampleClock=0,retryAt=0,flight=null,lastError=null;
    async function read() {
      if(clock()>=retryAt&&!flight){
        const startedAt=now(),startedClock=clock();
        flight=Promise.resolve().then(collect).then(result=>{
          value=result;sampledAt=startedAt;sampleClock=startedClock;lastError=null;
          retryAt=clock()+ttlMs;
        },()=>{lastError='collector-failed';retryAt=clock()+liveTtlMs;}).finally(()=>{flight=null;});
      }
      if(flight){
        let timer;
        const outcome=await Promise.race([flight.then(()=> 'finished'),new Promise(resolve=>{timer=setTimeout(()=>resolve('timeout'),timeoutMs);})]);
        clearTimeout(timer);if(outcome==='timeout')lastError='collector-timeout';
      }
      const ageMs=sampledAt===null?null:Math.max(0,clock()-sampleClock),stale=!!lastError||ageMs===null||ageMs>ttlMs+timeoutMs;
      const incomplete=value?.collectors?.some(c=>['unavailable','partial','estimated','unsupported'].includes(c.status));
      return {schema:1,authority,hostname:hostName,sampledAt,ageMs:ageMs===null?null:Math.round(ageMs),stale,
        status:!value?'unavailable':stale?'stale':incomplete?'partial':'available',refreshAfterMs:Math.max(0,Math.ceil(retryAt-clock())),
        ...(lastError?{reason:lastError}:{}),[field]:value};
    }
    return read;
  }
  return {telemetry:cache(collectors.snapshot,'host',liveTtlMs),metadata:cache(collectors.metadata,'machine',metadataTtlMs),memory:cache(()=>readHostMemory({strict:true}),'memory',100)};
}

// Tessera's MachineVitals uses fractions; LLooM's host metrics use percentages.
// Preserve nulls so an absent sensor never becomes a zero reading.
export function tesseraVitals(sample){
  const h=sample.host;if(!h||sample.stale)return null;
  const fraction=n=>Number.isFinite(n)?n/100:null;
  return {cpu:fraction(h.cpu?.utilization),gpu:fraction(h.gpu?.utilization),
    memory:fraction(h.memory?.pressureUtilization),memoryTotalGB:Number.isFinite(h.memory?.totalBytes)?h.memory.totalBytes/2**30:null,
    temperature:h.gpu?.temperatureC??h.thermal?.hottestC??null,hottestSensor:h.thermal?.hottestC??null,
    gpuName:h.gpu?.devices?.map(d=>d.name).join(', ')||null,gpuPowerW:h.gpu?.powerDrawW??null,
    load:h.cpu?.loadAverage?.[0]??null,cores:h.cpu?.logicalCpus??null};
}

// Feed this into LLooM's normalizeMachineProfile. Keep recipe policy, accelerator
// classification, cluster topology and model admission in the consuming product.
export function lloomMachineInput(sample){
  const m=sample.machine;if(!m||sample.stale)return null;
  return {platform:m.platform,arch:m.arch,cpuBrand:m.cpu?.model,logicalCpus:m.cpu?.logicalCpus,totalMemoryGb:m.memory.totalBytes/2**30,
    devices:m.devices.map(d=>({...d,id:d.vendor==='nvidia'?d.id.replace(/^nvidia:/,'cuda:'):d.id==='apple:gpu'?'apple-gpu':d.id==='apple:ane'?'apple-neural-engine':d.id,
      ...(Number.isFinite(d.memoryTotalMb)?{memoryGb:d.memoryTotalMb/1024}:{})}))};
}
