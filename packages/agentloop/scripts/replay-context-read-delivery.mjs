/** Read-only replay of first-decision content delivery from private Run exports.
 * Measures the assembler boundary only, not full Run tokens or business speed.
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ContextAssembler } from '../src/runtime/context-assembler.ts';
import { reconstructRecoveryTranscript } from '../src/runtime/recovery-transcript.ts';

const args = process.argv.slice(2);
function option(name) { const index = args.indexOf(name); return index < 0 ? undefined : args.splice(index, 2)[1]; }
const baselineSource = option('--baseline-source'), output = option('--output');
if (!baselineSource || !output || !args.length || args.some(arg => arg.startsWith('--'))) {
  throw Error('Usage: replay-context-read-delivery.mjs --baseline-source <frozen-src> --output <counts.json> <private-export-directory>...');
}
const { ContextAssembler: BeforeAssembler } = await import(pathToFileURL(resolve(baselineSource, 'runtime/context-assembler.ts')));
const sha = value => createHash('sha256').update(value).digest('hex');
function json(content) { try { return JSON.parse(content.split('\n\n')[0]); } catch { return undefined; } }
const model = { completedExchangePolicy: 'releasable', limits: { contextWindowTokens: 8000000, maxOutputTokens: 4096 },
  complete: async () => { throw Error('No model call is permitted in an archived component replay'); } };
const runs = [];
for (const directory of args) {
  const raw = await fs.readFile(join(directory, 'evidence.json'));
  const { events, manifest } = JSON.parse(raw), run = manifest.summary.run;
  const requests = [];
  for (const request of events.filter(event => event.type === 'model.request.started' && event.data.phase === 'execution')) {
    const prefix = events.filter(event => event.seq < request.seq);
    const stepId = prefix.filter(event => event.type === 'plan.step.started').at(-1)?.data.stepId;
    if (!stepId) continue;
    const { messages } = reconstructRecoveryTranscript({ events: prefix, stepId, userInput: run.input });
    const latest = messages.slice(messages.findLastIndex(message => message.role === 'assistant') + 1)
      .filter(message => message.role === 'tool' && !message.isError && message.name === 'computer_read_json'
        && json(message.content)?.schema === 'agentloop.jsonRead/v1');
    if (!latest.length) continue;
    const settings = { runId: run.id, systemPrompt: 'Read-only content delivery component replay',
      runtimeContext: { phase: 'execution', content: 'Exact goal remains in the user message.' },
      // Hold semantic selection out of this component test. Historical proposals
      // use an earlier contract; this is not a migration/resume acceptance test.
      policy: { executionHistoryProjection: 'canonical' }, model };
    const [before, after] = await Promise.all([new BeforeAssembler(settings).assemble(messages, []), new ContextAssembler(settings).assemble(messages, [])]);
    let requiredValues = 0, beforeExactValues = 0, afterExactValues = 0;
    for (const original of latest) {
      const originalQueries = json(original.content).queries;
      const beforeQueries = json(before.messages.find(message => message.role === 'tool' && message.toolCallId === original.toolCallId)?.content ?? '')?.queries ?? [];
      const afterQueries = json(after.messages.find(message => message.role === 'tool' && message.toolCallId === original.toolCallId)?.content ?? '')?.queries ?? [];
      originalQueries.forEach((query, index) => {
        const key = Object.hasOwn(query, 'value') ? 'value' : Object.hasOwn(query, 'values') ? 'values' : undefined;
        if (!key) return;
        requiredValues++;
        if (Object.hasOwn(beforeQueries[index] ?? {}, key) && JSON.stringify(beforeQueries[index][key]) === JSON.stringify(query[key])) beforeExactValues++;
        if (Object.hasOwn(afterQueries[index] ?? {}, key) && JSON.stringify(afterQueries[index][key]) === JSON.stringify(query[key])) afterExactValues++;
      });
    }
    assert.equal(afterExactValues, requiredValues, 'Every selected value must reach its first decision intact');
    requests.push({ step: request.data.step, requestEventSeq: request.seq, requiredValues, beforeExactValues, afterExactValues,
      beforeToolCharacters: before.messages.filter(message => message.role === 'tool').reduce((n, message) => n + message.content.length, 0),
      afterToolCharacters: after.messages.filter(message => message.role === 'tool').reduce((n, message) => n + message.content.length, 0) });
  }
  runs.push({ runPrefix: run.id.slice(0, 8), archiveExportSha256: sha(raw), requests });
}
const result = { schema: 'agentloop.readDeliveryReplay/v1', mode: 'offline_component_replay',
  accounting: 'Exact selected JSON values and projected Tool-body characters only. No provider token, cost, full working-set or business latency claim.',
  baselineAssemblerSha256: sha(await fs.readFile(resolve(baselineSource, 'runtime/context-assembler.ts'))),
  currentAssemblerSha256: sha(await fs.readFile(new URL('../src/runtime/context-assembler.ts', import.meta.url))),
  modelCallsExecuted: 0, toolCallsExecuted: 0, runs };
await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ runs: runs.map(run => ({ runPrefix: run.runPrefix, requests: run.requests.length,
  restoredSelectedValues: run.requests.reduce((n, request) => n + request.afterExactValues - request.beforeExactValues, 0) })), output }));
