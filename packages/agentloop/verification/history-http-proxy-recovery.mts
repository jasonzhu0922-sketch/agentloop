import assert from 'node:assert/strict';
import { createServer,createConnection,type Socket } from 'node:net';
import { spawn,type ChildProcess } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,access } from 'node:fs/promises';
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
const report:any={database,namespace};let state:RedisRuntimeRecords|undefined;
const exists=async name=>access(join(directory,name)).then(()=>true,()=>false);
try {
 launch();await ready();state=await RedisRuntimeRecords.open(new RuntimeRedisClient(env.DATA_AGENT_REDIS_URL),{prefix:namespace});
 await writeFile('/tmp/agentloop-history-proxy-control.json',JSON.stringify({origin,directory}));console.log(JSON.stringify({origin,directory,ready:true}));
 const deadline=Date.now()+600000;
 while(!await exists('recover')) {if(Date.now()>deadline)throw new Error('HTTP proxy verification timeout');await new Promise(r=>setTimeout(r,100));}
 blocked=false;for(const socket of sockets)socket.destroy();
 while(!await exists('stop')){if(Date.now()>deadline)throw new Error('HTTP proxy verification timeout');await new Promise(r=>setTimeout(r,100));}
 const rows=await state.records.find('runs',{parent_run_id:null});assert.equal(rows.length,1);assert.equal(rows[0].status,'completed');
 const events=await state.records.find('run_events',{run_id:rows[0].id});assert.ok(events.some(e=>e.type==='tool.completed'&&JSON.parse(e.payload_json).toolName==='load_skill'));
 const page=await api('/api/conversations');assert.equal(page.body.source,'tidb');assert.equal(page.body.conversations.length,1);
 report.runId=rows[0].id;report.events=events.length;report.historyStatus=await state.historyOutbox.status();report.historySource=page.body.source;report.conversations=page.body.conversations.length;report.tool='load_skill';
 await writeFile('packages/agentloop/verification/history/http-proxy-recovery.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
 await state?.close();child!?.kill('SIGTERM');for(const socket of sockets)socket.destroy();proxy.close();redis.kill('SIGTERM');await writeFile(join(directory,'service.log'),logs,{mode:0o600});
}
