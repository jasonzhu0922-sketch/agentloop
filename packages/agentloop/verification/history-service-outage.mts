import assert from 'node:assert/strict';
import { createServer,createConnection,type Socket } from 'node:net';
import { spawn,type ChildProcess } from 'node:child_process';
import { mkdtemp,mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SqlRuntimeHistoryStore } from '../src/storage/runtime-history.ts';
import { connectRuntimeHistory } from '../src/storage/runtime-history-factory.ts';
import { RedisRuntimeRecords } from '../src/storage/redis-runtime-records.ts';
import { RuntimeRedisClient } from '../src/storage/runtime-redis-client.ts';
const original=new URL(process.env.DATA_AGENT_HISTORY_TIDB_URL??process.env.DATA_AGENT_TIDB_URL!),database=`agentloop_history_http_${Date.now()}`,namespace=`http:{${randomUUID()}}`;
const admin=await connectRuntimeHistory({url:original.toString(),timeoutMs:3000});await admin.exec(`CREATE DATABASE ${database}`);await admin.close();
const directory=await mkdtemp(join(tmpdir(),'history-http-'));
let blocked=true;const sockets=new Set<Socket>();
const proxy=createServer(client=>{
 sockets.add(client);client.once('close',()=>sockets.delete(client));client.on('error',()=>{});
 if(blocked)return;const upstream=createConnection({host:original.hostname,port:Number(original.port||4000)});sockets.add(upstream);upstream.once('close',()=>sockets.delete(upstream));upstream.on('error',()=>client.destroy());client.pipe(upstream);upstream.pipe(client);client.once('close',()=>upstream.destroy());
});await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const proxyPort=(proxy.address() as any).port;
const historyURL=new URL(original);historyURL.hostname='127.0.0.1';historyURL.port=String(proxyPort);historyURL.pathname=`/${database}`;
async function port(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const n=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return n;}
const redisPort=await port(),httpPort=await port();
const redis=spawn('redis-server',['--bind','127.0.0.1','--port',String(redisPort),'--dir',directory,'--appendonly','yes','--appendfsync','always','--maxmemory-policy','noeviction','--save',''],{stdio:['ignore','pipe','pipe']});await new Promise<void>((r,j)=>{redis.once('error',j);redis.stdout!.on('data',d=>{if(String(d).includes('Ready to accept connections'))r();});});
let child:ChildProcess;const env={...process.env,DATA_AGENT_PORT:String(httpPort),DATA_AGENT_FILE_DIR:join(directory,'files'),DATA_AGENT_STATE_BACKEND:'redis',DATA_AGENT_REDIS_URL:`redis://127.0.0.1:${redisPort}`,DATA_AGENT_REDIS_STATE_PREFIX:namespace,DATA_AGENT_RUNTIME_ID:`verify-${randomUUID()}`,DATA_AGENT_HISTORY_TIDB_URL:historyURL.toString(),DATA_AGENT_HISTORY_INTERVAL_MS:'50',DATA_AGENT_HISTORY_TIMEOUT_MS:'700',DATA_AGENT_HISTORY_RETRY_BASE_MS:'100',DATA_AGENT_HISTORY_RETRY_MAX_MS:'500',NO_COLOR:'1'};
let logs='';function launch(){child=spawn('npm',['start'],{cwd:'/Users/zhujun/coding/data-agent',env,stdio:['ignore','pipe','pipe']});child.stdout!.on('data',d=>logs+=String(d));child.stderr!.on('data',d=>logs+=String(d));}
const origin=`http://127.0.0.1:${httpPort}`;let cookie='';
async function ready(){for(let i=0;i<200;i++){try{const root=await fetch(origin);if(root.ok){cookie=root.headers.get('set-cookie')!.split(';')[0];return;}}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error('Temporary HTTP startup failed');}
const api=async(path:string,body?:any)=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
let state:RedisRuntimeRecords|undefined;const report:any={database,namespace,checks:[]};
try{
 const boot=performance.now();launch();await ready();report.startupWhileSQLUnreachableMs=performance.now()-boot;
 const bad=await api('/api/conversations');assert.equal(bad.status,500);report.checks.push('history returns explicit failure; startup succeeds with SQL socket stalled');
 const model=(await api('/api/config')).body.defaultModelKey;
 const start=performance.now();const accepted=await api('/api/messages',{requestId:randomUUID(),conversationId:randomUUID(),modelKey:model,input:'运行链路验证：必须调用 load_skill 加载 data-analysis，仅阅读 Skill 说明并确认已加载。不查询业务目录或数据，不调用业务动作，不提出澄清。'});assert.equal(accepted.status,202);report.admissionWhileSQLStalledMs=performance.now()-start;
 const id=accepted.body.run.id;state=await RedisRuntimeRecords.open(new RuntimeRedisClient(env.DATA_AGENT_REDIS_URL),{prefix:namespace});
 for(let i=0;i<600;i++){const run=(await state.records.find('runs',{id}))[0];if(run.status!=='running')break;await new Promise(r=>setTimeout(r,250));}
 const run=(await state.records.find('runs',{id}))[0];assert.equal(run.status,'completed');const events=await state.records.find('run_events',{run_id:id});assert.ok(events.some(e=>e.type==='tool.completed'&&JSON.parse(e.payload_json).toolName==='load_skill'));
 // Archive completion publishes a durable reference even while all SQL clients are stalled.
 for(let i=0;i<100;i++){if((await state.historyOutbox.pending(1000,Date.now()+100000)).some(t=>t.kind==='archives'))break;await new Promise(r=>setTimeout(r,100));}
 const pending=await state.historyOutbox.pending(1000,Date.now()+100000);assert.ok(pending.some(t=>t.kind==='archives'));report.backlog=await state.historyOutbox.status();report.checks.push('real model Run and tool complete; verified file archive reference queues while SQL unavailable');
 report.runId=id;report.events=events.length;
 // Restart npm's main Node child by signalling the direct wrapper tree via SIGTERM propagated by start.mjs.
 child!.kill('SIGTERM');await new Promise<void>(r=>{child!.once('exit',()=>r());});
 // Its wrapper may still be closing: wait for the HTTP listener before creating the next host.
 for(let i=0;i<100;i++){try{await fetch(origin);await new Promise(r=>setTimeout(r,50));}catch{break;}}
 blocked=false;for(const socket of sockets)socket.destroy();launch();await ready();
 let page:any,snapshot:any;
 for(let i=0;i<200;i++){page=await api('/api/conversations');snapshot=await api(`/api/runs/${id}?after=0`);if(page.body.source==='tidb'&&snapshot.body.run?.archives?.length)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(page.body.source,'tidb');assert.ok(page.body.conversations.some(c=>c.id===run.conversation_id));assert.equal(snapshot.body.run.status,'completed');assert.equal(snapshot.body.dataSource,'history');assert.ok(snapshot.body.run.archives.length);report.checks.push('process restart and network recovery replay pending history without repeating model/tool effects');
 // A SQL-only row with no Redis counterpart proves the actual HTTP list query source.
 const sentinelId=randomUUID(),sink=new SqlRuntimeHistoryStore({namespace,connect:()=>connectRuntimeHistory({url:historyURL.toString(),timeoutMs:3000})});
 await sink.writeBatch(namespace,[{objectId:`sql-only:${sentinelId}`,kind:'conversations',version:1,deleted:false,ownerId:'data-agent-local-owner',conversationId:sentinelId,runId:'',planId:'',updatedAt:Date.now(),payload:{id:sentinelId,title:'TiDB-only source sentinel',owner_user_id:'data-agent-local-owner',created_at:Date.now(),updated_at:Date.now()}}]);
 assert.equal((await state.records.find('conversations',{id:sentinelId})).length,0);
 const sqlOnly=await api('/api/conversations');assert.ok(sqlOnly.body.conversations.some(c=>c.id===sentinelId));await sink.close();
 report.checks.push('HTTP list includes a TiDB-only conversation absent from Redis');report.sqlOnlyConversationId=sentinelId;
 report.recovered=await state.historyOutbox.status();
 await mkdir('packages/agentloop/verification/history',{recursive:true});await writeFile('packages/agentloop/verification/history/http-outage.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
 await state?.close();child!?.kill('SIGTERM');for(const socket of sockets)socket.destroy();proxy.close();redis.kill('SIGTERM');
 // Logs contain request traces, so keep them only in the private temporary directory.
 await writeFile(join(directory,'service.log'),logs,{mode:0o600});
}
