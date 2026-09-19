/**
 * Durable knowledge of whether an Action could have changed the outside
 * world. `unknown` is deliberately fail-closed: a caller may only record
 * `not_started` from a completed pre-effect boundary.
 */
export type RuntimeActionEffectState = "not_started" | "unknown" | "applied";

const failureEffects = new WeakMap<object, Extract<RuntimeActionEffectState, "not_started" | "unknown">>();

/** Preserve the original error while carrying its execution-boundary fact. */
export function markActionFailedBeforeEffect(error: unknown): unknown {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    failureEffects.set(error, "not_started");
  }
  return error;
}

export function failureEffectState(error: unknown): Extract<RuntimeActionEffectState, "not_started" | "unknown"> {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    return failureEffects.get(error) ?? "unknown";
  }
  return "unknown";
}
