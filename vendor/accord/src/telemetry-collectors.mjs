// SPDX-License-Identifier: MIT
// CPU, NVIDIA and memory semantics adapted from LLooM; Mac sensors from Tessera.
// See vendor/lloom/README.md and native/LICENSE-TESSERA for provenance/licenses.
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readHostMemory } from '../vendor/lloom/host-memory.mjs';
const execute=promisify(execFile);
export async function runProbe(command,args=[]){
  return execute(command,args,{encoding:'utf8',timeout:1500,killSignal:'SIGKILL',maxBuffer:512*1024,windowsHide:true});
}
export function metric(value,min=0,max=Number.MAX_SAFE_INTEGER){
  if(value===null||value===undefined||String(value).trim()==='')return null;
  const n=Number(value);return Number.isFinite(n)&&n>=min&&n<=max?n:null;
}
function csv(line){const out=[];let part='',quoted=false;for(let i=0;i<line.length;i++){
  if(line[i]==='"'){if(quoted&&line[i+1]==='"'){part+='"';i++;}else quoted=!quoted;}
  else if(line[i]===','&&!quoted){out.push(part.trim());part='';}else part+=line[i];
}out.push(part.trim());return out;}
export const NVIDIA_FIELDS='index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,pstate,clocks.current.sm,clocks.current.memory';
export function parseNvidia(output){
  return String(output).trim().split(/\r?\n/).filter(Boolean).slice(0,64).flatMap(line=>{
    const f=csv(line);if(f.length!==10||metric(f[0])===null||!f[1])return [];
    return [{id:`nvidia:${f[0]}`,index:metric(f[0]),name:f[1].slice(0,200),vendor:'nvidia',backend:'nvidia-smi',
      utilization:metric(f[2],0,100),memoryUsedMb:metric(f[3]),memoryTotalMb:metric(f[4]),temperatureC:metric(f[5],-50,200),
      powerDrawW:metric(f[6],0,10000),performanceState:/^P\d{1,2}$/.test(f[7])?f[7]:null,smClockMhz:metric(f[8],0,20000),memoryClockMhz:metric(f[9],0,20000)}];
  });
}
export function gpuSummary(devices){
  if(!devices.length)return null;
  const values=k=>devices.map(d=>d[k]).filter(Number.isFinite),sum=a=>a.length?a.reduce((s,n)=>s+n,0):null;
  return {vendor:[...new Set(devices.map(d=>d.vendor))].join(','),backend:[...new Set(devices.map(d=>d.backend))].join(','),devices,
    utilization:values('utilization').length?sum(values('utilization'))/values('utilization').length:null,
    memoryUsedMb:sum(values('memoryUsedMb')),memoryTotalMb:sum(values('memoryTotalMb')),
    temperatureC:values('temperatureC').length?Math.max(...values('temperatureC')):null,powerDrawW:sum(values('powerDrawW'))};
}
const reason=e=>e?.code==='ENOENT'?'not-installed':e?.code==='EACCES'||e?.code==='EPERM'?'permission-denied':e?.killed?'timeout':'probe-failed';
const label=s=>String(s??'').trim().replace(/[\x00-\x1f\x7f]/g,'').slice(0,120);
export function createCollectors({platform=process.platform,arch=process.arch,system=os,files=fs,run=runProbe,nativeHelper}={}){
  let previousCpu=null;
  const read=async path=>{try{const s=await files.readFile(path,'utf8');return s.length<=65536?s.trim():null;}catch{return null;}};
  const list=async path=>{try{return (await files.readdir(path)).filter(n=>/^[a-zA-Z0-9_.:-]+$/.test(n)).sort().slice(0,128);}catch{return [];}};
  const number=async(path,scale=1,min=0,max=Number.MAX_SAFE_INTEGER)=>{const n=metric(await read(path),min*scale,max*scale);return n===null?null:n/scale;};
  async function nvidia(){
    if(!['linux','win32'].includes(platform))return {devices:[],source:{id:'nvidia-smi',status:'not-applicable'}};
    try{
      const {stdout}=await run('nvidia-smi',[`--query-gpu=${NVIDIA_FIELDS}`,'--format=csv,noheader,nounits']);
      const devices=parseNvidia(stdout);return {devices,source:{id:'nvidia-smi',status:devices.length?'available':'unavailable',...(devices.length?{}:{reason:'no-valid-devices'})}};
    }catch(e){return {devices:[],source:{id:'nvidia-smi',status:'unavailable',reason:reason(e)}};}
  }
  async function apple(){
    if(platform!=='darwin'||arch!=='arm64')return {devices:[],sensors:[],source:{id:'apple-iokit',status:'not-applicable'}};
    try{
      const {stdout}=await run(nativeHelper,[]),sample=JSON.parse(stdout);
      if(sample.schema!==1)throw Error('Unsupported helper');
      const utilization=metric(sample.gpuUtilization,0,100),temperatureC=metric(sample.hottestDieC,-50,200);
      return {devices:[{id:'apple:gpu',index:0,name:'Apple GPU',vendor:'apple',backend:'iokit',utilization,memoryUsedMb:null,memoryTotalMb:null,temperatureC:null,powerDrawW:null,performanceState:null,smClockMhz:null,memoryClockMhz:null,memoryModel:'unified'}],
        sensors:temperatureC===null?[]:[{id:'apple:soc-die-max',label:'Hottest SoC die',temperatureC,source:'iohid'}],
        source:{id:'apple-iokit',status:utilization===null&&temperatureC===null?'unavailable':utilization===null||temperatureC===null?'partial':'available'}};
    }catch(e){return {devices:[],sensors:[],source:{id:'apple-iokit',status:'unavailable',reason:reason(e)}};}
  }
  async function linuxSensors(){
    if(platform!=='linux')return {devices:[],sensors:[],source:{id:'linux-sysfs',status:'not-applicable'}};
    const sensors=[],devices=[];
    for(const zone of (await list('/sys/class/thermal')).filter(n=>/^thermal_zone\d+$/.test(n))){
      const base=join('/sys/class/thermal',zone),temperatureC=await number(join(base,'temp'),1000,-50,200);
      if(temperatureC!==null)sensors.push({id:`thermal:${zone}`,label:label(await read(join(base,'type')))||zone,temperatureC,source:'thermal-zone'});
    }
    for(const hw of (await list('/sys/class/hwmon')).filter(n=>/^hwmon\d+$/.test(n))){
      const base=join('/sys/class/hwmon',hw),name=label(await read(join(base,'name')))||hw;
      for(const f of (await list(base)).filter(n=>/^temp\d+_input$/.test(n)).slice(0,16)){
        const temperatureC=await number(join(base,f),1000,-50,200);
        if(temperatureC!==null)sensors.push({id:`hwmon:${hw}:${f}`,label:`${name}: ${label(await read(join(base,f.replace('_input','_label'))))||f}`,temperatureC,source:'hwmon'});
      }
    }
    for(const card of (await list('/sys/class/drm')).filter(n=>/^card\d+$/.test(n)).slice(0,64)){
      const base=join('/sys/class/drm',card,'device');if(await read(join(base,'vendor'))!=='0x1002')continue;
      const hw=(await list(join(base,'hwmon'))).find(n=>/^hwmon\d+$/.test(n)),h=hw?join(base,'hwmon',hw):null;
      devices.push({id:`amd:${card}`,index:Number(card.slice(4)),name:label(await read(join(base,'product_name')))||`AMD ${label(await read(join(base,'device'))) || 'GPU'}`,
        vendor:'amd',backend:'linux-drm',utilization:await number(join(base,'gpu_busy_percent'),1,0,100),
        memoryUsedMb:await number(join(base,'mem_info_vram_used'),1048576),memoryTotalMb:await number(join(base,'mem_info_vram_total'),1048576),
        sharedMemoryUsedMb:await number(join(base,'mem_info_gtt_used'),1048576),sharedMemoryTotalMb:await number(join(base,'mem_info_gtt_total'),1048576),
        temperatureC:h?await number(join(h,'temp1_input'),1000,-50,200):null,powerDrawW:h?await number(join(h,'power1_average'),1000000,0,10000):null,
        performanceState:null,smClockMhz:null,memoryClockMhz:null,memoryModel:'driver-reported-vram-and-gtt'});
    }
    return {devices,sensors:sensors.slice(0,128),source:{id:'linux-sysfs',status:sensors.length||devices.length?'available':'unavailable',...(sensors.length||devices.length?{}:{reason:'no-readable-sensors'})}};
  }
  async function network(){
    if(platform!=='linux')return {interfaces:[],source:{id:'network',status:'unsupported'}};
    const interfaces=[];
    for(const name of (await list('/sys/class/net')).slice(0,64)){
      const base=join('/sys/class/net',name);
      interfaces.push({name,state:label(await read(join(base,'operstate')))||'unknown',speedMbps:await number(join(base,'speed')),
        rxBytes:await number(join(base,'statistics/rx_bytes')),txBytes:await number(join(base,'statistics/tx_bytes'))});
    }
    return {interfaces,source:{id:'network',status:interfaces.length?'available':'unavailable'}};
  }
  async function disk(){
    try{const stat=await files.statfs(platform==='win32'?'C:\\':'/');return {disks:[{id:'root',totalBytes:stat.bsize*stat.blocks,availableBytes:stat.bsize*stat.bavail,freeBytes:stat.bsize*stat.bfree}],source:{id:'filesystem',status:'available'}};}
    catch{return {disks:[],source:{id:'filesystem',status:'unavailable'}};}
  }
  async function snapshot(){
    const cpus=system.cpus(),current=cpus.reduce((t,c)=>({idle:t.idle+c.times.idle,total:t.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
    const delta=previousCpu?{idle:current.idle-previousCpu.idle,total:current.total-previousCpu.total}:null;previousCpu=current;
    const utilization=delta&&delta.total>0&&delta.idle>=0&&delta.idle<=delta.total?100*(1-delta.idle/delta.total):null;
    const [nv,mac,linux,net,storage,available]=await Promise.all([nvidia(),apple(),linuxSensors(),network(),disk(),readHostMemory({platform,totalBytes:system.totalmem(),freeBytes:system.freemem(),readFile:files.readFile.bind(files),execFileImpl:run})]);
    const total=system.totalmem(),free=system.freemem(),used=Math.max(0,total-free),sensors=[...mac.sensors,...linux.sensors];
    return {cpu:{utilization,logicalCpus:cpus.length,model:cpus[0]?.model??null,loadAverage:system.loadavg(),uptimeSeconds:system.uptime(),sampleState:utilization===null?'warming':'available'},
      memory:{usedBytes:used,freeBytes:free,availableBytes:available.availableBytes,totalBytes:total,utilization:total>0?used/total*100:null,pressureUtilization:available.utilization,source:available.source},
      gpu:gpuSummary([...nv.devices,...mac.devices,...linux.devices]),thermal:{sensors,hottestC:sensors.length?Math.max(...sensors.map(s=>s.temperatureC)):null},
      network:{interfaces:net.interfaces},storage:{disks:storage.disks},
      collectors:[{id:'cpu',status:cpus.length?'available':'unavailable'}, {id:'memory',status:available.source==='os-freemem'?'estimated':'available'},nv.source,mac.source,linux.source,net.source,storage.source]};
  }
  async function metadata(){
    const cpus=system.cpus();let devices=[],nvidiaStatus='not-applicable';
    if(['linux','win32'].includes(platform)){
      try{
        const {stdout}=await run('nvidia-smi',['--query-gpu=index,uuid,name,memory.total,compute_cap,driver_version,pci.bus_id','--format=csv,noheader,nounits']);
        devices=stdout.trim().split(/\r?\n/).filter(Boolean).slice(0,64).flatMap(line=>{const f=csv(line);if(f.length!==7||metric(f[0])===null)return [];
          return [{id:`nvidia:${f[0]}`,uuid:label(f[1]),vendor:'nvidia',kind:'gpu',name:label(f[2]),memoryTotalMb:metric(f[3]),computeCapability:/^\d+\.\d+$/.test(f[4])?f[4]:null,driverVersion:label(f[5]),pciBusId:label(f[6]),backend:'cuda',memoryModel:/\bGB10\b/i.test(f[2])?'unified':'device'}];});
        nvidiaStatus=devices.length?'available':'unavailable';
      }catch{nvidiaStatus='unavailable';}
    }
    if(platform==='darwin'&&arch==='arm64')devices.push({id:'apple:gpu',vendor:'apple',kind:'gpu',name:'Apple GPU',backend:'metal',memoryModel:'unified',memoryTotalMb:null},
      {id:'apple:ane',vendor:'apple',kind:'npu',name:'Apple Neural Engine',backend:'ane',memoryModel:'unified',memoryTotalMb:null});
    if(platform==='linux')devices.push(...(await linuxSensors()).devices.map(d=>({id:d.id,vendor:d.vendor,kind:'gpu',name:d.name,backend:'amdgpu',memoryTotalMb:d.memoryTotalMb,memoryModel:d.memoryModel})));
    return {hostname:system.hostname(),platform,arch,release:system.release(),cpu:{model:cpus[0]?.model??null,logicalCpus:cpus.length},memory:{totalBytes:system.totalmem(),model:platform==='darwin'&&arch==='arm64'||devices.some(d=>d.memoryModel==='unified')?'unified':'host-and-device'},devices,
      collectors:[{id:'os',status:'available'},{id:'nvidia-inventory',status:nvidiaStatus}]};
  }
  return {snapshot,metadata};
}
