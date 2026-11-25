/** Read-only archived decision replay. Never calls a model, Tool, or business source.
 * Inputs are private evidence.json exports. Output is counts/hashes only.
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { reconstructRecoveryTranscript } from '../src/runtime/recovery-transcript.ts';
import { committedDecisionRecords } from '../src/runtime/committed-decision-records.ts';
import { deriveDecisionWorkingSet } from '../src/runtime/decision-working-set.ts';
import { projectDecisionEvidence } from '../src/runtime/decision-evidence-projection.ts';

const args = process.argv.slice(2);
function option(name) { const index = args.indexOf(name); return index < 0 ? undefined : args.splice(index, 2)[1]; }
const baselineRoot = option('--baseline-dist');
const output = option('--output');
if (!args.length || !baselineRoot || args.some(arg => arg.startsWith('--'))) throw new Error('Usage: node replay-committed-decision-basis.mjs <private-directory>... --baseline-dist <fixed-old-dist> [--output <counts.json>]');
const baselineRecovery = await import(pathToFileURL(resolve(baselineRoot, 'runtime/recovery-transcript.js')));
const baselineWorkingSet = await import(pathToFileURL(resolve(baselineRoot, 'runtime/decision-working-set.js')));
const sha = value => createHash('sha256').update(value).digest('hex');
const runs = [];
for (const directory of args) {
  const raw = await fs.readFile(join(directory, 'evidence.json'));
  const { events, manifest } = JSON.parse(raw), run = manifest.summary.run;
  const stepId = events.filter(event => event.type === 'plan.step.started').at(-1).data.stepId;
  assert.equal(events.flatMap(event => event.type === 'assistant.committed' ? event.data.toolCalls ?? [] : []).filter(call => call.argumentsRef).length, 0,
    'Resolve and authorize argument references before replay; never interpret previews');
  const parameters = { userInput: run.input, stepId, events };
  const oldRecovery = baselineRecovery.reconstructRecoveryTranscript(parameters);
  const recovered = reconstructRecoveryTranscript(parameters);
  const rejected = new Set(events.filter(event => event.type === 'tool.rejected' && event.data.failurePhase === 'prepare').map(event => event.data.toolCallId));
  const liveMessages = oldRecovery.messages.map(message => message.role === 'assistant' && message.toolCalls?.length
    ? { ...message, toolCalls: message.toolCalls.filter(call => !rejected.has(call.id)) } : message)
    .filter(message => message.role !== 'tool' || !rejected.has(message.toolCallId));
  const oldLive = baselineWorkingSet.deriveDecisionWorkingSet({ runId: run.id, messages: liveMessages });
  const oldRestored = baselineWorkingSet.deriveDecisionWorkingSet({ runId: run.id, messages: oldRecovery.messages });
  const records = committedDecisionRecords(recovered.workProductEvents ?? []);
  const started = performance.now();
  const nextLive = deriveDecisionWorkingSet({ runId: run.id, messages: liveMessages, records });
  const nextRestored = deriveDecisionWorkingSet({ runId: run.id, messages: recovered.messages, records });
  assert.deepEqual(nextLive.items, nextRestored.items);
  assert.deepEqual(nextLive.rejections, nextRestored.rejections);
  const projectionMs = performance.now() - started;
  assert.equal(recovered.messages.some(message => message.role === 'tool' && rejected.has(message.toolCallId)), false);
  const selected = projectDecisionEvidence({ evidence: recovered.toolEvidence,
    workingSet: { ...nextRestored.view, history: nextRestored.history }, reconciledToolCallIds: nextRestored.reconciledToolCallIds,
    unsafeEffectToolCallIds: nextRestored.unsafeEffectToolCallIds });
  // Component measurement only. Do not invent product roles or canonical gaps
  // from filenames, raw SQL, or the final checkpoint's observed-file inventory.
  const legacySelected = recovered.toolEvidence.filter(item => !oldLive.archived.has(item.toolCallId));
  runs.push({ runPrefix: run.id.slice(0, 8), evidenceSha256: sha(raw),
    baseline: { liveItems: oldLive.items.length, recoveryItems: oldRestored.items.length, semanticEqual: JSON.stringify(oldLive.items) === JSON.stringify(oldRestored.items) },
    current: { liveItems: nextLive.items.length, recoveryItems: nextRestored.items.length, semanticEqual: true,
      rejections: nextRestored.rejections.length, pendingObservations: nextRestored.view.pendingToolCallIds.length,
      unfinishedEffects: recovered.facts.unfinishedToolCalls.length, prepareRejectionsExcludedFromNative: rejected.size, projectionMs },
    evidenceComponentOnly: { scope: 'semantic carry + unreconciled observations + effect safety; product roles/canonical gaps/criteria unavailable',
      legacyRemainingCount: legacySelected.length, legacyRemainingCharacters: legacySelected.reduce((n, item) => n + item.result.length, 0),
      currentSelectedCount: selected.length, currentSelectedCharacters: selected.reduce((n, item) => n + item.result.length, 0),
      exactSelectedBodies: selected.every(item => recovered.toolEvidence.includes(item)) },
    modelCallsExecuted: 0, toolCallsExecuted: 0,
  });
}
const result = { schema: 'agentloop.committedDecisionReplay/v1', mode: 'offline_fixed_evidence_no_provider_usage_or_business_acceptance_claim',
  baselineReducerSha256: sha(await fs.readFile(resolve(baselineRoot, 'runtime/decision-working-set.js'))), runs };
if (output) await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
