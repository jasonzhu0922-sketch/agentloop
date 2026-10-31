import assert from "node:assert/strict";
import test from "node:test";
import type { ModelAdapter } from "../src/runtime/contracts.ts";
import { DEFAULT_MAX_STEPS, DEFAULT_RUNNER_SYSTEM_PROMPT, MAX_SUPPORTED_STEP_TURNS, memorySettlementCommitRef, recoveryTargetBinding, repairLeafForFailedBoundary, RunService, selectPlanningSkillRoles } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import type { PrivateSkill } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { classifyTaskIntent, understandTask } from "../src/runtime/task-intent.ts";
import type { AgentLoopMemoryPlugin, ExplicitMemoryCommitRequest, PlanningMemoryProjection } from "../src/runtime/memory-plugin.ts";
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

test("Run resolves a structured preference before committing Local Memory", async () => {
  const database = new AppDatabase(":memory:");
  const skills = new SkillService(database);
  let resolverFinished = false;
  let commitRequest: ExplicitMemoryCommitRequest | undefined;
  let responseProjectionApplied = false;
  const memory: AgentLoopMemoryPlugin = {
    name: "test-memory",
    commitExplicit: async (input) => {
      assert.equal(resolverFinished, true);
      commitRequest = input;
      return { kind: "not_applicable" };
    },
    recall: async () => ({
      schema: "agentloop.memoryProjection/v1",
      id: "projection-test",
      runId: "run-test",
      target: "response",
      memoryEpoch: 1,
      memoryRevisionIds: ["revision-test"],
      retrievalReasons: ["preference:interaction.address"],
      contentHash: "hash-test",
      createdAt: 1,
      expiresAt: 2,
      guidance: { preferredAddress: "俊爷" },
      promptMarkdown: "称呼偏好：俊爷",
    }),
    enqueueSettlement: async () => ({ kind: "enqueued", settlementJobId: "settlement-test", enqueuedAt: 1 }),
  };
  const input = "你以后回复我都称呼我为俊爷";
  try {
    const runs = new RunService({
      database,
      skills,
      memory,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        assert.ok(request.runId.startsWith("conversation-turn:"));
        resolverFinished = true;
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "intent", name: "resolve_conversation_turn", arguments: {
            mode: "reply", relation: "new_goal", inputMode: "none", effectiveGoal: input,
            taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: false,
              deliverables: [{ targetId: "answer", purpose: input, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
            evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [],
            memoryIntents: [{ schema: "agentloop.memoryIntentCandidate/v1", kind: "preference", subtype: "interaction.address", canonicalKey: "interaction.address",
              value: { preferredAddress: "俊爷" }, persistenceIntent: "explicit", sensitivity: "normal", applicationTargets: ["response", "human_loop"], confidence: 0.99 }],
          } }],
        };
      } }),
      plannerFactory: () => ({ plan: async (task) => {
        responseProjectionApplied = task.memoryProjection?.target === "response"
          && task.memoryProjection.promptMarkdown.includes("俊爷");
        throw new Error("planner-boundary-observed");
      } }),
    });
    await assert.rejects(runs.executeConversation("owner", input), /Run failed/);
    assert.equal(commitRequest?.memoryIntents?.[0]?.value.preferredAddress, "俊爷");
    assert.equal(responseProjectionApplied, true);
  } finally {
    await database.close();
  }
});

test("response assessment receives confirmed local Memory facts used by the reply", async () => {
  const database = new AppDatabase(":memory:");
  const input = "我的邮箱是什么";
  let assessed = false;
  const memory: AgentLoopMemoryPlugin = {
    name: "test-memory",
    commitExplicit: async () => ({ kind: "not_applicable" }),
    recall: async () => ({
      schema: "agentloop.memoryProjection/v1",
      id: "email-projection",
      runId: "run-test",
      target: "response",
      memoryEpoch: 1,
      memoryRevisionIds: ["email-revision"],
      retrievalReasons: ["fact:contact.email"],
      contentHash: "email-hash",
      createdAt: 1,
      expiresAt: 2,
      guidance: {},
      facts: [{
        memoryRevisionId: "email-revision",
        subtype: "contact.email",
        value: { email: "12875549@qq.com" },
        stale: false,
      }],
      promptMarkdown: "已确认事实（contact.email）：{\"email\":\"12875549@qq.com\"}",
    }),
    enqueueSettlement: async () => ({ kind: "enqueued", settlementJobId: "settlement-test", enqueuedAt: 1 }),
  };
  try {
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      memory,
      modelFactory: () => ({
        limits: TEST_MODEL_LIMITS,
        complete: async (request) => {
          if (request.phase === "planning") {
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{
                id: "intent",
                name: "resolve_conversation_turn",
                arguments: {
                  mode: "reply", relation: "new_goal", inputMode: "none", effectiveGoal: input,
                  taskIntent: {
                    schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: false,
                    deliverables: [{ targetId: "email", purpose: input, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }],
                  },
                  evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] }, userConstraints: [], memoryIntents: [],
                },
              }],
            };
          }
          if (request.phase === "assessment") {
            assessed = true;
            assert.match(request.runtimeContext?.content ?? "", /confirmedResponseMemory/);
            assert.match(request.runtimeContext?.content ?? "", /12875549@qq\.com/);
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{
                id: "assessment",
                name: "submit_assessment",
                arguments: {
                  criteria: [
                    { criterionId: "answered", satisfied: true, rationale: "The reply is non-empty.", evidenceRefs: ["candidateOutput"], contractCheck: { status: "valid", rationale: "The user asked for an answer." } },
                    { criterionId: "delivery_target:email", satisfied: true, rationale: "The reply matches the confirmed contact.email fact.", evidenceRefs: ["email-revision"], contractCheck: { status: "valid", rationale: "The target matches the user request." } },
                  ],
                  skills: [], feedback: "", failedBoundary: null,
                },
              }],
            };
          }
          return { content: "你的邮箱是 12875549@qq.com。", finishReason: "stop", toolCalls: [] };
        },
      }),
    });
    const run = await runs.executeConversation(testOwner().user.id, input);
    assert.equal(run.status, "completed");
    assert.equal(run.output, "你的邮箱是 12875549@qq.com。");
    assert.equal(assessed, true);
  } finally {
    await database.close();
  }
});

test("Memory settlement uses the committed Runtime result reference", () => {
  assert.equal(memorySettlementCommitRef("run-1", {
    status: "completed",
    reasonCode: "plan_assessed_and_completed",
    committedAt: 100,
    result: {
      schema: "agentloop.runtimeResult/v1",
      ref: { schema: "agentloop.resultRef/v1", resultId: "rr_00000000-0000-4000-8000-000000000001" },
      kind: "run",
      producer: { runId: "run-1", planId: "plan-1" },
      inputs: [],
      publication: { status: "published" },
      payload: { content: "ok", contentFormat: "text", characters: 2, bytes: 2, sha256: "hash" },
      createdAt: 100,
    },
  }), "rr_00000000-0000-4000-8000-000000000001");
  assert.equal(memorySettlementCommitRef("run-2", {
    status: "failed",
    reasonCode: "MODEL_ERROR",
    committedAt: 200,
  }), "run-2:200");
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

test("planning Memory suggestions are applied before Skill selection but only for eligible catalog Skills", () => {
  const currentSkill = {
    id: "discovered:current-analysis",
    name: "current-analysis",
    description: "Analyze sales data and summarize the current business result.",
    agentLoop: {
      roles: ["primary_builder"], artifactKinds: ["none"], sourceKinds: [], qaKinds: [],
      semanticTags: ["sales-analysis"],
    },
  } as PrivateSkill;
  const historicalSkill = {
    id: "discovered:historical-analysis",
    name: "historical-analysis",
    description: "Analyze business data and summarize reusable historical patterns.",
    agentLoop: {
      roles: ["primary_builder"], artifactKinds: ["none"], sourceKinds: [], qaKinds: [],
      semanticTags: ["business-analysis"],
    },
  } as PrivateSkill;
  const understanding = understandTask({ objective: "分析销售数据并输出结论", evidenceDemand: "none" });
  const projection = {
    schema: "agentloop.memoryProjection/v1",
    target: "planner",
    planningPriors: [{
      schema: "agentloop.planningPrior/v1",
      source: "experience_procedure",
      applicability: "同类销售数据分析任务",
      strategy: "优先复用历史分析 Skill",
      suggestedSteps: [],
      skillSuggestions: [historicalSkill.id],
      evidenceExpectations: [],
      warnings: [],
      confidence: 0.9,
      sourceRefs: ["memory-revision-1"],
    }],
  } as unknown as PlanningMemoryProjection;

  const withoutMemory = selectPlanningSkillRoles([currentSkill, historicalSkill], understanding, []);
  const withMemory = selectPlanningSkillRoles([currentSkill, historicalSkill], understanding, [], [], projection);

  assert.equal(withoutMemory[0]?.skill.id, currentSkill.id);
  assert.equal(withMemory[0]?.skill.id, historicalSkill.id);
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
