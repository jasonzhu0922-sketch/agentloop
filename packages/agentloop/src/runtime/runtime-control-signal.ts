import {
  humanLoopRequirementFromUnknown,
  type HumanLoopRequirement,
} from "./human-loop.ts";

/**
 * A Runtime-owned instruction transported alongside Tool output. It is not
 * inferred from ordinary files or model prose.
 */
export interface HumanLoopControlSignal {
  readonly schema: "agentloop.runtimeControlSignal/v1";
  readonly kind: "human_loop";
  readonly requirement: HumanLoopRequirement;
}

export function createHumanLoopControlSignal(value: unknown): HumanLoopControlSignal | undefined {
  const requirement = humanLoopRequirementFromUnknown(value);
  return requirement === undefined
    ? undefined
    : { schema: "agentloop.runtimeControlSignal/v1", kind: "human_loop", requirement };
}

export function humanLoopControlSignalFromUnknown(value: unknown): HumanLoopControlSignal | undefined {
  if (!isPlainRecord(value)
    || value.schema !== "agentloop.runtimeControlSignal/v1"
    || value.kind !== "human_loop") return undefined;
  return createHumanLoopControlSignal(value.requirement);
}

export function firstHumanLoopControlSignal(value: unknown): HumanLoopControlSignal | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const candidate of value) {
    const signal = humanLoopControlSignalFromUnknown(candidate);
    if (signal !== undefined) return signal;
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
