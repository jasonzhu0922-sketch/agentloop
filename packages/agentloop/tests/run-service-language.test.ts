import assert from "node:assert/strict";
import test from "node:test";
import type { ModelAdapter } from "../src/runtime/contracts.ts";
import { DEFAULT_MAX_STEPS, DEFAULT_RUNNER_SYSTEM_PROMPT, MAX_SUPPORTED_STEP_TURNS, recoveryTargetBinding, repairLeafForFailedBoundary, RunService, selectPlanningSkillRoles } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import type { PrivateSkill } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { classifyTaskIntent, understandTask } from "../src/runtime/task-intent.ts";
import {
  approvingTestAssessor,
  singleStepTestPlanner,
  TEST_MODEL_LIMITS,
  testOwner,
} from "./runtime-test-helpers.ts";

test("Evidence strength, output format and available web tools do not select the source channel", () => {
  for (const evidenceDemand of ["lookup_lite", "source_grounded", "strict_user_source"] as const) {
    for (const suffix of ["", "，最终结果用 html 格式文件展示"]) {
      const intent = classifyTaskIntent({ objective: `查询分析某公司的员工画像、人数和性别学历分布${suffix}`,
        evidenceDemand, toolNames: ["websearch", "webfetch", "computer_run_command"] });
      assert.equal(intent.sourceNeed, evidenceDemand);
      assert.equal(intent.researchPolicy, undefined);
    }
  }
  const explicit = classifyTaskIntent({ objective: "从网上查询该公司的员工人数", evidenceDemand: "source_grounded" });
  assert.ok(explicit.researchPolicy);
  const selectedWeb = classifyTaskIntent({ objective: "取得该公司的员工人数", evidenceDemand: "source_grounded", selectedSourceKinds: ["web"] });
  assert.ok(selectedWeb.researchPolicy);
  const selectedDatabase = classifyTaskIntent({ objective: "取得该公司的员工人数", evidenceDemand: "source_grounded", selectedSourceKinds: ["database"] });
  assert.equal(selectedDatabase.researchPolicy, undefined);
  assert.equal(selectedDatabase.sourceNeed, "source_grounded");
  const mixed = classifyTaskIntent({ objective: "核实报告中的人员任职", evidenceDemand: "source_grounded", selectedSourceKinds: ["api", "web"] });
  assert.ok(mixed.researchPolicy);
});

for (const explicitlyNamed of [false, true]) {
  test(`intent resolution does not inherit source scope while Planner retains the catalog (explicit=${explicitlyNamed})`, async () => {
    const database = new AppDatabase(":memory:");
    let planned = false;
    try {
      const skills = new SkillService(database);
      const source = await skills.create("owner", { name: "records-source", description: "REGISTRY-SCOPE-ONLY",
        instructions: "SOURCE-WORKFLOW-TEMPLATE" });
      const goal = `${explicitlyNamed ? "使用 records-source 作为来源之一，" : ""}查询示例公司的董事长和总裁是谁。`;
      const runs = new RunService({ database, skills,
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
          assert.ok(request.runId.startsWith("conversation-turn:"));
          const context = request.runtimeContext?.content ?? "";
          const data = JSON.parse(context.split("\n")[1]);
          assert.deepEqual(data.availableSkills, explicitlyNamed ? [{ id: source.id, name: source.name }] : []);
          assert.doesNotMatch(context, /REGISTRY-SCOPE-ONLY|SOURCE-WORKFLOW-TEMPLATE/);
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "intent", name: "resolve_conversation_turn", arguments: {
            mode: "execute", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
            taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "lookup", requiresExecution: true,
              deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
            evidenceStrategy: "source_grounded", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [],
          } }] };
        } }),
        plannerFactory: () => ({ plan: async (task) => {
          assert.equal(task.canonicalState.intent.userInput, goal);
          assert.ok(task.capabilityRecovery?.availableSkills.some((skill) => skill.id === source.id && skill.description === "REGISTRY-SCOPE-ONLY"));
          planned = true;
          throw new Error("planner-boundary-observed");
        } }),
      });
      await assert.rejects(runs.executeConversation("owner", goal));
      assert.equal(planned, true);
    } finally { database.close(); }
  });
}

test("source-grounded lookup does not nominate every no-artifact primary builder", () => {
  const registry = {
    id: "discovered:company-registry",
    name: "company-registry",
    description: "Query company registration, legal representative, shareholding, and operating scope.",
    agentLoop: {
      roles: ["source_provider"], artifactKinds: ["none"], sourceKinds: ["api"], qaKinds: [],
      semanticTags: ["enterprise-registration", "company-profile", "operating-scope"],
      intentExamples: ["某家公司是一家什么样的企业，说明公司性质、主营业务和经营范围"],
      producesEvidenceKinds: ["source_summary", "explicit_caveats"],
    },
  } as PrivateSkill;
  const workforceData = {
    id: "discovered:workforce-data",
    name: "workforce-data",
    description: "Read employee headcount and workforce records from the HR database.",
    agentLoop: {
      roles: ["source_provider"], artifactKinds: ["none"], sourceKinds: ["database"], qaKinds: [],
      semanticTags: ["workforce-metrics", "employee-data", "human-resources"],
      intentExamples: ["查询某公司员工人数、学历或岗位构成"],
      producesEvidenceKinds: ["source_summary", "explicit_caveats"],
    },
  } as PrivateSkill;
  const workforceAnalysis = {
    id: "discovered:workforce-analysis",
    name: "workforce-analysis",
    description: "Analyze employee headcount, workforce composition, and personnel trends.",
    agentLoop: {
      roles: ["primary_builder"], artifactKinds: ["none"], sourceKinds: ["database"], qaKinds: [],
      semanticTags: ["workforce-analysis", "employee-profile", "human-resources"],
    },
  } as PrivateSkill;
  const steelMarketAnalysis = {
    id: "discovered:steel-market-analysis",
    name: "steel-market-analysis",
    description: "Analyze steel prices and market indicators over time.",
    agentLoop: {
      roles: ["primary_builder"], artifactKinds: ["none"], sourceKinds: ["database"], qaKinds: [],
      semanticTags: ["steel-market", "commodity-price", "time-series-analysis"],
      intentExamples: ["查询指定日期、地区和规格对应的钢材价格或指标数值", "比较钢材指标在一段时间内的走势、区间或涨跌"],
      requiredSkillNames: ["mysql-steel-data"],
    },
  } as PrivateSkill;
  const steelData = {
    id: "discovered:mysql-steel-data",
    name: "mysql-steel-data",
    description: "Read raw steel indicator time-series records from a database.",
    agentLoop: {
      roles: ["source_provider"], artifactKinds: ["none"], sourceKinds: ["database"], qaKinds: [],
      semanticTags: ["steel-data", "database-source", "time-series"],
      intentExamples: ["读取指定钢材指标在明确日期或日期范围内的原始时序记录"],
      producesEvidenceKinds: ["source_summary", "explicit_caveats"],
    },
  } as PrivateSkill;
  const understanding = understandTask({
    objective: "欧冶工业品是一家什么样的公司？请基于公开信息说明公司性质、主营业务和产业链定位。",
    evidenceDemand: "source_grounded",
  });

  const selected = selectPlanningSkillRoles([registry, workforceData, workforceAnalysis, steelMarketAnalysis, steelData], understanding, []);

  assert.deepEqual(selected.map((item) => ({ id: item.skill.id, role: item.selection.role })), [{
    id: registry.id,
    role: "source_provider",
  }]);
});

test("recovery plan projection retains canonical delivery target ownership", () => {
  const binding = {
    targetIds: ["receipt-standard-excel"],
    artifactTargets: [{ id: "receipt-standard-excel", purpose: "Workbook", kind: "spreadsheet", format: "excel", terminalRequired: true }],
  } as never;

  assert.deepEqual(recoveryTargetBinding(binding), {
    targetIds: ["receipt-standard-excel"],
  });
});

test("failed-boundary repair leaf preserves the original artifact and source contract", () => {
  const target = {
    id: "produce-presentation",
    kind: "leaf",
    objective: "Create, validate, and deliver the requested crowdfunding PPTX.",
    dependencies: ["research"],
    role: "deliver",
    refinementState: "not_refinable",
    requiredFacts: [{ id: "brief", description: "Use the approved brief.", evidenceKinds: ["source_summary"] }],
    skillIds: ["pptx"],
    requiredCapabilities: ["computer_run_command"],
    executionBinding: {
      targetIds: ["crowdfunding-pptx"],
      requiredUploadedSourceIds: ["source-brief"],
      requiredToolSourceIds: ["tool-source-brief"],
      requiredVisibleDirectoryIds: ["visible-brand-assets"],
    },
    evidenceContract: { requiredKinds: ["artifact_path", "artifact_acceptance", "delivery_receipt"], caveatPolicy: "none" },
    successCriteria: [{ id: "presentation-ready", description: "A validated presentation is delivered.", source: "task" }],
  } as never;

  const repair = repairLeafForFailedBoundary(target, {
    stepId: "produce-presentation",
    missingEvidenceKinds: ["artifact_path", "artifact_acceptance", "delivery_receipt"],
    violatedSkillRequirements: [],
    reusableEvidenceRefs: ["tool-call-1"],
    suggestedRepairShape: "repair_leaf",
  }, 4);

  assert.match(repair.objective, /Create, validate, and deliver the requested crowdfunding PPTX/);
  assert.match(repair.objective, /Produce, verify, and deliver the original admissible output/);
  assert.deepEqual(repair.targetIds, ["crowdfunding-pptx"]);
  assert.deepEqual(repair.sourceConstraint, {
    requiredUploadedSourceIds: ["source-brief"],
    requiredToolSourceIds: ["tool-source-brief"],
    requiredVisibleDirectoryIds: ["visible-brand-assets"],
  });
  assert.deepEqual(repair.successCriteria, target.successCriteria);
});

test("RunService makes Simplified Chinese the default user-facing execution language", async () => {
  const database = new AppDatabase(":memory:");
  try {
    let executionSystemPrompt = "";
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        executionSystemPrompt = request.systemPrompt;
        return { content: "已完成。", finishReason: "stop", toolCalls: [] };
      },
    };
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.execute(testOwner().user.id, "Summarize this briefly");

    assert.equal(run.status, "completed");
    assert.match(
      DEFAULT_RUNNER_SYSTEM_PROMPT,
      /默认使用简体中文与用户沟通；除非用户明确要求使用其他语言，用户可见的自然语言回复应优先使用简体中文/,
    );
    assert.ok(
      executionSystemPrompt.indexOf("默认使用简体中文与用户沟通") < executionSystemPrompt.indexOf("<runtime_contract>"),
      "the default Chinese-language instruction must precede the runtime contract",
    );
    assert.match(
      executionSystemPrompt,
      /Unless the user explicitly requests another language, all user-facing natural-language output must be in Simplified Chinese\./,
    );
    assert.match(
      executionSystemPrompt,
      /Preserve code, commands, paths, API fields, and proper nouns in their original form\./,
    );
  } finally {
    database.close();
  }
});

test("RunService enforces the configured model-turn budget for each Plan step", async () => {
  const database = new AppDatabase(":memory:");
  try {
    let executionTurns = 0;
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      complete: async (request) => {
        if ((request.runtimeContext?.content ?? "").includes("<runtime_failure_report>")) {
          return { content: "本步骤达到执行回合上限，尚未形成可验证结果。", finishReason: "stop", toolCalls: [] };
        }
        executionTurns += 1;
        return { content: "", finishReason: "length", toolCalls: [] };
      },
    };
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async (task) => ({
          goal: task.canonicalState.intent.userInput,
          schema: "agentloop.outcomePlan/v2" as const,
          shape: "single_leaf" as const,
          selectedSkillIds: [],
          steps: [{
            id: "conversation-only",
            objective: task.canonicalState.intent.userInput,
            dependencies: [],
            role: "deliver" as const,
            skillIds: [],
            requiredCapabilities: ["conversation_delivery"],
            evidenceContract: { requiredKinds: ["delivery_receipt"], caveatPolicy: "none" as const },
            successCriteria: [{ id: "answered", description: "Return a direct answer.", source: "task" as const }],
          }],
        }),
      }),
      assessorFactory: () => approvingTestAssessor(),
      maxSteps: 1,
    });

    const owner = testOwner();
    await assert.rejects(runs.execute(owner.user.id, "Return a direct answer."), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "RUN_LIMIT_EXCEEDED");
      return true;
    });
    assert.ok(executionTurns >= 1);
    const run = (await runs.list(owner.user.id))[0];
    assert.ok(run);
    const limitEvent = (await runs.events(owner.user.id, run.id)).find((event) => event.type === "loop.limit_exceeded");
    assert.equal(limitEvent?.data.maxSteps, 1);
    assert.equal(limitEvent?.data.candidateRepairGraceSteps, 4);
  } finally {
    database.close();
  }
});

test("RunService rejects unsafe configured per-Step turn budgets", () => {
  const database = new AppDatabase(":memory:");
  try {
    const options = {
      database,
      skills: new SkillService(database),
      modelFactory: () => ({
        limits: TEST_MODEL_LIMITS,
        complete: async () => ({ content: "", finishReason: "stop" as const, toolCalls: [] }),
      }),
    };
    assert.throws(() => new RunService({ ...options, maxSteps: 0 }), /maxSteps must be a positive safe integer/);
    assert.throws(() => new RunService({ ...options, maxSteps: MAX_SUPPORTED_STEP_TURNS + 1 }), /maxSteps must be a positive safe integer/);
    assert.equal(DEFAULT_MAX_STEPS, 32);
  } finally {
    database.close();
  }
});

test("hidden reasoning is absent from public Run events but retained for recovery", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      reasoningVisibility: "hidden",
      complete: async () => ({
        content: "已完成。",
        finishReason: "stop",
        toolCalls: [],
        reasoningContent: "opaque-provider-continuation-state",
      }),
    };
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const owner = testOwner();
    const run = await runs.execute(owner.user.id, "只回复完成状态");
    const publicCheckpoint = (await runs.events(owner.user.id, run.id))
      .find((event) => event.type === "assistant.committed");
    assert.equal(publicCheckpoint?.data.reasoningContent, undefined);
    assert.equal(publicCheckpoint?.data.privateReasoningContent, undefined);

    const stored = await database.prepare("SELECT payload_json FROM run_events WHERE run_id = ? AND type = ?")
      .get(run.id, "assistant.committed") as { payload_json: string } | undefined;
    assert.ok(stored);
    const storedCheckpoint = JSON.parse(stored.payload_json) as Record<string, unknown>;
    assert.equal(storedCheckpoint.privateReasoningContent, "opaque-provider-continuation-state");
  } finally {
    database.close();
  }
});
