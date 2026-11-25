/** Aggregate neutral replay metrics. Never copies model text, tool bodies or config. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const [directory, destination] = process.argv.slice(2);
if (!directory || !destination) throw new Error('Usage: summarize-context-lifecycle.mjs <replay-directory> <output.json>');
const samples = [];
for (const name of (await fs.readdir(directory)).sort()) {
  const match = /^(data|report)-(.+)-(\d+)\.json$/.exec(name);
  if (!match) continue;
  const bytes = await fs.readFile(resolve(directory, name));
  const input = JSON.parse(bytes);
  if (input.schema !== 'agentloop.decisionWorkingSetReplay/v1') continue;
  let executionAudit = { verified: false };
  try {
    const events = JSON.parse(await fs.readFile(resolve(directory, name.replace('.json', '-events.json')), 'utf8'));
    const calls = events.filter(event => event.type === 'assistant.committed').flatMap(event => event.data.toolCalls ?? []);
    const inspections = calls.filter(call => call.name === 'inspect');
    const orderedOnce = inspections.length === 8 && inspections.every((call, index) => call.arguments?.index === index);
    const unknownToolAttempts = calls.filter(call => !['inspect', 'read_result'].includes(call.name)).length;
    executionAudit = { verified: true, inspectAttempts: inspections.length, eightOrderedActionsExactlyOnce: orderedOnce,
      unknownToolAttempts, taskExecutionContractPassed: orderedOnce && unknownToolAttempts === 0 };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const report of input.reports) {
    const usage = {};
    for (const call of report.calls ?? []) for (const [key, value] of Object.entries(call.usage ?? {})) {
      if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
    }
    samples.push({ host: match[1], stage: match[2], sample: Number(match[3]),
      sourceMeasurementSha256: createHash('sha256').update(bytes).digest('hex'),
      kernelMode: input.kernelMode, kernelSourceSha256: input.kernelSourceSha256,
      configSha256: input.configSha256, taskVersion: report.taskVersion,
      modelKey: report.modelKey, policy: report.policy, correct: report.correct,
      errorCode: report.errorCode, modelCalls: report.calls?.length ?? 0,
      historyReads: report.historyReads, durationMs: report.durationMs,
      candidateRejectionCount: report.candidateRejectionCount,
      executionAudit,
      finalWorkingSet: report.assembled?.at(-1)?.workingSet,
      providerUsage: usage,
      calls: (report.calls ?? []).map(call => ({ durationMs: call.durationMs,
        composition: call.composition, usage: call.usage,
        historyReadCount: call.historyReadSelectors?.length,
        contextRejectionReasons: call.workingSetDiagnostics?.rejectedUpdates?.map(item => item.reason),
      })),
    });
  }
}
await fs.mkdir(resolve(destination, '..'), { recursive: true });
await fs.writeFile(destination, JSON.stringify({ schema: 'agentloop.contextLifecycleMeasurements/v1',
  accounting: 'All discovered stages and samples are retained. Characters/estimated tokens and actual provider usage are separate. Usage fields can overlap and are not additive billing. Cache reports can be absent. No price or bill inferred.',
  comparability: 'Synthetic sequential tasks only. Frozen before dist includes earlier dirty-worktree work; it is not git HEAD. Intermediate stages have different contracts. Few stochastic samples and varying cache/concurrency do not establish latency causality. Final native-only stage has one sample per host.',
  samples,
}, null, 2) + '\n');
console.log(JSON.stringify({ samples: samples.length, destination }));
