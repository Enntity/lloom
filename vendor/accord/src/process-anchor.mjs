// SPDX-License-Identifier: MIT
// No workload executes before a committed launch record AND explicit arm message.
import http from 'node:http';
import { chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { database, transaction, equal, readBody } from './common.mjs';
import { artifactSchema } from './driver.mjs';
import { processSchema } from './process-schema.mjs';
import { workloadJournalMigration } from './workload-schema.mjs';
const [file,runId]=process.argv.slice(2);
let armed=false,db,child;
const watchdog=setTimeout(()=>process.exit(0),10000);
process.on('SIGTERM',()=>{}); // Keep the identity anchor alive until group SIGKILL.
process.on('disconnect',()=>{if(!armed)process.exit(0);});
process.once('message',async message=>{
  if(message!=='arm')return;
  clearTimeout(watchdog);
  try {
    db=database(file,[artifactSchema,processSchema,workloadJournalMigration]);
    const recorded=db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
    if(!recorded||recorded.pgid!==process.pid)throw Error('No committed launch');
    const control=http.createServer(async(req,res)=>{
      try {const body=await readBody(req);
        if(!equal(body.token,recorded.control_token)||!['SIGTERM','SIGKILL'].includes(body.signal)){res.writeHead(403).end();return;}
        res.end('{}',()=>{process.kill(-process.pid,body.signal);});
      }catch{res.writeHead(400).end();}
    });
    await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(recorded.socket,resolve);});
    chmodSync(recorded.socket,0o600);
    transaction(db,()=>{
      const run=db.prepare('SELECT * FROM runs WHERE id=?').get(runId),state=db.prepare('SELECT * FROM state').get();
      if(!run||run.pgid!==process.pid||run.phase!=='starting'||state.claim_id!==run.claim_id||state.phase!=='active')throw Error('Launch revoked');
      const manifest=JSON.parse(db.prepare('SELECT manifest FROM process_config').get().manifest);
      // Spawn and state change serialize against revocation. Descendants share our group.
      child=spawn(manifest.command[0],manifest.command.slice(1),{cwd:manifest.cwd,detached:false,
        env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME??'',LANG:'C',...manifest.env},stdio:['ignore','pipe','pipe']});
      db.prepare("UPDATE runs SET phase='running' WHERE id=?").run(runId);armed=true;
    });
    const chunks=[];let bytes=0,error=null;
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes<=8000)chunks.push(chunk);else error='OUTPUT_LIMIT';});
    child.stderr.on('data',()=>{}); // Drain without collecting secrets in the audit journal.
    child.on('error',()=>{error='SPAWN_FAILED';});
    child.on('close',(code,signal)=>{
      let output='';try{output=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{error='OUTPUT_ENCODING';}
      try {transaction(db,()=>{db.prepare("UPDATE runs SET phase='exited',exit_code=?,output=?,error=? WHERE id=? AND phase IN ('starting','running')")
        .run(code,output,error??(signal?'SIGNALLED':null),runId);});}catch{}
    });
    // Anchor stays alive even after workload exit, so PID reuse cannot authorize a kill.
    setInterval(()=>{},60000);
  } catch {db?.close();process.exit(0);}
});
