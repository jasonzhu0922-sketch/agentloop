import { claimAt } from "../../src/knowledge-relations.ts";
import { KNOWLEDGE_COMPARISON } from "../../src/knowledge-comparison.ts";

/** Project test model decisions into the production comparison contract. This
 * is fixture encoding only; production never accepts a full rewritten learning
 * as an alternative to a relation-only response. */
export function comparisonFixture(input: any, learning: any): any {
  if (!input.comparisonContract) return learning;
  const group = input.similarTaskGroups.find((row: any) => row.id === learning.merge.targetGroupId);
  const relations = learning.knowledgeRelations ?? (learning.merge.decision === "reinforce" ? (group?.knowledge ?? []).flatMap((unit: any) => {
    if (!unit.claimRef || !claimAt(learning, unit.claimRef)) return [];
    return [{ claimRef: unit.claimRef, targetKnowledgeId: unit.knowledgeId, decision: "support", rationale: "Fixture judges the unchanged method under its original boundary" }];
  }) : []);
  return { schema: KNOWLEDGE_COMPARISON, rationale: "Fixture compares the fixed proposal with the historical method and boundary", merge: learning.merge,
    knowledgeRelations: relations.map((relation: any) => {
      const claim = claimAt(learning, relation.claimRef);
      const rows = claim?.section === "classicPath" ? claim.content : claim ? [claim.content] : [];
      return { ...relation, assessments: rows.map((row: any) => {
        const { evidenceRefs: _refs, ...assessment } = row.evidenceAssessment ?? { status: "tentative", rationale: "No fixture judgment", limitations: [] };
        return assessment;
      }) };
    }) };
}
