import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdtemp,writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { connectRuntimeHistory } from '../src/storage/runtime-history-factory.ts';
import { RuntimeHistoryWorker,SqlRuntimeHistoryStore } from '../src/storage/runtime-history.ts';
import { RedisRuntimeRecords } from '../src/storage/redis-runtime-records.ts';
import { RuntimeRedisClient } from '../src/storage/runtime-redis-client.ts';
import { FileRuntimeArchiveStore } from '../src/storage/runtime-record-maintenance.ts';
const original=process.env.DATA_AGENT_HISTORY_TIDB_URL??process.env.DATA_AGENT_TIDB_URL!,database=`agentloop_history_faults_${Date.now()}`;
const admin=await connectRuntimeHistory({url:original,timeoutMs:3000});await admin.exec(`CREATE DATABASE ${database}`);await admin.close();
const parsed=new URL(original);parsed.pathname=`/${database}`;const config={url:parsed.toString(),timeoutMs:500};
const directory=await mkdtemp(join(tmpdir(),'history-faults-')),namespace=`faults:{${randomUUID()}}`;
const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;await new Promise<void>(r=>server.close(()=>r()));
const child=spawn('redis-server',['--bind','127.0.0.1','--port',String(port),'--dir',directory,'--appendonly','yes','--appendfsync','always','--maxmemory-policy','noeviction','--save',''],{stdio:['ignore','pipe','pipe']});
await new Promise<void>((r,j)=>{child.once('error',j);child.stdout!.on('data',d=>{if(String(d).includes('Ready to accept connections'))r();});});
let state=await RedisRuntimeRecords.open(new RuntimeRedisClient(`redis://127.0.0.1:${port}`),{prefix:namespace});
const store=new SqlRuntimeHistoryStore({namespace,connect:()=>connectRuntimeHistory(config),content:new FileRuntimeArchiveStore(join(directory,'content'))});
const checks:any[]=[];
try{
 await state.transaction(async()=>{
  await state.records.insert('conversations',{id:'c',owner_user_id:'owner',title:'TiDB race fixture',created_at:1,updated_at:1});
  await state.records.insert('runs',{id:'r',owner_user_id:'owner',conversation_id:'c',depth:0,input:'fixture',status:'running',created_at:1});
 });
 const old=await state.historyOutbox.pending(100);let lost=true;
 const worker=new RuntimeHistoryWorker({namespace,outbox:state.historyOutbox,sink:{writeBatch:async(ns,tasks)=>{await store.writeBatch(ns,tasks);if(lost){lost=false;throw new Error('simulated lost SQL commit response');}}},retryBaseMs:1,retryMaxMs:1});
 await worker.drain();assert.equal((await state.historyOutbox.status()).pendingCount,2);checks.push('SQL committed but response lost: tasks retained');
 await state.records.update('runs',{id:'r'},()=>({status:'failed',output:'valid partial',finished_at:2}));
 const latest=await state.historyOutbox.pending(100,Date.now()+100);await store.writeBatch(namespace,latest);await store.writeBatch(namespace,old);assert.equal((await store.getRun('owner','r')).status,'failed');checks.push('old running projection cannot overwrite terminal');
 await state.historyOutbox.acknowledge(old);assert.equal((await state.historyOutbox.status()).pendingCount,1);checks.push('old confirmation cannot delete newer pending task');
 const second=new RuntimeHistoryWorker({namespace,outbox:state.historyOutbox,sink:store});await Promise.all([worker.drain(),second.drain()]);assert.equal((await state.historyOutbox.status()).pendingCount,0);checks.push('duplicate workers complete idempotently');
 await state.records.insert('run_outcomes',{run_id:'r',status:'failed',reason_code:'fixture',committed_at:2,result_json:JSON.stringify({partial:'x'.repeat(100000)})});
 const large=await state.historyOutbox.pending(100);await store.writeBatch(namespace,large);await state.historyOutbox.acknowledge(large);const content=await store.getRun('owner','r');assert.equal(JSON.parse(content.outcome.result_json).partial.length,100000);
 const sql=await connectRuntimeHistory(config);const stored=await sql.prepare("SELECT payload_json FROM runtime_history_objects WHERE kind='run_outcomes'").get<any>();assert.ok(JSON.parse(stored.payload_json).contentRef);await sql.close();checks.push('large partial Result stored as verified file and hydrated by reader');
 await state.records.remove('runs',{id:'r'});await state.records.remove('conversations',{id:'c'});const deleted=await state.historyOutbox.pending(100);await store.writeBatch(namespace,deleted);await store.writeBatch(namespace,old);await store.writeBatch(namespace,latest.map(t=>({...t,version:999})));
 assert.equal(await store.getRun('owner','r'),undefined);assert.equal((await store.listConversations('owner')).conversations.length,0);checks.push('TiDB version tombstone defeats late delete race and resurrection');
 await state.close();state=await RedisRuntimeRecords.open(new RuntimeRedisClient(`redis://127.0.0.1:${port}`),{prefix:namespace});assert.ok((await state.historyOutbox.pending(100)).every(t=>t.deleted));
 const recovered=new RuntimeHistoryWorker({namespace,outbox:state.historyOutbox,sink:store});await recovered.drain();assert.equal((await state.historyOutbox.status()).pendingCount,0);checks.push('Redis reconnect continues durable unconfirmed deletes');
 // Real transport refusal and recovery with the same history store instance, including failed schema initialization.
 let offline=true;const retryStore=new SqlRuntimeHistoryStore({namespace:'retry',connect:()=>connectRuntimeHistory(offline?{url:'mysql://nobody@127.0.0.1:1/offline',timeoutMs:100}:config)});
 await assert.rejects(retryStore.listConversations('owner'));offline=false;assert.equal((await retryStore.listConversations('owner')).conversations.length,0);await retryStore.close();checks.push('unreachable SQL initialization retries successfully after recovery');
 await worker.close();await store.close();
}finally{await state.close();child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
const report={database,checks};await mkdir('packages/agentloop/verification/history',{recursive:true});await writeFile('packages/agentloop/verification/history/tidb-faults.json',JSON.stringify(report,null,2));console.log(report);
