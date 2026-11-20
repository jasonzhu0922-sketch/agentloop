import type { MemoryKnowledgeCard } from "@zhujun/agentloop";
import { isDecisionCandidate, knowledgeParameters, type KnowledgeUnit } from "./knowledge.ts";
import { REUSABLE_LEARNING_CONTRACT } from "./learning-paradigm.ts";
import { INDEPENDENT_KNOWLEDGE } from "./independent-knowledge.ts";
import type { MemoryScope, MemoryStore } from "./types.ts";

type Row = Record<string, any>;

/** Execution cards are derived views of the canonical independent ledger.
 * Group revisions are case provenance and cannot renew or retract a claim. */
export async function publishTaskKnowledge(store: MemoryStore, scope: MemoryScope, now: number): Promise<void> {
  const active = await store.active(scope);
  const published = new Set<string>();
  for (const ledger of active.filter(entry => entry.item.subtype === INDEPENDENT_KNOWLEDGE)) {
    const unit = ledger.revision.value.knowledgeUnit as KnowledgeUnit;
    const tentative = isDecisionCandidate(unit);
    if (unit.section !== "reusableKnowledge" || unit.status !== "verified" && !tentative || ledger.revision.value.contradicted === true) continue;
    const content = unit.content as Row;
    if (content.standalone !== true || !["method", "scoped_rule", "decision_rule"].includes(content.kind)) continue;
    // Resource cognition needs explicit selectors and recheck instructions.
    if (content.kind === "scoped_rule" && (!content.resourceContext?.length || !content.recheckRules?.length)) continue;
    const key = `experience.knowledge:${unit.id}`;
    published.add(key);
    const previous = active.find(entry => entry.item.canonicalKey === key);
    if (previous?.revision.value.knowledgeLedgerRevisionId === ledger.revision.id && previous.revision.activation.mode !== "explicit_only") continue;
    const { evidenceRefs: _refs, ...body } = content;
    const card: Omit<MemoryKnowledgeCard, "memoryRevisionId"> = {
      knowledgeId: unit.id, layer: content.kind === "scoped_rule" ? "environment" : "strategy",
      content: { ...body, ...(unit.assessment?.limitations.length ? { evidenceCaveats: unit.assessment.limitations } : {}) }, parameters: unit.parameters ?? knowledgeParameters(body, {}),
      verificationBasis: unit.verificationBasis ?? "independent_executions", requiresVerification: true,
      maturity: tentative ? "candidate" : "verified",
    };
    await store.commit(scope, {
      schema: "agentloop.userMemoryCandidate/v1", id: `memcand_${unit.id}`, ...scope,
      proposedKind: "experience", proposedSubtype: "experience.knowledge", proposedCanonicalKey: key,
      proposedExperienceMaturity: "pattern", proposedValue: {
        learningContract: REUSABLE_LEARNING_CONTRACT, settlementPromptSchemaVersion: "agentloop.semanticSettlement/v2",
        taskKnowledge: card, knowledgeUnits: [unit], knowledgeLedgerId: ledger.item.id, knowledgeLedgerRevisionId: ledger.revision.id,
      },
      proposedContentMarkdown: JSON.stringify(card), persistenceIntent: "future_oriented", authority: "verified_run", sensitivity: "normal",
      activation: { mode: "always" }, applicationTargets: ["execution"], sourceRefs: unit.evidence,
      proposedApplicability: { conditions: content.conditions ?? [], exclusions: content.exclusions ?? [],
        ...(content.resourceContext?.length ? { context: Object.fromEntries(content.resourceContext.map((item: Row) => [item.key, [item.value]])) } : {}) },
      confidence: tentative ? 0.4 : 0.7, reason: "independent_task_knowledge", decision: "accepted",
      expectedCurrentRevisionId: previous?.revision.id ?? null,
    }, now);
  }
  // Refinement, contradiction and evidence retraction stop obsolete knowledge
  // from being recalled. Immutable revisions and historical projections remain.
  for (const { item, revision } of active) {
    if (item.subtype !== "experience.knowledge" || published.has(item.canonicalKey!) || revision.activation.mode === "explicit_only") continue;
    await store.commit(scope, {
      schema: "agentloop.userMemoryCandidate/v1", id: `suspend_${revision.id}`, ...scope,
      proposedKind: item.kind, proposedSubtype: item.subtype, proposedCanonicalKey: item.canonicalKey,
      proposedExperienceMaturity: revision.experienceMaturity, proposedValue: revision.value, proposedContentMarkdown: revision.contentMarkdown,
      proposedApplicability: revision.applicability, persistenceIntent: "future_oriented", authority: revision.authority, sensitivity: revision.sensitivity,
      activation: { mode: "explicit_only" }, applicationTargets: revision.applicationTargets, sourceRefs: revision.sourceRefs,
      confidence: revision.confidence, reason: "task_knowledge_support_retracted", decision: "accepted", expectedCurrentRevisionId: revision.id,
    }, now);
  }
}
