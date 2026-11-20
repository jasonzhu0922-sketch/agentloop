import { claimAt } from "./knowledge-relations.ts";

type Row = Record<string, any>;
type Issue = { path: string; code: string };
export interface RepairTarget { path: string; section: string; index: number; field?: string; current: unknown; context?: unknown; schema: Row }

/** Repair independent advisory items or a path's assessment, never splice the
 * ordered method or change its global scope/identity as a mechanical repair. */
export function settlementRepairTargets(output: Row, errors: readonly Issue[], schema: Row): RepairTarget[] | undefined {
  const targets = new Map<string, RepairTarget>();
  for (const error of errors) {
    if (["execution_review_required", "knowledge_support_scope_changed", "knowledge_revision_requires_refine"].includes(error.code)) return undefined;
    const match = /^\$\.(reusableKnowledge|failureLessons|toolUsage)\[(\d+)\](?:\.|$)/u.exec(error.path);
    const assessment = /^\$\.(classicPath)\[(\d+)\]\.evidenceAssessment(?:\.|$)/u.exec(error.path);
    const relation = error.code === "enum_invalid" ? /^\$\.(knowledgeRelations)\[(\d+)\]\.decision$/u.exec(error.path) : undefined;
    const selected = match ?? assessment ?? relation;
    if (!selected) return undefined;
    const section = selected[1]!, index = Number(selected[2]), field = assessment ? "evidenceAssessment" : undefined;
    const current = field ? output[section]?.[index]?.[field] : output[section]?.[index];
    if (!current) return undefined;
    const path = `$.${section}[${index}]${field ? `.${field}` : ""}`;
    const itemSchema = schema.properties[section].items;
    const repairSchema = field ? structuredClone(itemSchema.properties[field]) : { anyOf: [structuredClone(itemSchema), { const: null }] };
    if (field) repairSchema.properties.evidenceRefs.items = { type: "string", enum: output[section][index].evidenceRefs };
    if (relation && output.merge?.decision === "reinforce") repairSchema.anyOf[0].properties.decision = { const: "support" };
    targets.set(path, { path, section, index, ...(relation ? { context: { currentClaim: claimAt(output, output[section][index].claimRef),
      merge: output.merge, scope: { appliesTo: output.appliesTo, exclusions: output.exclusions, parameters: output.reuse?.parameters },
      instruction: "The merge decision and claim are fixed during this local repair. Reinforce permits support only. Judge the supplied claim against its historical target. For a new unrelated claim withdraw this relation with null; no relationship is needed." } } : {}), ...(field ? { field, context: { claim: output[section][index].objective,
      conditions: output[section][index].conditions, verification: output[section][index].verification, allowedEvidenceRefs: output[section][index].evidenceRefs } } : {}), current,
      schema: repairSchema });
  }
  return targets.size && targets.size <= 12 ? [...targets.values()] : undefined;
}

export function repairResponseSchema(targets: readonly RepairTarget[]) {
  return { type: "object", additionalProperties: false, required: ["repairs"], properties: {
    repairs: { type: "array", minItems: targets.length, maxItems: targets.length, items: { anyOf: targets.map(target => ({ type: "object",
      additionalProperties: false, required: ["path", "value"], properties: { path: { const: target.path }, value: target.schema } })) } },
  } };
}

/** Replacement paths are exact, unique and pre-admitted. Null can remove only
 * the selected independent item; it is persisted as a rejected proposal. */
export function applySettlementRepairs(output: Row, repairs: readonly Row[], targets: readonly RepairTarget[]) {
  if (repairs.length !== targets.length || new Set(repairs.map(row => row.path)).size !== targets.length) throw new Error("local_repair_coverage");
  const learning = structuredClone(output), removed = new Map<string, Set<number>>();
  for (const repair of repairs) {
    const target = targets.find(item => item.path === repair.path);
    if (!target) throw new Error("local_repair_path");
    if (target.field) {
      if (repair.value === null) throw new Error("local_repair_core_removal");
      learning[target.section][target.index][target.field] = repair.value;
    } else if (repair.value === null) {
      const indices = removed.get(target.section) ?? new Set<number>(); indices.add(target.index); removed.set(target.section, indices);
    } else learning[target.section][target.index] = repair.value;
  }
  for (const [section, indices] of removed) {
    learning[section] = learning[section].filter((_row: unknown, index: number) => !indices.has(index));
    if (learning.knowledgeRelations) learning.knowledgeRelations = learning.knowledgeRelations.flatMap((relation: Row) => {
      if (!relation.claimRef.startsWith(`${section}:`)) return [relation];
      const index = Number(relation.claimRef.split(":")[1]);
      return indices.has(index) ? [] : [{ ...relation, claimRef: `${section}:${index - [...indices].filter(removed => removed < index).length}` }];
    });
  }
  return { learning, removed: targets.filter(target => !target.field && removed.get(target.section)?.has(target.index)) };
}
