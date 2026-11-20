import { createHash } from "node:crypto";
import { accumulateKnowledge, revalidateKnowledge, type KnowledgeUnit } from "./knowledge.ts";
import { alignKnowledgeClaims } from "./knowledge-relations.ts";
import type { MemoryCandidate, MemoryScope, MemorySourceRef, MemoryStore } from "./types.ts";

type Row = Record<string, any>;
export type KnowledgeEntry = Awaited<ReturnType<MemoryStore["active"]>>[number];
export const INDEPENDENT_KNOWLEDGE = "experience.independent_knowledge";
export const standalone = (unit: KnowledgeUnit) => unit.section === "reusableKnowledge" && (unit.content as Row).standalone === true;
export function independentInventory(entries: readonly KnowledgeEntry[]) {
  return entries.map(({ revision }) => {
    const unit = revision.value.knowledgeUnit as KnowledgeUnit;
    return { knowledgeId: unit.id, definitionVersion: revision.value.definitionVersion, section: unit.section,
      content: unit.content, parameters: unit.parameters, contradicted: revision.value.contradicted === true };
  });
}
export function independentIndex(entry: KnowledgeEntry): Row {
  const content = (entry.revision.value.knowledgeUnit as KnowledgeUnit).content as Row;
  return { title: content.rule, goalSummary: content.action, reusableKnowledge: [content], appliesTo: content.conditions, exclusions: content.exclusions };
}
function ledgerCandidate(scope: MemoryScope, unit: KnowledgeUnit, value: Row, previous?: KnowledgeEntry): MemoryCandidate {
  return { schema: "agentloop.userMemoryCandidate/v1", id: `ledger:${unit.id}`, ...scope,
    proposedKind: "experience", proposedSubtype: INDEPENDENT_KNOWLEDGE, proposedCanonicalKey: `${INDEPENDENT_KNOWLEDGE}:${unit.id}`,
    proposedExperienceMaturity: "pattern", proposedValue: value, proposedContentMarkdown: JSON.stringify(unit.content),
    persistenceIntent: "future_oriented", authority: "verified_run", sensitivity: "normal", activation: { mode: "explicit_only" }, applicationTargets: ["execution"],
    sourceRefs: unit.evidence, confidence: 0.7, reason: "independent_knowledge_ledger", decision: "accepted", expectedCurrentRevisionId: previous?.revision.id ?? null };
}

/** The current extraction supplies claims, the model supplies identity relations,
 * and original cited executions supply support. A task group is only a case link. */
export function prepareIndependentKnowledge(input: { scope: MemoryScope; learning: Row; sources: Record<string, readonly MemorySourceRef[]>;
  episodes: readonly Row[]; active: readonly KnowledgeEntry[]; admitted: readonly Row[]; groupKey: string }) {
  const records = input.active.filter(entry => entry.item.subtype === INDEPENDENT_KNOWLEDGE);
  const candidates: MemoryCandidate[] = [], units: KnowledgeUnit[] = [];
  for (const [index, content] of input.learning.reusableKnowledge.entries()) {
    if (content.standalone !== true) continue;
    const relation = input.learning.knowledgeRelations?.find((row: Row) => row.claimRef === `reusableKnowledge:${index}`);
    const previous = relation ? records.find(entry => (entry.revision.value.knowledgeUnit as KnowledgeUnit).id === relation.targetKnowledgeId) : undefined;
    const admitted = relation ? input.admitted.find(row => row.knowledgeId === relation.targetKnowledgeId) : undefined;
    if (relation && (!previous || !admitted || previous.revision.value.definitionVersion !== admitted.definitionVersion)) throw new Error("independent_knowledge_definition_conflict");
    const old = previous?.revision.value.knowledgeUnit as KnowledgeUnit | undefined;
    const learning = { ...input.learning, classicPath: [], failureLessons: [], reusableKnowledge: [content],
      knowledgeRelations: relation ? [{ ...relation, claimRef: "reusableKnowledge:0" }] : [] };
    const aligned = alignKnowledgeClaims(learning, old ? [old] : []);
    let unit = accumulateKnowledge(aligned, input.sources, input.episodes, old ? [old] : [], aligned)[0]!;
    // A new, unassociated claim cannot overwrite an identity whose definition
    // has since been revised, nor merge into it by incidental text equality.
    if (!previous && records.some(entry => (entry.revision.value.knowledgeUnit as KnowledgeUnit).id === unit.id)) {
      unit = { ...unit, id: `knowledge_${createHash("sha256").update(JSON.stringify([unit.id, input.groupKey, index,
        records.map(entry => [entry.item.id, entry.revision.value.definitionVersion])])).digest("hex").slice(0, 24)}` };
    }
    const contradicted = relation?.decision === "contradict" || previous?.revision.value.contradicted === true && relation?.decision !== "revise";
    if (contradicted) unit = { ...unit, status: "candidate", ...(unit.assessment ? { assessment: { ...unit.assessment, status: "contradicted" } } : {}) };
    const definitionVersion = Number(previous?.revision.value.definitionVersion ?? 0) + (!previous || relation?.decision !== "support" ? 1 : 0);
    const value = { knowledgeUnit: unit, definitionVersion, contradicted,
      caseGroupKeys: [...new Set([...(previous?.revision.value.caseGroupKeys as string[] ?? []), input.groupKey])] };
    candidates.push(ledgerCandidate(input.scope, unit, value, previous)); units.push(unit);
  }
  return { candidates, units };
}

/** Pure support races can reuse the accepted semantic comparison. A changed
 * definition cannot: the next settlement attempt must compare that version. */
export async function commitKnowledgeCase(input: { store: MemoryStore; scope: MemoryScope; group: MemoryCandidate; learning: Row;
  sources: Record<string, readonly MemorySourceRef[]>; episodes: readonly Row[]; admitted: readonly Row[]; now: number }) {
  for (let pass = 0; pass < 3; pass++) {
    const invalidated = new Set(await input.store.invalidatedRuns(input.scope));
    const episodes = [...input.episodes.filter(episode => !invalidated.has(episode.runId)), ...[...invalidated].map(runId => ({ runId, outcome: "failure" }))];
    const prepared = prepareIndependentKnowledge({ ...input, episodes, active: await input.store.active(input.scope), groupKey: input.group.proposedCanonicalKey! });
    const snapshots = input.group.proposedValue.knowledgeUnits as KnowledgeUnit[] ?? [];
    const group = { ...input.group, proposedValue: { ...input.group.proposedValue,
      // These are immutable case snapshots, never verification authority.
      knowledgeUnits: [...snapshots.filter(unit => !standalone(unit) || !prepared.units.some(updated => updated.id === unit.id)), ...prepared.units],
      independentKnowledgeBindings: [...new Map([
        ...(input.group.proposedValue.independentKnowledgeBindings as Row[] ?? []),
        ...prepared.candidates.map(candidate => ({ knowledgeId: (candidate.proposedValue.knowledgeUnit as KnowledgeUnit).id,
          definitionVersion: candidate.proposedValue.definitionVersion })),
      ].map(binding => [binding.knowledgeId, binding])).values()] } };
    try { await input.store.commitBatch(input.scope, [group, ...prepared.candidates], input.now); return; }
    catch (error) { if (!(error instanceof Error) || error.message !== "task_group_revision_conflict" || pass === 2) throw error; }
  }
}

export async function reconcileIndependentSupport(store: MemoryStore, scope: MemoryScope, episodes: readonly Row[], now: number) {
  for (const entry of await store.active(scope)) {
    if (entry.item.subtype !== INDEPENDENT_KNOWLEDGE) continue;
    const old = entry.revision.value.knowledgeUnit as KnowledgeUnit;
    const unit = revalidateKnowledge([old], episodes)[0]!;
    if (JSON.stringify(unit) !== JSON.stringify(old)) await store.commit(scope,
      ledgerCandidate(scope, unit, { ...entry.revision.value, knowledgeUnit: unit }, entry), now);
  }
}
