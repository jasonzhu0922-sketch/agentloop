import { AppError } from "../shared/errors.ts";
import { requireRecord, requireString, requireStringArray } from "../shared/validation.ts";
import type { CanonicalRunState } from "../runtime/canonical-run-state.ts";
import type { PlanProposal, RoundScope } from "./contracts.ts";

export const ROUND_SCOPE_SCHEMA = {
  type: ["object", "null"], additionalProperties: false,
  required: ["kind", "targetIds", "purpose", "completionBoundary", "continuation"],
  properties: {
    kind: { type: "string", enum: ["delivery", "prerequisite"] },
    targetIds: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
    purpose: { type: "string" }, completionBoundary: { type: "string" }, continuation: { type: "string" },
  },
} as const;

export function parseRoundScope(value: unknown): RoundScope | undefined {
  if (value === undefined || value === null) return undefined;
  const record = requireRecord(value, "roundScope");
  if (Object.keys(record).some((key) => !Object.hasOwn(ROUND_SCOPE_SCHEMA.properties, key))) {
    throw new AppError("PLAN_NOT_ADMITTED", "Unknown Round scope field", 422);
  }
  const kind = requireString(record.kind, "roundScope.kind", { max: 32 });
  if (kind !== "delivery" && kind !== "prerequisite") throw new AppError("PLAN_NOT_ADMITTED", "Unknown Round scope kind", 422);
  const targetIds = requireStringArray(record.targetIds, "roundScope.targetIds", 8);
  if (targetIds.length === 0 || new Set(targetIds).size !== targetIds.length) {
    throw new AppError("PLAN_NOT_ADMITTED", "Round scope requires distinct canonical targets", 422);
  }
  return { kind, targetIds, purpose: requireString(record.purpose, "roundScope.purpose", { max: 4000 }),
    completionBoundary: requireString(record.completionBoundary, "roundScope.completionBoundary", { max: 4000 }),
    continuation: requireString(record.continuation, "roundScope.continuation", { max: 4000 }) };
}

/** A prerequisite advances open targets but cannot accept or own them. */
export function validateRoundScope(proposal: PlanProposal, state: CanonicalRunState, allowedTargetIds?: readonly string[]): RoundScope | undefined {
  const scope = parseRoundScope(proposal.roundScope);
  if (scope === undefined) return undefined;
  if (scope.targetIds.some((id) => state.targets[id] === undefined || state.targets[id]!.status === "accepted"
    || allowedTargetIds !== undefined && !allowedTargetIds.includes(id))) {
    throw new AppError("PLAN_NOT_ADMITTED", "Round scope must reference open, allowed canonical targets", 422);
  }
  if (scope.kind === "prerequisite") {
    const grounding = new Set(["source_summary", "source_urls", "schema_summary", "record_counts", "table_coverage", "structured_extraction_artifact"]);
    if (proposal.steps.length === 0 || proposal.steps.some((step) => step.kind === "milestone" || step.role !== "fact_acquisition"
      || (step.targetIds?.length ?? 0) > 0 || !step.evidenceContract?.requiredKinds.some((kind) => grounding.has(kind)))) {
      throw new AppError("PLAN_NOT_ADMITTED", "A prerequisite Round requires assessable source-acquisition leaves with no delivery ownership", 422);
    }
  }
  return scope;
}
