import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdir,writeFile,mkdtemp,readFile } from 'node:fs/promises';
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
const database=`agentloop_history_artifact_${Date.now()}`;
await control.exec(`CREATE DATABASE ${database}`);await control.close();
const parsed=new URL(original);parsed.pathname=`/${database}`;const config={url:parsed.toString(),timeoutMs:1000,connectionLimit:2};
const directory=await mkdtemp(join(tmpdir(),'history-live-'));
const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as any).port;await new Promise<void>(r=>reserve.close(()=>r()));
const child=spawn('redis-server',['--bind','127.0.0.1','--port',String(port),'--dir',directory,'--appendonly','yes','--appendfsync','always','--maxmemory-policy','noeviction','--save',''],{stdio:['ignore','pipe','pipe']});
await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.stdout!.on('data',d=>{if(String(d).includes('Ready to accept connections'))resolve();});});
const redisUrl=`redis://127.0.0.1:${port}`,report:any={database,scenarios:[],checks:[]};
try {
 const namespace=`artifact:{${randomUUID()}}`,state=await RedisRuntimeRecords.open(new RuntimeRedisClient(redisUrl),{prefix:namespace});
 const workspace=join(directory,'workspace');await mkdir(workspace,{recursive:true});
 const archive=new FileRuntimeArchiveStore(join(directory,'archives'));
 const history=createRuntimeHistory({state,namespace,config:{...config,intervalMs:20},content:archive,onError:error=>{throw error;}});
 const catalogue=new AppDatabase(join(directory,'catalogue.sqlite'));await catalogue.ready();
 const content='name,value\nfixture,42\n',path='evidence.csv';let turns=0;
 const service=new RunService({database:state,skills:new SkillService(catalogue),workspaceRoot:workspace,plannerFactory:singleStepTestPlanner,assessorFactory:approvingTestAssessor,
  modelFactory:()=>({limits:TEST_MODEL_LIMITS,complete:async()=>++turns===1?{content:'',finishReason:'tool_calls',toolCalls:[{id:randomUUID(),name:'computer_write_file',arguments:{path,content}}]}:{content:'Wrote support evidence; fixture value is 42.',finishReason:'stop',toolCalls:[]}})});
 const maintenance=new RuntimeRecordMaintenance({state,namespace,archive,artifacts:id=>service.processArtifacts('owner',id),artifactContent:async artifact=>(await service.readProcessArtifact('owner',artifact.runId,artifact.id)).content});
 try {
  const conversationId=randomUUID();await service.ensureConversation('owner',conversationId,'history file fixture');
  const run=await service.execute('owner','Use computer_write_file to write the supporting CSV evidence.csv, then answer fixture value 42 in chat. This is a supporting process file, not a requested final deliverable.',{conversationId,allowDangerousTools:true});
  assert.equal(run.status,'completed');assert.ok((await service.events('owner',run.id)).some(e=>e.type==='tool.completed'&&e.data.toolName==='computer_write_file'&&!e.data.isError));
  await maintenance.archiveNow();await history.worker!.drain();
  const saved=await history.reader.getRun('owner',run.id);assert.ok(saved?.artifacts?.length);
  const artifact=saved!.artifacts!.find(a=>a.path===path)!;assert.equal(artifact.storageKind,'archive');assert.equal(artifact.bytes,Buffer.byteLength(content));assert.equal(artifact.sha256,createHash('sha256').update(content).digest('hex'));
  const {RuntimeHistoryView}=await import('../src/storage/runtime-history-view.ts');
  const view=new RuntimeHistoryView(state,history.reader,service,archive);
  // Mutation of the original workspace cannot change the immutable download.
  await writeFile(join(workspace,path),'changed workspace');
  const download=await view.readProcessArtifact('owner',run.id,artifact.id);assert.equal(download.content.toString(),content);
  assert.equal((await view.previewProcessArtifact('owner',run.id,artifact.id)).kind,'text');
  report.runId=run.id;report.status=run.status;report.tool='computer_write_file';report.artifact=artifact;report.checks=['real tool wrote bytes','TiDB stores name/type/size/checksum/stable immutable reference','history download and preview survive workspace mutation','complete process archive confirmed'];report.outbox=await state.historyOutbox.status();
 }finally{await maintenance.close();await history.close();await service.closeRunEvents();await state.close();await catalogue.close();}
}finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
await mkdir('packages/agentloop/verification/history',{recursive:true});await writeFile('packages/agentloop/verification/history/tidb-artifact.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
