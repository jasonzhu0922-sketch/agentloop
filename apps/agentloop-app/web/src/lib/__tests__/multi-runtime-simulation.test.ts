import { describe, expect, it } from "vitest";
import { assignmentIdForRun, phaseForRun, projectSimulatedAssignment, runtimeIdForRun } from "../multi-runtime-simulation";

const run = (status: "running" | "completed" | "failed" | "cancelled" = "running") => ({
  id: "run-123", status, createdAt: 10,
}) as never;

describe("multi-runtime simulation projection", () => {
  it("maps a single-node run to a stable assignment and host", () => {
    expect(assignmentIdForRun("run-123")).toBe("sim-assignment-run-123");
    expect(runtimeIdForRun("run-123")).toBe(runtimeIdForRun("run-123"));
    expect(projectSimulatedAssignment(run())).toMatchObject({
      id: "sim-assignment-run-123",
      runId: "run-123",
      status: "running",
      phase: "queued",
    });
  });

  it("derives dispatch phase from authoritative run events and terminal status", () => {
    expect(phaseForRun(run(), [{ seq: 1, type: "planning.started", data: {}, createdAt: 11 }])).toBe("planning");
    expect(phaseForRun(run(), [{ seq: 2, type: "tool.started", data: {}, createdAt: 12 }])).toBe("executing");
    expect(phaseForRun(run("completed"))).toBe("completed");
    expect(phaseForRun(run("failed"))).toBe("failed");
    expect(phaseForRun(run("cancelled"))).toBe("cancelled");
  });
});
