/** Offline replay of private exported Run evidence. No model, network, or source writes.
 * Each input directory contains evidence.json (manifest + events) and reduction.json
 * (the pre-change derived view + reconstructed messages). Output contains counts only.
 */
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { RuntimeResultRepository } from '../src/runtime/runtime-result-repository.ts';
import { deriveDecisionWorkingSet } from '../src/runtime/decision-working-set.ts';
import { projectAssessmentContext } from '../src/planning/assessment-context-projection.ts';
import { persistedEvidenceTimeline } from '../src/runtime/run-service.ts';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const output = outputIndex < 0 ? undefined : args.splice(outputIndex, 2)[1];
if (!args.length || args.some(arg => arg.startsWith('--')) || outputIndex >= 0 && !output) {
  throw new Error('Usage: node scripts/replay-working-set-evidence.mjs <private-directory>... [--output <counts.json>]');
}

// Resolve only this encoding's local references, then restore exact result text.
function restore(view) {
  const visit = (value, ancestors = new Set()) => {
    if (value?.schema === 'agentloop.assessmentEvidenceReference/v1' && value.ref?.startsWith('#/')) {
      assert.ok(!ancestors.has(value.ref), 'Cyclic evidence reference');
      const target = value.ref.slice(2).split('/').reduce((node, token) => node?.[token.replace(/~1/g, '/').replace(/~0/g, '~')], view);
      assert.notEqual(target, undefined, 'Dangling evidence reference');
      return visit(target, new Set([...ancestors, value.ref]));
    }
    if (Array.isArray(value)) return value.map(child => visit(child, ancestors));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child, ancestors)]));
    return value;
  };
  const restored = visit(view);
  for (const call of restored.evidence?.toolCalls ?? []) {
    if (call.resultEncoding?.exactSerialization !== 'JSON.stringify') continue;
    call.result = JSON.stringify(call.result);
    assert.equal(createHash('sha256').update(call.result).digest('hex'), call.resultEncoding.sha256);
    delete call.resultEncoding;
  }
  return restored;
}

const sourceHash = createHash('sha256');
const sourceRoot = new URL('../src/', import.meta.url);
for (const path of (await fs.readdir(sourceRoot, { recursive: true })).filter(path => path.endsWith('.ts')).sort()) {
  sourceHash.update(path + '\0'); sourceHash.update(await fs.readFile(new URL(path, sourceRoot)));
}
const runs = [];
for (const root of args) {
  const raw = await fs.readFile(join(root, 'evidence.json'));
  const evidence = JSON.parse(raw);
  const before = JSON.parse(await fs.readFile(join(root, 'reduction.json'), 'utf8'));
  const events = evidence.events, run = evidence.manifest.summary.run;
  const next = deriveDecisionWorkingSet({ runId: run.id, messages: before.messages });
  const toolCalls = events.filter(event => ['tool.completed', 'tool.failed'].includes(event.type)).map(({ data }) => ({
    toolCallId: data.toolCallId, toolName: data.toolName, result: data.result ?? data.error,
    invocationStatus: data.invocationStatus, operationStatus: data.operationStatus, isError: data.isError,
  }));
  const timeline = persistedEvidenceTimeline(events.map(event => ({ seq: event.seq, type: event.type, createdAt: event.created_at, data: event.data })), toolCalls.map(call => call.toolCallId));
  // Keep the same full evidence selection; isolate encoding, not relevance or
  // total original provider input. JSON serialization is the model boundary.
  const sample = JSON.parse(JSON.stringify({ evidence: { candidateOutput: run.output, toolCalls }, evidenceTimeline: timeline }));
  const projected = projectAssessmentContext(sample);
  assert.deepEqual(restore(projected.view), sample);
  const history = [];
  for (const event of events.filter(event => event.type === 'tool.completed' && event.data.toolName === 'read_result')) {
    let result; try { result = JSON.parse(event.data.result); } catch { continue; }
    if (result.source?.view !== 'producer_exchange') continue;
    const old = JSON.parse(result.content), id = old.assistant.toolCall.id;
    // Anchor authorization is tested separately by runtime-result-contract.
    const reader = Object.create(RuntimeResultRepository.prototype);
    reader.database = { records: { find: async () => events } };
    reader.readAuthorized = async () => ({ kind: 'tool', producer: { runId: run.id, planId: old.source.planId, stepId: old.source.stepId } });
    const now = await reader.readHistoryAuthorized({ resultId: result.sourceResultRef.resultId, runId: run.id,
      planId: old.source.planId, stepId: old.source.stepId, toolCallId: id, assistantEventSeq: old.source.assistantEventSeq });
    const receipt = events.find(candidate => candidate.type === 'tool.completed' && candidate.data.toolCallId === id);
    assert.equal(now.outcome.result, receipt.data.result); assert.deepEqual(now.gaps, []);
    history.push({ baselineOutcome: !!old.outcome, currentOutcome: !!now.outcome, exactResultMatched: true,
      originalResultEventSeq: receipt.seq, assistantEventSeq: old.source.assistantEventSeq });
  }
  runs.push({ runPrefix: run.id.slice(0, 8), evidenceSha256: createHash('sha256').update(raw).digest('hex'), history,
    originalDeclarations: { accepted: before.view.items.length + before.view.historicalItemCount, rejected: before.view.rejectionCount, absorbed: before.view.absorbedExchangeCount },
    reinterpretedNativeSyntax: { accepted: next.items.length + next.view.historicalItemCount, rejected: next.view.rejectionCount, absorbed: next.view.absorbedExchangeCount },
    sameSelectedEvidenceEncoding: { ...projected.diagnostics, exactRoundTrip: true } });
}
const result = JSON.stringify({ schema: 'agentloop.offlineWorkingSetReplay/v1', kernelSourceSha256: sourceHash.digest('hex'),
  mode: 'offline_no_provider_usage_or_latency_claim', runs }, null, 2) + '\n';
if (output) await fs.writeFile(output, result);
process.stdout.write(result);
