import { MAX_SUPPORTED_PLANNING_TURNS, MAX_SUPPORTED_STEP_TURNS } from "@zhujun/agentloop";

/** Local Agent defaults documented in the device-owned configuration template. */
export const DEFAULT_LOCAL_AGENT_PLANNING_MAX_TURNS = 8;
export const DEFAULT_LOCAL_AGENT_STEP_MAX_TURNS = 64;

export interface LocalAgentTurnLimits {
  readonly planningMaxTurns: number;
  readonly stepMaxTurns: number;
}

/**
 * Resolve the Local Agent's device-owned turn budgets. These defaults are
 * intentionally separate from the cloud Runtime defaults: a downloaded
 * Local Agent is expected to run with the 8/64 contract even before a user
 * creates an integration .env file.
 */
export function localAgentTurnLimits(environment: Readonly<Record<string, string | undefined>>): LocalAgentTurnLimits {
  return {
    planningMaxTurns: boundedTurnLimit(
      environment.PLANNING_MAX_TURNS,
      DEFAULT_LOCAL_AGENT_PLANNING_MAX_TURNS,
      MAX_SUPPORTED_PLANNING_TURNS,
      "PLANNING_MAX_TURNS",
    ),
    stepMaxTurns: boundedTurnLimit(
      environment.STEP_MAX_TURNS,
      DEFAULT_LOCAL_AGENT_STEP_MAX_TURNS,
      MAX_SUPPORTED_STEP_TURNS,
      "STEP_MAX_TURNS",
    ),
  };
}

function boundedTurnLimit(value: string | undefined, fallback: number, maximum: number, name: string): number {
  const result = Number(value ?? fallback);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return result;
}
