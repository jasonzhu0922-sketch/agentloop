import assert from 'node:assert/strict';
import { before,after,test } from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn,type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { RedisRuntimeRecords } from '../src/storage/redis-runtime-records.ts';
import { RuntimeRedisClient } from '../src/storage/runtime-redis-client.ts';
import { SqliteConnection } from '../src/storage/sqlite-connection.ts';
import { SqlRuntimeHistoryStore,RuntimeHistoryWorker,type RuntimeHistorySink } from '../src/storage/runtime-history.ts';
import { RuntimeRecordMaintenance, FileRuntimeArchiveStore } from '../src/storage/runtime-record-maintenance.ts';
import { appendRunEvent } from '../src/storage/repositories/run-event-sequencer.ts';
import { RuntimeHistoryView } from '../src/storage/runtime-history-view.ts';
let directory:string,url:string,child:ChildProcess;
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'agentloop-history-'));
  const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;await new Promise<void>(resolve=>server.close(()=>resolve()));
  url=`redis://127.0.0.1:${port}`;
  child=spawn('redis-server',['--bind','127.0.0.1','--port',String(port),'--dir',directory,'--appendonly','yes','--appendfsync','always','--maxmemory-policy','noeviction','--save',''],{stdio:['ignore','pipe','pipe']});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Redis startup timeout')),10000);child.once('error',reject);child.stdout!.on('data',data=>{if(String(data).includes('Ready to accept connections')){clearTimeout(timer);resolve();}});});
});
after(async()=>{if(child?.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}if(directory)await rm(directory,{recursive:true,force:true});});
async function fixture(){
  const namespace=`history:{${randomUUID()}}`,state=await RedisRuntimeRecords.open(new RuntimeRedisClient(url),{prefix:namespace});
  const db=new SqliteConnection(join(directory,`${randomUUID()}.sqlite`));const sink=new SqlRuntimeHistoryStore({namespace,connect:async()=>db});
  return {namespace,state,db,sink,worker:new RuntimeHistoryWorker({namespace,outbox:state.historyOutbox,sink,retryBaseMs:1,retryMaxMs:1})};
}
async function admit(state:RedisRuntimeRecords){await state.transaction(async()=>{
  await state.records.insert('conversations',{id:'c',owner_user_id:'owner',title:'分析',created_at:1,updated_at:1});
  await state.records.insert('runs',{id:'r',owner_user_id:'owner',conversation_id:'c',depth:0,status:'running',input:'fixture',created_at:2});
});}
test('atomic admission, object coalescing, independent versions, no stream or Action observation tasks',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.state.transaction(async()=>{await admit(f.state);throw new Error('rollback');}));assert.equal((await f.state.historyOutbox.status()).pendingCount,0);
  await admit(f.state);const first=await f.state.historyOutbox.pending(100);assert.equal(first.length,2);
  await Promise.all(Array.from({length:20},(_,i)=>appendRunEvent(f.state,'r',{type:'assistant.streaming',data:{i},createdAt:i})));
  assert.equal((await f.state.historyOutbox.status()).pendingCount,2);
  await f.state.records.update('conversations',{id:'c'},()=>({title:'新的标题',updated_at:10}));
  const next=await f.state.historyOutbox.pending(100);assert.equal(next.find(t=>t.kind==='conversations')!.version,2);assert.equal(next.find(t=>t.kind==='runs')!.version,1);
  await f.state.historyOutbox.acknowledge(first);assert.equal((await f.state.historyOutbox.status()).pendingCount,1);
  await f.worker.drain();assert.equal((await f.sink.listConversations('owner')).conversations[0].title,'新的标题');
 }finally{await f.worker.close();await f.state.close();}});
test('terminal partial results, plans, revisions, artifacts and archive references enter history; no run_events SQL',async()=>{
 const f=await fixture();const maintenance=new RuntimeRecordMaintenance({state:f.state,namespace:f.namespace,archive:new FileRuntimeArchiveStore(join(directory,randomUUID()))});try{
  await admit(f.state);
  await f.state.records.insert('plans',{id:'p',run_id:'r',version:1,goal:'分析',selected_skill_ids_json:'[]',status:'running',created_at:3,updated_at:3});
  const artifact={path:'report.txt',sha256:'a'.repeat(64),bytes:42};
  await f.state.records.insert('plan_steps',{plan_id:'p',step_id:'s',position:0,objective:'step',dependencies_json:'[]',skill_ids_json:'[]',recommended_tool_names_json:'[]',success_criteria_json:'[]',status:'completed',output:'valid partial',evidence_json:JSON.stringify({publishedResult:{schema:'agentloop.runtimeResult/v1',payload:{content:'partial'}},deliveryCandidate:{deliveryReceipt:{artifact}}})});
  await f.state.records.insert('plan_revision_snapshots',{plan_id:'p',version:1,proposal_json:'{}',reason:'initial',created_at:3});
  await f.state.transaction(async()=>{
   await f.state.records.insert('run_outcomes',{run_id:'r',plan_id:'p',status:'failed',reason_code:'fixture',output:'valid partial',result_json:JSON.stringify({partial:true}),committed_at:4});
   await f.state.records.update('runs',{id:'r'},()=>({status:'failed',output:'valid partial',finished_at:4}));
  });
  await maintenance.archiveNow();await f.worker.drain();
  const run=await f.sink.getRun('owner','r');assert.equal(run.output,'valid partial');assert.equal(run.plans.length,1);assert.equal(run.steps.length,1);assert.equal(run.revisions.length,1);assert.equal(run.results.length,1);assert.ok(run.artifacts.length>0);assert.ok(run.archives.length>0);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='run_events'").get<any>())!.n,0);
  assert.equal(await f.sink.getRun('other','r'),undefined);
 }finally{await maintenance.close();await f.worker.close();await f.state.close();}});
test('lost SQL response, duplicate workers, stale acknowledgements and out-of-order projections are idempotent',async()=>{
 const f=await fixture();try{
  await admit(f.state);const old=await f.state.historyOutbox.pending(100);let lost=true;
  const lossy:RuntimeHistorySink={writeBatch:async(ns,tasks)=>{await f.sink.writeBatch(ns,tasks);if(lost){lost=false;throw new Error('commit response lost');}}};
  const a=new RuntimeHistoryWorker({namespace:f.namespace,outbox:f.state.historyOutbox,sink:lossy,retryBaseMs:1,retryMaxMs:1});await a.drain();assert.equal((await f.state.historyOutbox.status()).pendingCount,2);
  await f.state.records.update('runs',{id:'r'},()=>({status:'cancelled',output:'partial',finished_at:5}));const latest=await f.state.historyOutbox.pending(100,Date.now()+10);
  await f.sink.writeBatch(f.namespace,latest);await f.sink.writeBatch(f.namespace,old);assert.equal((await f.sink.getRun('owner','r')).status,'cancelled');
  await f.state.historyOutbox.acknowledge(old);assert.equal((await f.state.historyOutbox.status()).pendingCount,1);
  await Promise.all([a.drain(),f.worker.drain()]);assert.equal((await f.state.historyOutbox.status()).pendingCount,0);
 }finally{await f.worker.close();await f.state.close();}});
test('delete tombstones defeat late results, late acknowledgement, and attempted resurrection',async()=>{
 const f=await fixture();try{
  await admit(f.state);const old=await f.state.historyOutbox.pending(100);await f.state.records.remove('runs',{id:'r'});await f.state.records.remove('conversations',{id:'c'});
  const deletions=await f.state.historyOutbox.pending(100);assert.ok(deletions.every(t=>t.deleted));await f.sink.writeBatch(f.namespace,deletions);await f.sink.writeBatch(f.namespace,old);
  await f.sink.writeBatch(f.namespace,old.map(t=>({...t,version:999})));assert.equal((await f.sink.listConversations('owner')).conversations.length,0);assert.equal(await f.sink.getRun('owner','r'),undefined);
  await f.state.historyOutbox.acknowledge(old);assert.equal((await f.state.historyOutbox.status()).pendingCount,2);await f.state.historyOutbox.acknowledge(deletions);assert.equal((await f.state.historyOutbox.status()).pendingCount,0);
 }finally{await f.worker.close();await f.state.close();}});
test('pending tasks, retry attempts and backoff persist across process restart and recover',async()=>{
 const f=await fixture();try{
  await admit(f.state);await f.state.historyOutbox.retry(await f.state.historyOutbox.pending(100),'TiDB offline',100);
  const code=`import {RedisRuntimeRecords} from './packages/agentloop/src/storage/redis-runtime-records.ts';import {RuntimeRedisClient} from './packages/agentloop/src/storage/runtime-redis-client.ts';const s=await RedisRuntimeRecords.open(new RuntimeRedisClient(${JSON.stringify(url)}),{prefix:${JSON.stringify(f.namespace)}});const tasks=await s.historyOutbox.pending(100,Date.now()+1000);console.log(JSON.stringify({count:tasks.length,attempts:tasks[0].attempts,error:tasks[0].error}));await s.close();`;
  const cp=spawn(process.execPath,['--input-type=module','-e',code],{cwd:join(import.meta.dirname,'../../..'),stdio:['ignore','pipe','pipe']});let stdout='';cp.stdout!.on('data',v=>stdout+=v);await new Promise<void>((resolve,reject)=>cp.once('exit',code=>code===0?resolve():reject(new Error('Restart child failed'))));assert.deepEqual(JSON.parse(stdout),{count:2,attempts:1,error:'TiDB offline'});
  await f.state.historyOutbox.retry(await f.state.historyOutbox.pending(100,Date.now()+1000),'retry now',0);await f.worker.drain();assert.equal((await f.state.historyOutbox.status()).pendingCount,0);
 }finally{await f.worker.close();await f.state.close();}});
test('stable cursor pages isolate owners and preserve ties',async()=>{
 const f=await fixture();try{
  for(let i=0;i<7;i++)await f.state.records.insert('conversations',{id:`c${i}`,owner_user_id:'owner',title:`${i}`,created_at:1,updated_at:1});await f.worker.drain();
  const seen=[];let cursor:string|undefined;do{const p=await f.sink.listConversations('owner',{limit:2,cursor});seen.push(...p.conversations.map(c=>c.id));cursor=p.nextCursor;}while(cursor);assert.equal(new Set(seen).size,7);assert.equal(seen.length,7);
 }finally{await f.worker.close();await f.state.close();}});

test('terminal process reads verified archive after Redis eviction/gaps; corruption is explicit',async()=>{
 const f=await fixture();const archive=new FileRuntimeArchiveStore(join(directory,randomUUID()));
 const maintenance=new RuntimeRecordMaintenance({state:f.state,namespace:f.namespace,archive});
 try {
  await admit(f.state);
  for(let i=0;i<3;i++)await appendRunEvent(f.state,'r',{type:'fixture',data:{i},createdAt:3+i});
  await f.state.records.insert('run_outcomes',{run_id:'r',plan_id:null,status:'completed',reason_code:'fixture',output:'done',committed_at:6});
  await f.state.records.update('runs',{id:'r'},()=>({status:'completed',output:'done',finished_at:6}));
  await maintenance.archiveNow();await f.worker.drain();
  const facade={records:f.state.records,eventPage:async()=>[]};
  const view=new RuntimeHistoryView(facade as any,f.sink,{} as any,archive);
  assert.deepEqual((await view.eventsAfter('owner','r',0)).map(e=>e.seq),[1,2,3]);
  assert.deepEqual((await view.eventsAfter('owner','r',1)).map(e=>e.seq),[2,3]);
  const broken={put:archive.put.bind(archive),get:async()=>Buffer.from('corrupt')};
  await assert.rejects(new RuntimeHistoryView(facade as any,f.sink,{} as any,broken).eventsAfter('owner','r',0),/checksum mismatch/);
 }finally{await maintenance.close();await f.worker.close();await f.state.close();}
});

test('immutable metadata payload preserves nested empty arrays through Lua, retry and SQL',async()=>{
 const f=await fixture();try{
  await admit(f.state);
  const payload={id:'a',path:'a.csv',sha256:'a'.repeat(64),bytes:3,verification:{targetIds:[],limitations:[]}};
  await f.state.historyOutbox.publish({objectId:'artifact:r:a',kind:'artifacts',deleted:false,ownerId:'owner',conversationId:'c',runId:'r',planId:'',payload});
  let tasks=await f.state.historyOutbox.pending(100);assert.deepEqual(tasks.find(t=>t.kind==='artifacts')!.payload,payload);
  await f.state.historyOutbox.retry(tasks,'offline',1);tasks=await f.state.historyOutbox.pending(100,Date.now()+100);
  assert.deepEqual(tasks.find(t=>t.kind==='artifacts')!.payload,payload);
  await f.sink.writeBatch(f.namespace,tasks);assert.deepEqual((await f.sink.getRun('owner','r'))!.artifacts![0].verification,{targetIds:[],limitations:[]});
 }finally{await f.worker.close();await f.state.close();}
});
