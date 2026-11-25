/** Read-only, frozen event replay. No model, query, Tool or effect execution. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContextAssembler } from '../src/runtime/context-assembler.ts';
import { reconstructRecoveryTranscript } from '../src/runtime/recovery-transcript.ts';
import { WorkProductContext } from '../src/runtime/work-product-context.ts';
import { deriveCurrentDecisionView, projectCurrentDecisionView } from '../src/runtime/current-decision-view.ts';
import { createResultTool } from '../src/tools/result-tool.ts';
import { modelInvocationComposition } from '../src/runtime/model-streaming.ts';

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const baselineDist = option('--baseline-dist');
assert.ok(baselineDist, '--baseline-dist is required');
const baseline = await import(pathToFileURL(resolve(baselineDist, 'runtime/context-assembler.js')).href);
async function treeDigest(root, suffix) {
  const digest = createHash('sha256');
  for (const path of (await fs.readdir(root, { recursive: true })).filter(path => path.endsWith(suffix)).sort()) {
    digest.update(path + '\0'); digest.update(await fs.readFile(resolve(root, path)));
  }
  return digest.digest('hex');
}
const exports = args.flatMap((arg, i) => arg === '--archive-export' ? [args[i + 1]] : []);
assert.ok(exports.length, 'supply --archive-export with a private verified archive export');
const reader = createResultTool({});
const tools = [{ name: reader.name, description: reader.description, inputSchema: reader.inputSchema }];
const model = { completedExchangePolicy: 'releasable', limits: { contextWindowTokens: 2_000_000, maxOutputTokens: 4096 },
  complete: async () => { throw Error('Replay must not call a model'); } };
const report = { schema: 'agentloop.exactCurrentEvidenceReplay/v1',
  method: 'same_frozen_events_component_projection_not_task_reexecution',
  builds: { baselineJavaScriptSha256: await treeDigest(resolve(baselineDist), '.js'),
    currentTypeScriptSha256: await treeDigest(resolve('packages/agentloop/src'), '.ts') },
  configuration: { contextWindowTokens: model.limits.contextWindowTokens, maxOutputTokens: model.limits.maxOutputTokens,
    completedExchangePolicy: model.completedExchangePolicy, toolDefinitionSha256: createHash('sha256').update(JSON.stringify(tools)).digest('hex') },
  accounting: 'Characters and estimates are not actual provider tokens or billing. Both builds use the same frozen events, goal, current view, reader definition and model limits. A large fixed context window excludes capacity summaries from this component measurement. Full host prompts/tool catalogs and changed model decisions are not replayed.',
  runs: [] };
for (const path of exports) {
  const raw = await fs.readFile(path);
  const x = JSON.parse(raw);
  const run = x.manifest.summary.run;
  const requests = x.events.filter(e => e.type === 'model.request.started' && e.data.phase === 'execution');
  const measurements = [];
  for (const [index, request] of requests.entries()) {
    const events = x.events.filter(e => e.seq < request.seq);
    const stepId = [...events].reverse().find(e => e.type === 'plan.step.started')?.data.stepId;
    assert.ok(stepId);
    const transcript = reconstructRecoveryTranscript({ userInput: run.input, stepId, events });
    const last = [...events].reverse().find(e => e.type === 'assistant.committed' && e.data.executionHistoryBasis);
    const products = new WorkProductContext(run.id, { workspaceId: 'frozen-replay', goalId: stepId, goal: run.input,
      storeSnapshot: async () => { throw Error('Replay cannot store state'); } });
    for (const e of transcript.workProductEvents ?? []) products.capture(e);
    const view = deriveCurrentDecisionView({ runId: run.id, workProducts: products.derive() });
    if (last) view.identity = last.data.executionHistoryBasis.identity;
    const input = { runId: run.id, systemPrompt: 'Frozen kernel evidence projection comparison', model,
      runtimeContext: { phase: 'execution', content: JSON.stringify({ goal: run.input, currentView: projectCurrentDecisionView(view) }) },
      decisionEvents: () => transcript.workProductEvents ?? [] };
    const sample = { step: index + 1, requestEventSeq: request.seq };
    for (const [name, Class] of [['before', baseline.ContextAssembler], ['after', ContextAssembler]]) {
      const assembler = new Class(input); assembler.setCurrentDecisionView(view);
      const assembly = await assembler.assemble(transcript.messages, tools);
      const composition = modelInvocationComposition({ phase: 'execution', systemPrompt: input.systemPrompt, tools, ...assembly });
      sample[name] = { characters: composition.totalCharacters, estimatedTokens: composition.totalEstimatedTokens,
        currentEvidenceCount: assembler.decisionWorkingSet?.currentEvidence?.length ?? 0,
        historicalObservationCount: assembler.decisionWorkingSet?.historicalObservationCount ?? 0,
        semanticItemCount: assembler.decisionWorkingSet?.items.length ?? 0,
        pendingObservationCount: assembler.decisionWorkingSet?.pendingToolCallIds.length ?? 0,
        projectedMessages: assembly.messages.length, contextEpoch: assembly.contextEpoch };
    }
    measurements.push(sample);
  }
  report.runs.push({ runPrefix: run.id.slice(0, 8), archiveExportSha256: createHash('sha256').update(raw).digest('hex'),
    executionDecisions: measurements.length,
    beforeCharacters: measurements.reduce((sum, m) => sum + m.before.characters, 0),
    afterCharacters: measurements.reduce((sum, m) => sum + m.after.characters, 0), measurements });
}
const output = option('--output');
if (output) await fs.writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ runs: report.runs.map(({ measurements, ...run }) => ({ ...run, final: measurements.at(-1) })) }));
