import type { KnowledgeUnit } from "./knowledge.ts";

type Row = Record<string, any>;
export interface KnowledgeRelation {
  readonly claimRef: string;
  readonly targetKnowledgeId: string;
  readonly decision: "support" | "revise" | "contradict";
  readonly rationale: string;
}
export function claimAt(learning: Row, ref: string): { section: KnowledgeUnit["section"]; content: any } | undefined {
  if (ref === "classicPath") return learning.classicPath?.length ? { section: "classicPath", content: learning.classicPath } : undefined;
  const match = /^(reusableKnowledge|failureLessons):(\d+)$/u.exec(ref);
  const content = match ? learning[match[1]!]?.[Number(match[2])] : undefined;
  return content ? { section: match![1] as KnowledgeUnit["section"], content } : undefined;
}
export function relationFor(learning: Row, ref: string): KnowledgeRelation | undefined {
  return (learning.knowledgeRelations as KnowledgeRelation[] | undefined)?.find(item => item.claimRef === ref);
}

/** The model declares semantic equivalence. Supporting it retains the old
 * proposition AND boundaries, so a paraphrase cannot silently broaden a claim.
 * A revision keeps identity but starts a new validation history. */
export function alignKnowledgeClaims(learning: Row, previous: readonly KnowledgeUnit[]): Row {
  const aligned = structuredClone(learning);
  for (const relation of (learning.knowledgeRelations ?? []) as KnowledgeRelation[]) {
    const old = previous.find(unit => unit.id === relation.targetKnowledgeId);
    const current = claimAt(aligned, relation.claimRef);
    if (!old || !current || current.section !== old.section || relation.decision === "revise") continue;
    if (current.section === "classicPath") {
      if (!Array.isArray(old.content) || old.content.length !== current.content.length) throw new Error("knowledge_relation_path_shape_changed");
      aligned.classicPath = old.content.map((step: Row, index: number) => ({ ...step,
        evidenceRefs: current.content[index].evidenceRefs, evidenceAssessment: current.content[index].evidenceAssessment }));
    } else {
      const index = Number(relation.claimRef.split(":")[1]);
      aligned[current.section][index] = { ...(old.content as Row), evidenceRefs: current.content.evidenceRefs,
        ...(current.content.evidenceAssessment ? { evidenceAssessment: current.content.evidenceAssessment } : {}) };
    }
  }
  return aligned;
}

/** Stable IDs accompany an index into the historical learning; no duplicate
 * claim text or support ledger is needed in the prompt. */
export function knowledgeInventory(learning: Row, units: readonly KnowledgeUnit[]) {
  return units.flatMap<Row>(unit => {
    const ref = unit.section === "classicPath" ? "classicPath" : `${unit.section}:${(learning[unit.section] ?? []).findIndex((content: Row) =>
      clean(content) === clean(unit.content))}`;
    if (ref.endsWith(":-1")) return unit.section === "reusableKnowledge" && (unit.content as Row).standalone === true
      ? [{ knowledgeId: unit.id, section: unit.section, kind: (unit.content as Row).kind, content: unit.content, parameters: unit.parameters }] : [];
    return [{ knowledgeId: unit.id, claimRef: ref, section: unit.section,
      ...(unit.section === "classicPath" ? { steps: (unit.content as Row[]).length } : { kind: (unit.content as Row).kind }) }];
  });
}
function clean(value: any): string {
  const normalized = (item: any): any => Array.isArray(item) ? item.map(normalized) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).filter(key => !["evidenceRefs", "evidenceAssessment"].includes(key)).sort().map(key => [key, normalized(item[key])])) : item;
  return JSON.stringify(normalized(value));
}
