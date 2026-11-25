import { acceptedCanonicalDelivery, canonicalRunStateRef, type CanonicalRunState } from "./canonical-run-state.ts";

/** Model view only. Admission, Assessment and committers keep the full authority. */
export function projectCanonicalDecisionBasis(state: CanonicalRunState) {
  const acceptedOwners = new Set(Object.values(state.targets).flatMap(target => acceptedCanonicalDelivery(target) === undefined ? [] : target.ownerStepIds));
  const steps = Object.fromEntries(Object.entries(state.steps).filter(([id, step]) => step.status !== "retired" && (step.status !== "satisfied" || acceptedOwners.has(id))));
  const gaps = state.gaps.filter(gap => gap.status === "open");
  const targets = Object.fromEntries(Object.entries(state.targets).map(([id, target]) => {
    const accepted = acceptedCanonicalDelivery(target);
    return [id, { ...target, claims: accepted === undefined ? [] : [accepted] }];
  }));
  return { ...state, steps, gaps, targets,
    history: { canonicalState: canonicalRunStateRef(state), historicalStepCount: Object.keys(state.steps).length - Object.keys(steps).length,
      resolvedGapCount: state.gaps.length - gaps.length,
      instruction: "This is a projection of the identified canonical revision. Closed gaps, retired steps and superseded claims remain persisted; their absence here is not evidence that an operation never occurred. Exact user amendments are retained. Open gaps can close only through canonical transitions, never through model context items." },
  };
}
