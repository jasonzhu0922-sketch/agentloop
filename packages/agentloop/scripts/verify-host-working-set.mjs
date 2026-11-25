/** Opt-in real host replay. Private evidence stays in --snapshot; exported summaries contain no bodies. */
import fs from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { parseEnv } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const repo = resolve(import.meta.dirname, '../../..');
const snapshot = resolve(arg('--snapshot', '/tmp/agentloop-host-working-set'));
const host = arg('--host', 'data');
const policy = arg('--policy', 'current');
const suite = arg('--suite', host === 'data' ? 'latest' : 'finance');
if (!['data', 'report'].includes(host) || !['canonical', 'current'].includes(policy)) throw Error('Invalid host/policy');
const roots = { data: join(repo, 'apps/agentloop-data-agent'), report: resolve(arg('--report-root', '/Users/zhujun/coding/report-agent')) };
const hash = value => createHash('sha256').update(value).digest('hex');
const privateJson = async (path, value) => fs.writeFile(path, JSON.stringify(value, null, 2) + '\n', {mode:0o600});
async function treeHash(root, include = () => true) {
  const digest = createHash('sha256');
  for (const path of (await fs.readdir(root, {recursive:true, withFileTypes:true})).filter(e => e.isFile()).map(e => resolve(e.parentPath, e.name)).sort()) {
    if (!include(path)) continue;
    digest.update(path.slice(root.length) + '\0'); digest.update(await fs.readFile(path));
  }
  return digest.digest('hex');
}
if (args.includes('--prepare')) {
  await fs.mkdir(snapshot, {mode:0o700}); // refuse reuse/overwrite
  await fs.cp(join(repo, 'packages/agentloop/src'), join(snapshot, 'kernel/src'), {recursive:true});
  await privateJson(join(snapshot,'kernel/package.json'), {type:'module'});
  await fs.symlink(join(repo,'node_modules'),join(snapshot,'kernel/node_modules'));
  for (const [name, root] of Object.entries(roots)) {
    const target = join(snapshot, name);
    await fs.mkdir(target, {mode:0o700});
    for (const entry of ['src','skills','config','.env', ...(name === 'report' ? ['python'] : [])]) {
      await fs.cp(join(root,entry),join(target,entry), {recursive:true});
    }
    await privateJson(join(target,'package.json'), {type:'module'});
    await fs.symlink(join(root,'node_modules'),join(target,'node_modules'));
  }
  const manifest = {schema:'agentloop.hostReplaySnapshot/v1',createdAt:new Date().toISOString(),
    kernelSourceSha256:await treeHash(join(snapshot,'kernel/src')),
    hosts:Object.fromEntries(await Promise.all(Object.keys(roots).map(async name => [name, {
      sourceSha256:await treeHash(join(snapshot,name,'src')),
      skillPackageSha256:await treeHash(join(snapshot,name,'skills'), p=>!p.endsWith('/connections.json')&&!p.endsWith('/.env')&&!p.endsWith('.pyc')),
      modelConfigSha256:hash(await fs.readFile(join(snapshot,name,'config/llm-providers.json'))),
    }])))};
  await privateJson(join(snapshot,'manifest.json'),manifest);
  console.log(JSON.stringify({snapshot,manifest}));
  process.exit(0);
}
const manifest = JSON.parse(await fs.readFile(join(snapshot,'manifest.json'),'utf8'));
if (await treeHash(join(snapshot,'kernel/src')) !== manifest.kernelSourceSha256) throw Error('Frozen kernel source changed');
if (await treeHash(join(snapshot,host,'src')) !== manifest.hosts[host].sourceSha256) throw Error('Frozen host source changed');
if (hash(await fs.readFile(join(snapshot,host,'config/llm-providers.json'))) !== manifest.hosts[host].modelConfigSha256) throw Error('Frozen model config changed');
// The baseline changes only the existing executionHistoryProjection comparison switch,
// in a private copy. Host dependencies, source checkout and shared services are untouched.
let kernel = join(snapshot,'kernel');
if (policy === 'canonical') {
  kernel = join(snapshot,'kernel-canonical');
  try { await fs.access(join(kernel,'src/index.ts')); }
  catch {
    await fs.mkdir(kernel, {mode:0o700});
    await fs.cp(join(snapshot,'kernel/src'),join(kernel,'src'),{recursive:true});
    await privateJson(join(kernel,'package.json'),{type:'module'});
    await fs.symlink(join(repo,'node_modules'),join(kernel,'node_modules'));
    const edits = [
      ['runtime/context-assembler.ts','executionHistoryProjection: input?.executionHistoryProjection ?? "current"','executionHistoryProjection: input?.executionHistoryProjection ?? "canonical"'],
      ['runtime/agent-loop.ts','options.contextPolicy?.executionHistoryProjection === "canonical"','(options.contextPolicy?.executionHistoryProjection ?? "canonical") === "canonical"'],
    ];
    for (const [path,from,to] of edits) {
      const file = join(kernel,'src',path), source = await fs.readFile(file,'utf8');
      if (source.split(from).length !== 2) throw Error('Comparison switch drift: '+path);
      await fs.writeFile(file,source.replace(from,to));
    }
  }
}
registerHooks({resolve(specifier,context,nextResolve) {
  if (specifier === '@zhujun/agentloop') return {url:pathToFileURL(join(kernel,'src/index.ts')).href,shortCircuit:true};
  return nextResolve(specifier,context);
}});
const {SqliteConnection} = await import('@zhujun/agentloop');
const {modelInvocationComposition} = await import(pathToFileURL(join(kernel,'src/runtime/model-streaming.ts')));
const root = join(snapshot,host);
const env = {...process.env,...parseEnv(await fs.readFile(join(root,'.env'),'utf8'))};
const {ModelSettings} = await import(pathToFileURL(join(root,'src/model-settings.ts')));
const models = await new ModelSettings(join(root,'config/llm-providers.json'),env).load();
const { [host === 'data'?'createDataAgent':'createReportAgent']: createAgent, OWNER } = await import(pathToFileURL(join(root,'src/agent.ts')));
const id = `${host}-${suite}-${policy}-${arg('--repeat','1')}`;
const directory = join(snapshot,id);
await fs.mkdir(directory,{mode:0o700});
const summaries = [];
const calls = [];
let activeCalls, mock;
let connectorConfig = join(root,'config/connectors.json');
if (host === 'report' && suite === 'finance') {
  const python = env.REPORT_AGENT_PYTHON ?? join(roots.report,'.venv/bin/python');
  mock = spawn(python,['-B','-c', 'import json;from report_agent_runtime.mock_server import create_server;s=create_server(0);print(json.dumps({"port":s.server_port}),flush=True);s.serve_forever()'],
    {env:{...env,PYTHONPATH:join(root,'python')},stdio:['ignore','pipe','pipe']});
  const port = await new Promise((accept,reject) => {
    let output='';
    mock.stdout.on('data',data=>{output+=data; if(output.includes('\n')) {try {accept(JSON.parse(output.split('\n')[0]).port);}catch{reject(Error('Mock startup invalid'));}}});
    mock.once('error',reject);mock.once('exit',()=>reject(Error('Mock startup failed')));
  });
  const config = JSON.parse(await fs.readFile(connectorConfig,'utf8'));
  config.mode='http';
  for(const key of ['report-eplat-connector','znsd-connector'])config.connectors[key]={url:`http://127.0.0.1:${port}/call`};
  connectorConfig=join(directory,'connectors.json'); await privateJson(connectorConfig,config);
}
function recordResponse(invocation,start,response) {
  const updates = response.toolCalls.flatMap(c=>c.arguments?._agentloopContext?.updates??[]);
  const reads = response.toolCalls.filter(c=>c.name==='read_result');
  const sample = {phase:invocation.runtimeContext?.phase,durationMs:Math.round(performance.now()-start),
    composition:modelInvocationComposition(invocation),usage:response.usage,finishReason:response.finishReason,
    toolNames:response.toolCalls.map(c=>c.name),historyReads:reads.filter(c=>['producer_exchange','step_history'].includes(c.arguments?.view)).length,
    resultReads:reads.length,updateCount:updates.length,updateCharacters:JSON.stringify(updates).length,
    responseSha256:hash(JSON.stringify(response))};
  calls.push(sample);activeCalls?.push(sample);
}
const modelFactory=(retry,key)=> {
  const model=models.registry.create(key,retry);
  return {limits:model.limits,reasoningVisibility:model.reasoningVisibility,completedExchangePolicy:model.completedExchangePolicy,
    ...(model.estimateInputTokens?{estimateInputTokens:model.estimateInputTokens.bind(model)}:{}),
    ...(model.requestLogContext?{requestLogContext:model.requestLogContext.bind(model)}:{}),
    complete:async(invocation,signal)=>{const start=performance.now(); const response=await model.complete(invocation,signal);recordResponse(invocation,start,response);return response;},
    ...(model.streamComplete?{streamComplete:async(invocation,sink,signal)=>{const start=performance.now();const response=await model.streamComplete(invocation,sink,signal);recordResponse(invocation,start,response);return response;}}:{}),
  };
};
const baseOptions={fileDirectory:directory,runtimeId:`isolated-${randomUUID()}`,skillRoot:join(root,'skills',...(host==='data'?['data-analysis']:[])),
  python:host==='data'?(env.DATA_AGENT_PYTHON??'python3'):(env.REPORT_AGENT_PYTHON??join(roots.report,'.venv/bin/python')),
  modelFactory,modelKeys:models.registry.modelKeys(),defaultModelKey:models.defaultModelKey,maxPlanningTurns:6,stepMaxTurns:30,
  ...(host==='report'?{pythonPath:join(root,'python'),connectorConfig}:{}),
};
const open=()=>createAgent({...baseOptions,connection:new SqliteConnection(join(directory,'runtime.sqlite'))});
let agent;
const tasks = suite === 'latest' ? ['查询人力月报数据中最新的月份。','沿用刚才的人力月报来源，查询可用的最近三个月份，只需要月份，不查询人员明细。']
  : suite === 'hr' ? ['分析人力月报最新月份的全公司员工人数、青年员工率和党员率，生成自包含 HTML 报告；保留来源、统计口径、计算依据及数据限制。']
  : suite === 'enterprise' ? ['查询宝山钢铁股份有限公司的工商详情，交付企业信息 HTML 报告和 JSON 来源结果，不需要信用评分、穿透图或财报。']
  : ['使用模拟数据，生成 DEMO001 在 2026 年 10 月的预付账款超期提示报告，交付 DOCX。',
     '再生成 DEMO002 在同一月份的预付账款超期提示报告，仍使用模拟数据，交付独立 DOCX；保留上一份报告。'];
const conversationId=randomUUID();
const started=performance.now();
let runId;
try {
  agent=await open();
  for(let index=0;index<tasks.length;index++) {
    activeCalls=[];
    const start=performance.now();
    const run=await agent.start({requestId:randomUUID(),conversationId,input:tasks[index],modelKey:models.defaultModelKey});runId=run.id;
    console.log(JSON.stringify({id,index,runId:run.id,status:'started'}));
    const timeout=setTimeout(()=>{void agent.runs.cancel(OWNER,run.id);},Number(arg('--timeout-ms','600000')));
    await agent.runs.whenRunIdle(run.id);clearTimeout(timeout);
    const current=await agent.runs.get(OWNER,run.id), hil=await agent.runs.currentHumanLoop(OWNER,run.id);
    const events=await agent.runs.events(OWNER,run.id), artifacts=await agent.runs.processArtifacts(OWNER,run.id);
    const plan=await agent.runs.plan(OWNER,run.id);
    await privateJson(join(directory,`${index}-evidence.json`),{task:tasks[index],run:current,humanLoop:hil,events,artifacts,plan});
    const verified=[];
    for(const artifact of artifacts.filter(a=>a.role==='final')) {
      const read=await agent.runs.readProcessArtifact(OWNER,run.id,artifact.id);
      const digest=hash(read.content);
      await fs.mkdir(join(directory,'delivered'),{recursive:true,mode:0o700});
      await fs.writeFile(join(directory,'delivered',`${index}-${artifact.name}`),read.content,{mode:0o600});
      verified.push({name:artifact.name,bytes:read.content.length,sha256:digest,hashMatchesReceipt:!artifact.sha256||artifact.sha256===digest,verification:artifact.verification});
    }
    const summary={index,runId:run.id,status:current.status,durationMs:Math.round(performance.now()-start),
      hil:hil?{kind:hil.kind,requestId:hil.id}:null,outputSha256:hash(current.output??''),
      errorCode:current.errorCode,artifacts:verified,calls:activeCalls,
      contexts:events.filter(e=>e.type==='context.assembled').map(e=>e.data),
      failures:events.filter(e=>['tool.failed','model.request.failed','run.failed'].includes(e.type)).map(e=>({type:e.type,code:e.data?.code??e.data?.errorCode})),
      eventTypes:Object.fromEntries([...new Set(events.map(e=>e.type))].map(type=>[type,events.filter(e=>e.type===type).length])),
    };
    summaries.push(summary);
    console.log(JSON.stringify({id,index,runId:run.id,status:current.status,hil:!!hil,calls:activeCalls.length,inputTokens:activeCalls.reduce((a,c)=>a+(c.usage?.inputTokens??0),0),artifacts:verified.length}));
    // Reopen the actual host on the same private persisted state before the follow-up.
    await agent.close();agent=await open();
    const restored=await agent.runs.get(OWNER,run.id), restoredArtifacts=await agent.runs.processArtifacts(OWNER,run.id);
    const restoredEvents=await agent.runs.events(OWNER,run.id);
    summary.reopen={statusEqual:restored.status===current.status,outputEqual:restored.output===current.output,
      eventCountEqual:restoredEvents.length===events.length,artifactIdentitiesEqual:JSON.stringify(restoredArtifacts)===JSON.stringify(artifacts)};
    if(current.status!=='completed'||hil) { process.exitCode=1; break; }
  }
} catch(error) {
  await privateJson(join(directory,'failure.json'),{runId,error:String(error),stack:error.stack});
  console.log(JSON.stringify({id,errorCode:error.code??error.name,privateEvidence:join(directory,'failure.json')}));process.exitCode=1;
} finally {
  await agent?.close();mock?.kill('SIGTERM');
  const result={schema:'agentloop.hostWorkingSetReplay/v1',id,host,suite,policy,modelKey:models.defaultModelKey,
    source:manifest,comparison:'same frozen source; private canonical copy overrides only executionHistoryProjection comparison switch',
    sourceDataMode:suite==='finance'?'mock':'configured_remote_service; verify receipt before claiming live',
    durationMs:Math.round(performance.now()-started),runs:summaries,
    totals:{calls:calls.length,inputTokens:calls.reduce((a,c)=>a+(c.usage?.inputTokens??0),0),outputTokens:calls.reduce((a,c)=>a+(c.usage?.outputTokens??0),0),historyReads:calls.reduce((a,c)=>a+c.historyReads,0),resultReads:calls.reduce((a,c)=>a+c.resultReads,0),updateCharacters:calls.reduce((a,c)=>a+c.updateCharacters,0)},
    accounting:'Provider usage is actual reported tokens from successful responses. Failed attempts without usage are not included; see persisted model.request.failed counts. Composition characters/estimates are separate. No price or billing estimate.'};
  await privateJson(join(directory,'summary.json'),result);
  if(args.includes('--output')) {const output=resolve(arg('--output'));await fs.mkdir(dirname(output),{recursive:true});await privateJson(output,result);}
  console.log(JSON.stringify({id,summary:join(directory,'summary.json'),totals:result.totals}));
}
