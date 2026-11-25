/** Synthetic, isolated acceptance replay. Never reads business sources or starts shared services. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanonicalRunState } from '../src/runtime/canonical-run-state.ts';
import { understandTask } from '../src/runtime/task-intent.ts';
import { AppDatabase } from '../src/storage/database.ts';
import { RunRepository } from '../src/storage/repositories/run-repository.ts';
import { RuntimeActionRepository } from '../src/runtime/runtime-action-repository.ts';
import { RuntimeResultRepository } from '../src/runtime/runtime-result-repository.ts';
import { createRuntimeResult } from '../src/runtime/runtime-result.ts';
import { deriveDecisionWorkingSet } from '../src/runtime/decision-working-set.ts';
import { createCapabilityGrant } from '../src/runtime/capability-grant.ts';
const replayArgs = process.argv.slice(2);
const kernelDistIndex = replayArgs.indexOf('--kernel-dist');
const kernelDist = kernelDistIndex < 0 ? undefined : replayArgs[kernelDistIndex + 1];
const { runAgentLoop } = await import(kernelDist ? pathToFileURL(resolve(kernelDist, 'runtime/agent-loop.js')).href : new URL('../src/runtime/agent-loop.ts', import.meta.url).href);
import { createResultTool } from '../src/tools/result-tool.ts';
import { ToolRegistry } from '../src/tools/tool-registry.ts';
import { LlmProviderRegistry } from '../src/runtime/provider-registry.ts';
import { modelInvocationComposition } from '../src/runtime/model-streaming.ts';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const configPath = option('--config');
const envPath = option('--env');
const outputPath = option('--output');
const privateEventsPath = option('--private-events');
const privateEvents = [];
const live = args.includes('--live');
const fresh = args.includes('--fresh');
const sequential = args.includes('--sequential');
const emptyUpdates = args.includes('--empty-updates');
if (emptyUpdates && (live || !sequential)) throw new Error('--empty-updates is only for deterministic sequential replay');
const selectedPolicy = option('--policy');
if (selectedPolicy && !['current','canonical'].includes(selectedPolicy)) throw new Error('--policy must be current or canonical');
if (live && (!configPath || !envPath)) throw new Error('--live requires explicit --config and --env');
const sourceRoot = kernelDist ? pathToFileURL(resolve(kernelDist) + '/') : new URL('../src/',import.meta.url);
const sourceHash = createHash('sha256');
for(const path of (await fs.readdir(sourceRoot,{recursive:true})).filter(path=>path.endsWith(kernelDist ? '.js' : '.ts')).sort()) {
  sourceHash.update(path+'\0'); sourceHash.update(await fs.readFile(new URL(path,sourceRoot)));
}
const kernelSourceSha256=sourceHash.digest('hex');
const database = new AppDatabase(':memory:');
const runId = 'decision-context-isolated-replay';
const planId = 'fixed-plan';
const stepId = 'fixed-leaf';
const input = sequential
  ? 'Inspect the eight sequential synthetic observations using inspect(index=0..7, previousToken from the preceding observation). Then reply in Chinese with the exact validation marker observed in observation 2, the latest measured value and calculation basis, both conflicting research dates and remaining unknown scope. Each observation supersedes the preceding attempt; preserve still relevant content. Do not invent a marker or verify unknown scope. Do not repeat any action. Maintain the normal current-state contract alongside your actions.'
  : 'Use the existing synthetic evidence. Reply in Chinese with the exact validation marker for source17, the measured value and calculation basis, and the conflicting research dates and remaining unknown scope. Do not invent a marker or claim unknown scope is verified. Do not rerun any effect. Read original history when necessary.';
const expected = 'CASE17-REVISION-B-VALIDATED';
const identity = { runId, planId, stepId, planVersion: 1, eventWatermark: 1, reducerVersion: 'v1', viewId: 'fixed', decisionBasisDigest: 'fixed-basis' };
const canonical = { ...createCanonicalRunState({ runId, userInput: input, understanding: understandTask({ objective: input }), now: 1 }), plan: { id: planId, version: 1 } };
const basis = { identity, toolEffects: { inspect: 'read', read_result: 'read' } };
const messages = [{ role: 'user', content: input }];
const actions = new RuntimeActionRepository(database);
const runs = new RunRepository(database);
let previous;
try {
  await database.prepare("INSERT INTO runs(id,owner_user_id,depth,allow_dangerous_tools,status,input,created_at) VALUES (?, 'isolated-owner',0,0,'running',?,1)").run(runId, input);
  await database.prepare("INSERT INTO plans(id,run_id,version,goal,selected_skill_ids_json,input_bindings_json,status,created_at,updated_at) VALUES (?,?,1,?,'[]','[]','running',1,1)").run(planId,runId,input);
  for (let n = 0; n <= 60; n++) {
    if(sequential) break;
    const id = `source${n}`;
    const value = { measured: 42, calculation: '10 + 32', research: { sourceA: '2026-01-01', sourceB: '2026-01-02', unresolved: 'coverage before 2026' },
      ...(n === 17 ? { validationMarker: expected } : {}), historicalResolvedDetail: 'This old attempt was superseded after successful observation. '.repeat(12) };
    let ref;
    await actions.execute({ runId, planId, stepId, kind: 'tool_call', replayPolicy: 'safe', deadlineMs: 1000,
      metadata: { toolCallId: id, toolName: 'inspect' }, prepareResult: async (result, action) => {
        const record = createRuntimeResult({ kind: 'tool', producer: { runId, planId, stepId, actionId: action.id, toolCallId: id, toolName: 'inspect' },
          value: result, publication: { status: 'committed' } }); ref = record.ref; return record;
      } }, async () => value);
    const update = n === 0 ? undefined : { kind: 'context', id: 'current', category: 'observation',
      text: 'Measured value 42 = 10 + 32; source A gives 2026-01-01, source B gives 2026-01-02, unresolved conflict; coverage before 2026 remains unknown. The exact old code validation marker is only in original source17.',
      scope: 'Synthetic subject A, revision B, 2026; old implementation errors no longer apply', certainty: 'observed', evidence: [`source${n-1}`], disposition: "carry" };
    const assistant = { role: 'assistant', content: '', executionHistoryBasis: { ...basis, contextArgumentTools: ['inspect'], contextItemRevisions: previous ? { current: previous } : {} }, toolCalls: [{ id, name: 'inspect', arguments: { syntheticObservation: n, ...(update ? { _agentloopContext: { updates: [update] } } : {}) } }] };
    const outcome = { role: 'tool', toolCallId: id, name: 'inspect', content: JSON.stringify({ ...value, resultRef: ref }), isError: false,
      executionOutcome: { invocationStatus: 'completed', operationStatus: 'succeeded' } };
    messages.push(assistant, outcome);
    await runs.appendEvent(runId, { type: 'assistant.committed', createdAt: n+1, data: { ...assistant, step: n+1, finishReason: 'tool_calls' } });
    await runs.appendEvent(runId, { type: 'tool.completed', createdAt: n+1, data: { toolCallId: id, toolName: 'inspect', result: JSON.stringify(value), resultRef: ref, isError: false, invocationStatus: 'completed', operationStatus: 'succeeded' } });
    if (update) previous = createHash('sha256').update(JSON.stringify([[id], 0, update])).digest('hex').slice(0,24);
  }
  if(!sequential) assert.equal(deriveDecisionWorkingSet({ runId, messages }).archived.size, 60);
  const repository = new RuntimeResultRepository(database);
  const tool = createResultTool(repository);
  const env = live ? { ...process.env, ...parseEnv(await fs.readFile(resolve(envPath),'utf8')) } : undefined;
  const providerRegistry = live ? await LlmProviderRegistry.fromConfigFile(resolve(configPath), env) : undefined;
  const reports = [];
  for (const policy of selectedPolicy ? [selectedPolicy] : ['canonical','current']) {
    if(sequential) {
      await database.prepare('DELETE FROM run_events WHERE run_id = ?').run(runId);
      await database.prepare('DELETE FROM runtime_actions WHERE run_id = ?').run(runId);
    }
    const calls = [];
    const events = [];
    let historyReads = 0;
    let observed = 0;
    const registry = new ToolRegistry([tool, ...(sequential ? [{ name:'inspect', effect:'read', replaySafe:true,
      description:'Read the next of eight synthetic observations. Must use the previous observation token to proceed. No external effects.',
      inputSchema:{type:'object',additionalProperties:false,required:['index'],properties:{index:{type:'integer',minimum:0,maximum:7},previousToken:{type:'string'}}},
      parse: value => value, execute: async (_context, value) => {
        assert.equal(value.index, observed, 'do not repeat or skip observations');
        if (observed > 0) assert.equal(value.previousToken,`observed-${observed-1}-confirmed`);
        const index = observed++;
        return { index, nextToken:`observed-${index}-confirmed`, measured:42,calculation:'10 + 32',sourceA:'2026-01-01',sourceB:'2026-01-02',unknown:'coverage before 2026',
          ...(index === 2 ? {validationMarker:expected} : {}), supersedes:index-1,
          obsoleteAttemptDetail:'This resolved attempt has no outstanding defect. The current observation supersedes its implementation. '.repeat(25) };
      } }] : [])]);
    const grant = createCapabilityGrant({ runId, planId, stepId, actorUserId:'isolated-owner',depth:0,allowedToolNames:['read_result',...(sequential?['inspect']:[])],allowedSkillIds:[] });
    const adapter = live ? providerRegistry.create() : {
      limits: { contextWindowTokens: 128000, maxOutputTokens: 4096 }, completedExchangePolicy: 'releasable',
      complete: async invocation => {
        if (sequential && observed < 8) {
          const id = `inspect-${observed}`;
          const updates = observed && !emptyUpdates ? [{kind:'context',id:'current',category:'observation',scope:'synthetic A; r1; before-2026 unknown',certainty:'observed',
            text:`Measured 42 = 10 + 32. Source A 2026-01-01 conflicts with B 2026-01-02. Coverage before 2026 unknown.${observed>2?' Validation marker '+expected:''}`,
            evidence:[`inspect-${observed-1}`],disposition:"carry"}] : [];
          return { content:'',finishReason:'tool_calls',toolCalls:[{id,name:'inspect',arguments:{index:observed,...(observed?{previousToken:`observed-${observed-1}-confirmed`,...(policy==='current'?{_agentloopContext:{updates}}:{})}:{})}}] };
        }
        if (!sequential && policy === 'current' && !invocation.messages.some(message => message.role === 'tool' && message.name === 'read_result')) {
          const anchor = deriveDecisionWorkingSet({ runId, messages }).history.anchor;
          return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'read-original', name: 'read_result', arguments: { resultId: anchor.resultId, view: 'producer_exchange', toolCallId: 'source17', pointer: '/outcome/result' } }] };
        }
        return { content: `验证标记 ${expected}；测量值 42 = 10 + 32；来源 A 日期 2026-01-01 与来源 B 日期 2026-01-02 冲突；2026 年前范围未知。`, finishReason: 'stop', toolCalls: [] };
      },
    };
    const model = { limits: adapter.limits, completedExchangePolicy: adapter.completedExchangePolicy, reasoningVisibility: adapter.reasoningVisibility,
      estimateInputTokens: adapter.estimateInputTokens?.bind(adapter), requestLogContext: adapter.requestLogContext?.bind(adapter),
      complete: async (invocation, signal) => {
        const start = performance.now();
        const response = await adapter.complete({ ...invocation, maxOutputTokens: Math.min(2048, adapter.limits.maxOutputTokens) }, signal);
        calls.push({ durationMs: Math.round(performance.now()-start), composition: modelInvocationComposition(invocation), usage: response.usage,
          ...(sequential&&policy==='current'?{declarationShapes:response.toolCalls.flatMap(call=>(call.arguments?._agentloopContext?.updates??[]).map(x=>({keys:Object.keys(x),id:x.id,replaces:x.replaces,category:x.category,certainty:x.certainty,status:x.status,disposition:x.disposition,evidenceReferenceCount:x.evidence?.length,absorptionCount:x.absorbs?.length,evidenceIsArray:Array.isArray(x.evidence),absorbsIsArray:Array.isArray(x.absorbs),versionKeys:x.version?Object.keys(x.version):null})))}:{}),
          ...(policy==='current'?{workingSetDiagnostics:(()=>{try {const v=JSON.parse(invocation.runtimeContext.content.match(/<decision_working_set[^>]*>([\s\S]*?)<\/decision_working_set>/)?.[1]??'{}');return {itemIds:v.items?.map(x=>x.id),rejectedUpdates:v.rejectedUpdates};}catch{return {};}})()} : {}),
          requiredMarkerAlreadyVisible: invocation.runtimeContext?.content.includes(expected) || invocation.messages.some(message => message.content.includes(expected)),
          historyReadSelectors: response.toolCalls.filter(call => call.name === 'read_result').map(call => ({view:call.arguments?.view??'result',pointer:call.arguments?.pointer})),
          toolCallCount: response.toolCalls.length, finishReason: response.finishReason });
        historyReads += response.toolCalls.filter(call => call.name === 'read_result').length;
        return response;
      },
    };
    const start = performance.now();
    let failure;
    const result = await runAgentLoop({ runId, input, ...(sequential ? {} : {initialMessages: fresh ? messages.slice(0,3) : messages}), currentDecisionContext: () => ({ canonicalState: canonical, stepId }), systemPrompt: 'You are testing a generic kernel current-context contract. Use only the authorized synthetic tools and evidence. Exact user instructions remain authoritative. Preserve conflicts and uncertainty. Never execute a write.',
      runtimeContext: { phase: 'execution', content: sequential ? 'Read all eight observations in order, then deliver the requested answer. Necessary context belongs in the ordinary next action content; no extra calls for state updates.' : 'Goal: answer the exact current user question. The stable source interpretation preserves value, calculation basis, conflict, and unknown scope. For the omitted code validation marker, read source17 using the history anchor; user did not request reexecution.' },
      model, tools: registry, grant, maxSteps: sequential ? 15 : 6, contextPolicy: { executionHistoryProjection: policy },
      ...(sequential ? { actionTracker: { executeToolCall: async (call,operation) => {
        let resultRef;
        const value = await actions.execute({runId,planId,stepId,kind:'tool_call',replayPolicy:'safe',deadlineMs:1000,
          metadata:{toolCallId:call.toolCallId,toolName:call.toolName},
          ...(call.publishesRuntimeResult ? {prepareResult:async(value,action)=>{const result=createRuntimeResult({kind:'tool',producer:{runId,planId,stepId,actionId:action.id,toolCallId:call.toolCallId,toolName:call.toolName},value,publication:{status:'committed'}});resultRef=result.ref;return result;}} : {}) },operation);
        return {value,...(resultRef?{resultRef}:{})};
      } } } : {}),
      emit: async event => { events.push(event); if(privateEventsPath) privateEvents.push(event); if(sequential) await runs.appendEvent(runId,{...event,createdAt:Date.now()}); }, signal: AbortSignal.timeout(120000),
      evaluateCandidate: async candidate => ({ approved: (!sequential || observed === 8) && [expected, '42', '10', '32', '2026-01-01', '2026-01-02'].every(value => candidate.output.includes(value)) && /未知|未验证|unknown/u.test(candidate.output),
        feedback: 'Include the exact original marker, measured value, calculation, conflicting dates and unknown scope.' }),
    }).catch(error => { failure={code:error.code ?? 'UNCLASSIFIED_ERROR'}; return undefined; });
    const inspectionCalls = events.filter(event=>event.type==='assistant.committed').flatMap(event=>event.data.toolCalls??[]).filter(call=>call.name==='inspect');
    const orderedOnce = !sequential || inspectionCalls.length===8 && inspectionCalls.every((call,index)=>call.arguments?.index===index);
    const unknownToolAttempts = events.filter(event=>event.type==='assistant.committed').flatMap(event=>event.data.toolCalls??[]).filter(call=>!['inspect','read_result'].includes(call.name)).length;
    const executionContractPassed = orderedOnce && unknownToolAttempts===0;
    const answerCorrect=Boolean(result?.output.includes(expected) && (!sequential || observed===8)
      && (policy!=='current'||sequential||historyReads>0));
    const correct=answerCorrect && executionContractPassed;
    if(!correct) process.exitCode=1;
    if (correct && policy === 'current' && !fresh && !sequential) assert.ok(events.some(event => event.type === 'context.assembled' && event.data.decisionWorkingSet?.absorbedExchangeCount >= 60), 'the real loop must consume the same current-state projection as the isolated assembler');
    reports.push({ policy, fresh, sequential, observations:observed,taskVersion: sequential?'synthetic-sequential-v1':'synthetic-context-v1', modelKey: live ? providerRegistry.defaultModelKey : 'deterministic-fixture', durationMs: Math.round(performance.now()-start), calls, historyReads,
      correct, answerCorrect, executionContractPassed, inspectAttempts:inspectionCalls.length, unknownToolAttempts, failure, candidateRejectionCount:events.filter(event=>event.type==='candidate.rejected').length,
      candidateChecks:events.filter(event=>event.type==='candidate.rejected').map(event=>({missing:[expected,'42','10','32','2026-01-01','2026-01-02'].filter(value=>!event.data.output?.includes(value)),unknownRetained:/未知|未验证|unknown/u.test(event.data.output??'')})),
      ...(result?{answerSha256: createHash('sha256').update(result.output).digest('hex')} : {}),
      assembled: events.filter(event=>event.type==='context.assembled').map(event=>({canonicalMessages:event.data.canonicalMessageCount,projectedMessages:event.data.projectedMessageCount,workingSet:event.data.decisionWorkingSet})) });
  }
  const report = { schema:'agentloop.decisionWorkingSetReplay/v1', live, fresh, sequential, emptyUpdates, kernelMode:kernelDist?'fixed_dist':'current_source', kernelSourceSha256, createdAt:new Date().toISOString(), task:sequential?'synthetic-sequential-v1':'synthetic-context-v1', configSha256: live ? createHash('sha256').update(await fs.readFile(resolve(configPath))).digest('hex') : undefined,
    accounting:'Characters and estimated tokens are prompt measurements. usage contains actual provider reports where supplied; no billing is inferred. Duration is wall time. Seeded history is identical for both policies.', reports };
  if(privateEventsPath) await fs.writeFile(resolve(privateEventsPath),JSON.stringify(privateEvents)+'\n',{mode:0o600});
  if(outputPath) await fs.writeFile(resolve(outputPath),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({live,reports:reports.map(({calls,...rest})=>({...rest,calls:calls.map(call=>({durationMs:call.durationMs,totalCharacters:call.composition.totalCharacters,totalEstimatedTokens:call.composition.totalEstimatedTokens,usage:call.usage,finishReason:call.finishReason}))}))}));
} finally { await database.close(); }
