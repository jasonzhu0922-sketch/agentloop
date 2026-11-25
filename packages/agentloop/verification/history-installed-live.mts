import assert from 'node:assert/strict';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { randomUUID,createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { connectRuntimeHistory } from '../src/storage/runtime-history-factory.ts';
import { RedisRuntimeRecords } from '../src/storage/redis-runtime-records.ts';
import { RuntimeRedisClient } from '../src/storage/runtime-redis-client.ts';
const origin=process.env.DATA_AGENT_TEST_ORIGIN??'http://127.0.0.1:8810';
const root=await fetch(origin);assert.equal(root.status,200);const cookie=root.headers.get('set-cookie')!.split(';')[0];
const api=async(path:string,body?:any)=>{const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw new Error(`HTTP ${response.status}: ${data.error}`);return data;};
const config=await api('/api/config'),conversationId=randomUUID();
const {run}=await api('/api/messages',{requestId:randomUUID(),conversationId,modelKey:config.defaultModelKey,input:'请做一次不访问业务数据库的运行链路验证：必须先调用 load_skill 加载 data-analysis，仅阅读 Skill 说明，随后用一句中文确认说明已加载。不要查询业务目录或数据，不要调用其他业务动作，不要提出澄清问题。'});
console.log(JSON.stringify({acceptedRun:run.id,conversationId}));
const state=await RedisRuntimeRecords.open(new RuntimeRedisClient(process.env.DATA_AGENT_REDIS_URL!),{prefix:process.env.DATA_AGENT_REDIS_STATE_PREFIX!});
let events:any[]=[];
try{
 const until=Date.now()+180000;
 while(Date.now()<until){const current=(await state.records.find('runs',{id:run.id}))[0];if(current?.status!=='running')break;await new Promise(r=>setTimeout(r,400));}
 const current=(await state.records.find('runs',{id:run.id}))[0];
 events=(await state.records.find('run_events',{run_id:run.id})).sort((a,b)=>a.seq-b.seq);assert.equal(current.status,'completed',JSON.stringify({status:current.status,error:current.error_code,failures:events.filter(e=>/failed/.test(e.type)).map(e=>e.type)}));
 const completed=events.filter(e=>e.type==='tool.completed').map(e=>JSON.parse(e.payload_json));assert.ok(completed.some(e=>e.toolName==='load_skill'));
 assert.equal(events.some(e=>e.type==='model.request.failed'),false);assert.deepEqual(events.map(e=>e.seq),events.map((_,i)=>i+1));
 const actions=await state.records.find('runtime_actions',{run_id:run.id});assert.ok(actions.every(action=>action.state==='succeeded'));
 let snapshot:any,page:any;
 for(let i=0;i<120;i++){try{snapshot=await api(`/api/runs/${run.id}?after=0`);page=await api('/api/conversations?limit=50');if(snapshot.dataSource==='history' && snapshot.run.archives.length && page.conversations.some(c=>c.id===conversationId))break;}catch{}await new Promise(r=>setTimeout(r,250));}
 assert.equal(snapshot.dataSource,'history');assert.equal(snapshot.run.dataSource,'history');assert.equal(page.source,'tidb');assert.ok(page.conversations.some(c=>c.id===conversationId));assert.ok(snapshot.run.plans.length);assert.ok(snapshot.run.outcome);assert.ok(snapshot.run.archives.length);
 const db=await connectRuntimeHistory({url:process.env.DATA_AGENT_HISTORY_TIDB_URL??process.env.DATA_AGENT_RUNTIME_SUMMARY_TIDB_URL??process.env.DATA_AGENT_TIDB_URL!,timeoutMs:3000});
 const counts=await db.prepare('SELECT kind,COUNT(*) AS count FROM runtime_history_objects WHERE namespace=? AND (run_id=? OR entity_id=?) GROUP BY kind').all(process.env.DATA_AGENT_REDIS_STATE_PREFIX!,run.id,conversationId);await db.close();
 const packageJson=JSON.parse(await readFile('/Users/zhujun/coding/data-agent/package.json','utf8')),packagePath=resolve('/Users/zhujun/coding/data-agent',packageJson.dependencies['@zhujun/agentloop'].slice(5));
 const report={runId:run.id,conversationId,status:current.status,toolNames:completed.map(e=>e.toolName),actionCount:actions.length,events:events.length,streamEvents:events.filter(e=>/stream|streaming/.test(e.type)).length,contiguousEvents:true,historySource:page.source,runSource:snapshot.dataSource,historyKinds:counts,archives:snapshot.run.archives.length,usage:snapshot.run.usage,historyStatus:await api('/api/history/status'),packageSha256:createHash('sha256').update(await readFile(packagePath)).digest('hex')};
 await mkdir('packages/agentloop/verification/history',{recursive:true});await writeFile('packages/agentloop/verification/history/installed-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await state.close();}
