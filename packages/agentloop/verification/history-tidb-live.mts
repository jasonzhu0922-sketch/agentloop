import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile,mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { connectRuntimeHistory,createRuntimeHistory } from '../src/storage/runtime-history-factory.ts';
import { SqlRuntimeHistoryStore,RuntimeHistoryWorker } from '../src/storage/runtime-history.ts';
import { RedisRuntimeRecords } from '../src/storage/redis-runtime-records.ts';
import { RuntimeRedisClient } from '../src/storage/runtime-redis-client.ts';
import { RunService } from '../src/runtime/run-service.ts';
import { SkillService } from '../src/skills/skill-service.ts';
import { AppDatabase } from '../src/storage/database.ts';
import { singleStepTestPlanner,approvingTestAssessor,TEST_MODEL_LIMITS } from '../tests/runtime-test-helpers.ts';
import { RuntimeRecordMaintenance,FileRuntimeArchiveStore } from '../src/storage/runtime-record-maintenance.ts';
const original=process.env.DATA_AGENT_HISTORY_TIDB_URL??process.env.DATA_AGENT_TIDB_URL!;
const control=await connectRuntimeHistory({url:original,timeoutMs:5000});
const database=`agentloop_history_verify_${Date.now()}`;
await control.exec(`CREATE DATABASE ${database}`);await control.close();
const parsed=new URL(original);parsed.pathname=`/${database}`;const config={url:parsed.toString(),timeoutMs:1000,connectionLimit:2};
const directory=await mkdtemp(join(tmpdir(),'history-live-'));
const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as any).port;await new Promise<void>(r=>reserve.close(()=>r()));
const child=spawn('redis-server',['--bind','127.0.0.1','--port',String(port),'--dir',directory,'--appendonly','yes','--appendfsync','always','--maxmemory-policy','noeviction','--save',''],{stdio:['ignore','pipe','pipe']});
await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.stdout!.on('data',d=>{if(String(d).includes('Ready to accept connections'))resolve();});});
const redisUrl=`redis://127.0.0.1:${port}`,report:any={database,scenarios:[],checks:[]};
try{
 for(const mode of ['normal','slow','unavailable']){
  await mkdir(join(directory,mode,'workspace'),{recursive:true});
  const namespace=`verify:{${randomUUID()}}`,state=await RedisRuntimeRecords.open(new RuntimeRedisClient(redisUrl),{prefix:namespace});
  const archive=new FileRuntimeArchiveStore(join(directory,mode,'archives'));
  const sink=new SqlRuntimeHistoryStore({namespace,connect:()=>connectRuntimeHistory(config),content:archive});
  let blocked=mode==='unavailable',errors=0;
  let totalProjectionMs=0,projectedObjects=0;const projectionLatencies:number[]=[];
  const proxy={writeBatch:async(ns,updates)=>{const start=performance.now();
    if(mode==='slow')await new Promise(r=>setTimeout(r,350));
    if(blocked){const offline=await connectRuntimeHistory({url:'mysql://nobody@127.0.0.1:1/offline',timeoutMs:100});try{await offline.prepare('SELECT 1').get();}finally{await offline.close();}}
    await sink.writeBatch(ns,updates);totalProjectionMs+=performance.now()-start;projectedObjects+=updates.length;projectionLatencies.push(...updates.map(task=>Date.now()-task.pendingAt));
  }};
  const worker=new RuntimeHistoryWorker({namespace,outbox:state.historyOutbox,sink:proxy,batchSize:100,intervalMs:10,retryBaseMs:10,retryMaxMs:50,onError:()=>errors++});
  const maintenance=new RuntimeRecordMaintenance({state,namespace,archive});
  const catalogue=new AppDatabase(join(directory,mode,'catalogue.sqlite'));await catalogue.ready();
  let effects=0;
  const service=new RunService({database:state,skills:new SkillService(catalogue),workspaceRoot:join(directory,mode,'workspace'),plannerFactory:singleStepTestPlanner,assessorFactory:approvingTestAssessor,
    tools:[{name:'fixture',description:'Read test value',inputSchema:{type:'object'},executionMode:'parallel',replaySafe:true,parse:v=>v,execute:async()=>{effects++;return {value:42};}}],
    modelFactory:()=>{let turns=0;return {limits:TEST_MODEL_LIMITS,complete:async()=>({content:'Fixture value 42.',finishReason:'stop',toolCalls:[]}),streamComplete:async(_request,sink)=>{
      if(++turns!==1)return {content:'Fixture value 42.',finishReason:'stop',toolCalls:[]};
      const call={id:randomUUID(),name:'fixture',arguments:{}};await sink({type:'tool_call_ready',index:0,...call});
      await Promise.all(Array.from({length:8},()=>sink({type:'text_delta',text:' '})));
      return {content:'',finishReason:'tool_calls',toolCalls:[call]};
    }};}});
  const durations:number[]=[],created:any[]=[];
  worker.start();maintenance.start(20);
  const began=performance.now();
  for(let batch=0;batch<4;batch++)await Promise.all(Array.from({length:4},async()=>{
    const id=randomUUID();await service.ensureConversation('owner',id,'fixture tool query');
    const start=performance.now(),run=await service.execute('owner','Read fixture tool then answer.',{conversationId:id});durations.push(performance.now()-start);assert.equal(run.status,'completed');created.push(run);
  }));
  const elapsed=performance.now()-began;await maintenance.archiveNow();await maintenance.archiveNow();
  const backlog=await state.historyOutbox.status(),archived=maintenance.status();assert.ok(archived.archivedRuns>0);assert.equal(effects,16);
  if(blocked){assert.ok(Number(backlog.pendingCount)>0);assert.ok(errors>0);}
  blocked=false;const drainStart=performance.now();
  for(let i=0;i<1000&&Number((await state.historyOutbox.status()).pendingCount)>0;i++){await worker.drain();await new Promise(r=>setTimeout(r,10));}
  const final=await state.historyOutbox.status();projectionLatencies.sort((a,b)=>a-b);assert.equal(final.pendingCount,0);
  const history=await sink.listConversations('owner',{limit:50});assert.equal(history.conversations.length,16);
  for(const run of created){const saved=await sink.getRun('owner',run.id);assert.equal(saved.status,'completed');assert.ok(saved.plans.length);assert.ok(saved.steps.length);assert.ok(saved.outcome);assert.ok(saved.archives.length);}
  durations.sort((a,b)=>a-b);report.scenarios.push({mode,runs:16,tools:effects,runThroughputPerSecond:16/(elapsed/1000),runP50Ms:durations[8],runP95Ms:durations[15],elapsedMs:elapsed,backlogAtExecutionEnd:backlog,archiveStatus:archived,drainMs:performance.now()-drainStart,final,errors,projectedObjects,sqlActiveMs:totalProjectionMs,projectionObjectsPerSecond:projectedObjects/(totalProjectionMs/1000),projectionP50Ms:projectionLatencies[Math.floor(projectionLatencies.length*.5)],projectionP95Ms:projectionLatencies[Math.floor(projectionLatencies.length*.95)]});
  await worker.close();await maintenance.close();await service.closeRunEvents();await state.close();await catalogue.close();await sink.close();
 }
 // Real SQL transport timeout: destroy a sleeping client and reconnect through the same bounded pool.
 const db=await connectRuntimeHistory({...config,timeoutMs:150});let timedOut=false;const began=performance.now();
 try{await db.prepare('SELECT SLEEP(2)').get();}catch{timedOut=true;}assert.ok(timedOut);report.checks.push({check:'real TiDB timeout',elapsedMs:performance.now()-began});assert.ok(await db.prepare('SELECT 1 AS ok').get());await db.close();
 // A completely unreachable TiDB must not be contacted by assembly or admission.
 const state=await RedisRuntimeRecords.open(new RuntimeRedisClient(redisUrl),{prefix:`offline:{${randomUUID()}}`});
 const start=performance.now();const history=createRuntimeHistory({state,namespace:'offline',config:{url:'mysql://nobody@127.0.0.1:1/offline',timeoutMs:100,intervalMs:10,retryBaseMs:10,retryMaxMs:20},onError:()=>{}});history.worker!.start();
 await state.records.insert('runs',{id:'offline',owner_user_id:'owner',depth:0,status:'running',input:'offline',created_at:Date.now()});await state.records.update('runs',{id:'offline'},()=>({status:'completed',finished_at:Date.now(),output:'done'}));
 report.checks.push({check:'unreachable TiDB assembly/admission/terminal',elapsedMs:performance.now()-start});await history.close();await state.close();
 const dbcheck=await connectRuntimeHistory(config);const kinds=await dbcheck.prepare('SELECT kind,COUNT(*) AS count FROM runtime_history_objects GROUP BY kind').all();report.kinds=kinds;await dbcheck.close();
}finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
await mkdir('packages/agentloop/verification/history',{recursive:true});await writeFile('packages/agentloop/verification/history/tidb-performance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
