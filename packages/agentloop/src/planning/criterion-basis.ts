import type { CanonicalRunState } from "../runtime/canonical-run-state.ts";
import { badRequest } from "../shared/errors.ts";
import { requireRecord, requireString, requireStringArray } from "../shared/validation.ts";
import type { CriterionBasis, SuccessCriterion } from "./contracts.ts";

/**
 * Model-facing basis shape. Provenance text is Runtime-owned and is bound from
 * the canonical intent after the model response is parsed.
 */
export const MODEL_CRITERION_BASIS_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["kind", "intentId", "targetIds", "rationale"],
  properties: {
    kind: { type: "string", enum: ["user_requirement", "necessary_condition", "execution_method"] },
    intentId: { type: "string" },
    targetIds: { type: "array", items: { type: "string" } },
    rationale: { type: "string", description: "Explain the relation to the requested result. A necessary condition must explain why the result cannot be valid without it." },
  },
} as const;

export function parseModelCriterionBasis(value: unknown, name: string, state: CanonicalRunState): CriterionBasis {
  const record = requireRecord(value, name);
  const unexpected = Object.keys(record).filter((key) => !Object.hasOwn(MODEL_CRITERION_BASIS_SCHEMA.properties, key));
  if (unexpected.length > 0) {
    throw badRequest(`${name} contains unsupported fields: ${unexpected.join(", ")}; requirement is Runtime-owned and must not be submitted`);
  }
  const kind = requireString(record.kind, `${name}.kind`, { max: 32 });
  if (kind !== "user_requirement" && kind !== "necessary_condition" && kind !== "execution_method") {
    throw badRequest(`${name}.kind is invalid`);
  }
  return {
    kind, intentId: requireString(record.intentId, `${name}.intentId`, { max: 128 }),
    targetIds: requireStringArray(record.targetIds, `${name}.targetIds`, 100),
    requirement: state.intent.userInput,
    rationale: requireString(record.rationale, `${name}.rationale`, { max: 4_000 }),
  };
}

/** Runtime derives provenance for its own goal/delivery conditions, never a new goal. */
export function goalCriterionBasis(
  state: CanonicalRunState, targetIds: readonly string[], kind: CriterionBasis["kind"], rationale: string,
): CriterionBasis {
  return { kind, intentId: state.intent.id, targetIds, requirement: state.intent.userInput, rationale };
}

export function assertCriterionBasis(basis: CriterionBasis, state: CanonicalRunState, ownedTargetIds: readonly string[]): void {
  if (basis.intentId !== state.intent.id) throw badRequest("Criterion basis must reference this canonical intent");
  if (basis.requirement !== state.intent.userInput) {
    throw badRequest("Criterion basis requirement is Runtime-owned and must equal the original user input");
  }
  if (!basis.rationale.trim()) throw badRequest("Criterion basis must explain its relation to the user goal");
  if (new Set(basis.targetIds).size !== basis.targetIds.length
    || basis.targetIds.some((id) => state.targets[id] === undefined || !ownedTargetIds.includes(id))) {
    throw badRequest("Criterion basis must reference owned canonical targets");
  }
}

/** Only grounded result conditions can block; method checks remain useful observations. */
export function admitCriterionBasis(
  criterion: SuccessCriterion, state: CanonicalRunState, ownedTargetIds: readonly string[],
  runtimeDeliveryCondition: boolean,
): SuccessCriterion {
  const basis = criterion.basis ?? goalCriterionBasis(state,
    criterion.targetId === undefined ? ownedTargetIds : [criterion.targetId],
    criterion.source === "task" ? "user_requirement" : "necessary_condition",
    runtimeDeliveryCondition
      ? "The requested result must exist in the declared delivery surface and be accessible in its requested format."
      : criterion.description);
  assertCriterionBasis(basis, state, ownedTargetIds);
  if (basis.kind === "execution_method" && criterion.blocking === true) {
    throw badRequest(`Execution method criterion ${criterion.id} cannot become a blocking user obligation`);
  }
  return { ...criterion, basis };
}
