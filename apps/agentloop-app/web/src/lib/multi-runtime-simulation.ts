import type { RunEvent, RunRecord, RunStatus } from "./types";

/**
 * Frontend-only topology used by the single-node app while it exercises the
 * Multi Runtime UI contract. It never pretends to be a second executor: the
 * Run API and event stream remain authoritative.
 */
export interface RuntimeHostSummary {
  readonly id: string;
  readonly profile: "local-simulated";
  readonly status: "ready";
  readonly maxConcurrentRuns: number;
}

export interface SimulatedAssignment {
  readonly id: string;
  readonly runId: string;
  readonly runtimeId: string;
  readonly status: RunStatus;
  readonly phase: "queued" | "planning" | "executing" | "finalizing" | "completed" | "failed" | "cancelled";
  readonly updatedAt: number;
}

export const SIMULATED_RUNTIME_HOSTS: readonly RuntimeHostSummary[] = [
  { id: "local-runtime-01", profile: "local-simulated", status: "ready", maxConcurrentRuns: 4 },
  { id: "local-runtime-02", profile: "local-simulated", status: "ready", maxConcurrentRuns: 4 },
  { id: "local-runtime-03", profile: "local-simulated", status: "ready", maxConcurrentRuns: 4 },
];

export function assignmentIdForRun(runId: string): string {
  return `sim-assignment-${runId}`;
}

export function runtimeIdForRun(runId: string, hosts = SIMULATED_RUNTIME_HOSTS): string {
  if (hosts.length === 0) return "local-runtime-01";
  let hash = 0;
  for (const character of runId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hosts[hash % hosts.length].id;
}

export function phaseForRun(run: Pick<RunRecord, "status">, events: readonly RunEvent[] = []): SimulatedAssignment["phase"] {
  if (run.status === "completed") return "completed";
  if (run.status === "failed") return "failed";
  if (run.status === "cancelled") return "cancelled";
  const latest = events[events.length - 1]?.type ?? "";
  if (latest.startsWith("plan.") || latest === "planning.started") return "planning";
  if (latest.startsWith("tool.") || latest.startsWith("step.") || latest.startsWith("model.")) return "executing";
  if (latest === "run.completed" || latest === "artifact.accepted") return "finalizing";
  return events.length === 0 ? "queued" : "executing";
}

export function projectSimulatedAssignment(
  run: RunRecord,
  events: readonly RunEvent[] = [],
  hosts = SIMULATED_RUNTIME_HOSTS,
): SimulatedAssignment {
  return {
    id: assignmentIdForRun(run.id),
    runId: run.id,
    runtimeId: runtimeIdForRun(run.id, hosts),
    status: run.status,
    phase: phaseForRun(run, events),
    updatedAt: run.finishedAt ?? run.createdAt,
  };
}
