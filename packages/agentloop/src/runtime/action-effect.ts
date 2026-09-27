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
    const marked = failureEffects.get(error);
    if (marked !== undefined) return marked;
    const details = isRecord(error) && isRecord(error.details) ? error.details : undefined;
    const receipt = details !== undefined && isRecord(details.executionReceipt)
      ? details.executionReceipt
      : undefined;
    if (receipt?.startState === "not_started") return "not_started";
  }
  return "unknown";
}

/**
 * A Tool may return a failed operation normally. Its neutral execution receipt
 * (not a tool name or command string) determines the Action effect boundary.
 */
export function failedResultEffectState(value: unknown): RuntimeActionEffectState {
  if (!isRecord(value)) return "unknown";
  const receipt = isRecord(value.executionReceipt) ? value.executionReceipt : undefined;
  if (receipt?.startState === "not_started") return "not_started";
  // A bounded executor may prove that a started command's entire effect scope
  // was observed. Arbitrary host commands deliberately report `unbounded`, so
  // they remain fail-closed even when their workspace diff is empty.
  if (
    receipt?.startState === "started"
    && receipt.effectScope === "workspace"
    && isRecord(receipt.workspaceFileChanges)
    && receipt.workspaceFileChanges.coverage === "complete"
  ) {
    return "applied";
  }
  return "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
