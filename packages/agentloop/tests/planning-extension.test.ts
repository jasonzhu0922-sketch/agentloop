import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Planner, TaskSpec } from "../src/planning/contracts.ts";
import type { PlanningExtension } from "../src/planning/extensions.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { approvingTestAssessor } from "./runtime-test-helpers.ts";

test("planning extension context is passed to the normal Planner without admitting a Plan", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-planning-extension-"));
  const database = new AppDatabase(":memory:");
  try {
    const planner = new ContextAssertingPlanner();
    const extension: PlanningExtension = {
      name: "focused-extension",
      beforePlanning: async () => ({
        kind: "planner_context",
        context: {
          schema: "agentloop.planningExtensionContext/v1",
          extensionName: "focused-extension",
          kind: "test_hint",
          content: { templateId: "test-template" },
        },
      }),
    };
    const eventLines: string[] = [];
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      modelFactory: () => new StaticModel("extension context output"),
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
      planningExtensions: [extension],
      runEventLogSink: (line) => eventLines.push(line),
    });

    const run = await runs.execute("owner", "answer with extension context", {
      allowDangerousTools: false,
    });

    assert.equal(run.status, "completed");
    assert.equal(planner.seenContext, true);
    assert.match(run.output ?? "", /extension context output/);
    const decision = (await runs.events("owner", run.id)).find((event) => event.type === "planning.extension.decision");
    assert.equal(decision?.data.kind, "planner_context");
    assert.equal(decision?.data.contextKind, "test_hint");
    assert.equal(decision?.data.templateId, "test-template");
    assert.match(eventLines.find((line) => line.includes("planning.extension.decision")) ?? "", /kind="planner_context"/);
    assert.match(eventLines.find((line) => line.includes("planning.extension.decision")) ?? "", /templateId="test-template"/);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("planning extension errors fail open to the normal Planner", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-planning-extension-fail-open-"));
  const database = new AppDatabase(":memory:");
  try {
    const extension: PlanningExtension = {
      name: "broken-extension",
      beforePlanning: async () => {
        throw new Error("boom");
      },
    };
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      modelFactory: () => new StaticModel("planner still ran"),
      plannerFactory: () => new ContextAssertingPlanner(false),
      assessorFactory: () => approvingTestAssessor(),
      planningExtensions: [extension],
    });

    const run = await runs.execute("owner", "answer despite extension failure", {
      allowDangerousTools: false,
    });
    const failedEvent = (await runs.events("owner", run.id)).find((event) => event.type === "planning.extension.failed");

    assert.equal(run.status, "completed");
    assert.equal(failedEvent?.data.extensionName, "broken-extension");
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("final admission records both rejected extension and fallback Planner candidates", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-planning-admission-"));
  const database = new AppDatabase(":memory:");
  try {
    const proposal = { goal: "Produce the requested answer", selectedSkillIds: [], steps: [] };
    const extension: PlanningExtension = {
      name: "invalid-extension",
      beforePlanning: async () => ({
        kind: "plan_proposal", proposal,
        source: { kind: "planning_extension", extensionName: "invalid-extension" },
      }),
    };
    const runs = new RunService({ database, skills: new SkillService(database), workspaceRoot: workspace,
      modelFactory: () => new StaticModel("unused"),
      plannerFactory: () => ({ plan: async () => proposal }),
      planningExtensions: [extension],
    });
    let runId = "";
    await assert.rejects(runs.execute("owner", "Produce the requested answer"), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PLAN_NOT_ADMITTED");
      runId = String((error as { details?: { runId?: string } }).details?.runId ?? "");
      return true;
    });
    assert.ok(runId);
    const events = await runs.events("owner", runId);
    const failures = events.filter((event) => event.type === "planning.final_admission.failed");
    assert.equal(failures.length, 2);
    assert.deepEqual(failures.map((event) => event.data), [
      { stage: "final_admission", errorCode: "PLAN_NOT_ADMITTED",
        source: { kind: "planning_extension", extensionName: "invalid-extension" } },
      { stage: "final_admission", errorCode: "PLAN_NOT_ADMITTED" },
    ]);
    assert.ok(failures[0]!.seq < failures[1]!.seq);
    assert.equal((await runs.get("owner", runId)).status, "failed");
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

class ContextAssertingPlanner implements Planner {
  seenContext = false;
  private readonly requireContext: boolean;

  constructor(requireContext = true) {
    this.requireContext = requireContext;
  }

  async plan(task: TaskSpec) {
    this.seenContext = (task.planningExtensionContexts?.length ?? 0) > 0;
    if (this.requireContext) assert.equal(this.seenContext, true);
    return {
      goal: task.canonicalState.intent.userInput,
      schema: "agentloop.outcomePlan/v2" as const,
      shape: "single_leaf" as const,
      selectedSkillIds: [],
      steps: [{
        id: "answer",
        objective: task.canonicalState.intent.userInput,
        dependencies: [],
        role: "deliver" as const,
        skillIds: [],
        requiredCapabilities: [],
        evidenceContract: { requiredKinds: ["delivery_receipt" as const], caveatPolicy: "none" as const },
        successCriteria: [{
          id: "answered",
          description: "The direct answer is produced.",
          source: "task" as const,
        }],
      }],
    };
  }
}

class StaticModel implements ModelAdapter {
  readonly limits = { contextWindowTokens: 1_000_000, maxOutputTokens: 8_192 };
  private readonly content: string;

  constructor(content: string) {
    this.content = content;
  }

  async complete(_invocation: ModelInvocation): Promise<ModelResponse> {
    return {
      content: this.content,
      toolCalls: [],
      finishReason: "stop",
    };
  }
}
