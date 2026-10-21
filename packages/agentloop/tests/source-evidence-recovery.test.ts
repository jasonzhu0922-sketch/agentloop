import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/storage/database.ts";
import { RunService, repairLeafForFailedBoundary } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { removeSkillPackage } from "../src/skills/skill-package.ts";
import { singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import { approvingTestAssessor } from "./runtime-test-helpers.ts";
import { CanonicalRunStateRepository } from "../src/runtime/canonical-run-state-repository.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const scenario of [
  {
    name: "role lookup",
    goal: "示例公司的董事长、总裁分别是谁？请核验现任状态。",
    source: "# 原始人员记录\n登记：张甲，董事长；李乙，董事兼总经理。\n公司现任领导页面（2026-10-08）：张甲，董事长；赵丙，总裁。",
    answer: "截至2026-10-08，公司现任董事长是张甲，总裁是赵丙，来源为公司现任领导页面。登记总经理李乙是另一个职位。",
  },
  {
    name: "inventory comparison",
    goal: "比较甲仓和乙仓库存的差值，注明单位和统计日期。",
    source: "| 仓库 | 库存 | 单位 | 日期 |\n| 甲仓 | 80 | 箱 | 2026-10-08 |\n| 乙仓 | 60 | 箱 | 2026-10-08 |",
    answer: "甲仓比乙仓多20箱（80−60），统计日期为2026-10-08，来源为库存API快照。",
  },
]) {
for (const transport of ["api", "local_script"] as const) {
test(`${transport} ${scenario.name} delivers the user goal after exact Result consumption and assessment`, async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "goal-source-transport-"));
  const database = new AppDatabase(":memory:");
  let reads = 0;
  let turns = 0;
  let assessments = 0;
  let synthesisContext = "";
  let sourceContext = "";
  let sourceResultId = "";
  let consumedSource = "";
  const assessedOutputs: string[] = [];
  const answer = scenario.answer;
  const sourcePayload = { deliveryCandidate: { output: scenario.source },
    assessmentProjection: { sourceDate: "2026-10-08", scope: "source records" },
    evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1", sourceType: "api", receiptId: "records-snapshot",
      facts: [{ kind: "source_summary", textPreview: "Source records" }],
      evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] } } };
  const sourceToolName = transport === "api" ? "lookup_records" : "computer_run_command";
  try {
    const skillDirectory = join(workspaceRoot, "skills");
    if (transport === "local_script") {
      const packageRoot = join(skillDirectory, "records-source");
      await mkdir(join(packageRoot, "scripts"), { recursive: true });
      await writeFile(join(packageRoot, "SKILL.md"), ["---", "name: records-source", "description: Read source records", "agentloop:",
        "  roles:", "    - source_provider", "  artifactKinds:", "    - none", "  sourceKinds:", "    - api",
        "  executionProfiles:", "    - local_script", "  producesEvidenceKinds:", "    - source_summary", "---",
        "Run the query action, consume the Result, then answer the original user goal."].join("\n"));
      await writeFile(join(packageRoot, "scripts/query.mjs"), `process.stdout.write(${JSON.stringify(JSON.stringify(sourcePayload))});`);
      await writeFile(join(packageRoot, "agentloop.executors.json"), JSON.stringify({ schema: "agentloop.skillExecutors/v1",
        executors: [{ id: "records-query", description: "Read source records", command: "fixture-node", script: "scripts/query.mjs",
          actions: [{ id: "query", description: "Read source records", inputs: [], args: ["query"], result: "Source records",
            producesEvidenceKinds: ["source_summary"] }] }] }));
    }
    const skills = new SkillService(database, transport === "local_script"
      ? { skillDirectory, packageStoreRoot: join(workspaceRoot, "packages") } : {});
    await skills.refreshSkillDirectory();
    const sourceSkill = (await skills.resolveForConversation("owner"))[0];
    const base = singleStepTestPlanner();
    const runs = new RunService({
      database, skills, workspaceRoot,
      computerExecutableAliases: { "fixture-node": process.execPath },
      plannerFactory: () => ({ plan: async (task) => {
        const proposal = await base.plan(task);
        return { ...proposal,
          selectedSkillIds: sourceSkill ? [sourceSkill.id] : [],
          selectedSkillRoles: sourceSkill ? [{ skillId: sourceSkill.id, role: "source_provider" as const, reason: "Read source records" }] : [],
          steps: proposal.steps.map((step) => ({ ...step,
          skillIds: sourceSkill ? [sourceSkill.id] : [],
          requiredCapabilities: [sourceSkill ? `skill_source_provider.api.${sourceSkill.id}` : "records.lookup", "conversation_delivery"],
          ...(sourceSkill ? {} : { sourceConstraint: { requiredToolSourceIds: ["records-api"] } }),
          evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" as const },
          successCriteria: [{ id: "direct-answer", description: `Directly fulfill the user goal: ${scenario.goal}`, source: "task" as const }],
        })) };
      } }),
      tools: [{ name: "lookup_records", description: "Read source records", inputSchema: { type: "object" },
        source: { id: "records-api", transport: "api", capabilities: [{ id: "records.lookup", category: "source_acquisition",
          producesEvidenceKinds: ["source_summary"], sourceKinds: ["api"] }] },
        executionMode: "parallel", replaySafe: true, parse: (value) => value, execute: async () => {
          reads += 1;
          return sourcePayload;
        } }],
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        turns += 1;
        assert.doesNotMatch(request.systemPrompt, /"research"\s*:|"maxSearches"/,
          "an admitted API/local-script source must not inherit web policy from evidence demand");
        assert.doesNotMatch(request.runtimeContext?.content ?? "", /"researchPolicy"\s*:|"maxSearches"/);
        if (turns === 1 && sourceSkill) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "load-source", name: "load_skill", arguments: { name: sourceSkill.name } }] };
        if (turns === (sourceSkill ? 2 : 1)) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "records", name: sourceToolName,
          arguments: transport === "api" ? {} : { command: "fixture-node", args: ["scripts/query.mjs", "query"], cwd: "@skills/records-source" } }] };
        synthesisContext = request.runtimeContext?.content ?? "";
        sourceContext = JSON.stringify(request.messages);
        const read = request.messages.find((message) => message.role === "tool" && message.name === "read_result");
        if (read === undefined) {
          const source = request.messages.find((message) => message.role === "tool" && message.name === sourceToolName);
          sourceResultId = source?.content.match(/rr_[a-f0-9-]+/)?.[0] ?? "";
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "consume-source", name: "read_result",
            arguments: { resultId: sourceResultId } }] };
        }
        consumedSource = read.content;
        return { content: answer, finishReason: "stop", toolCalls: [] };
      } }),
      assessorFactory: () => ({ assess: async (input) => {
        assessments += 1;
        assessedOutputs.push(input.evidence.candidateOutput);
        return approvingTestAssessor().assess(input);
      } }),
    });
    const run = await runs.execute("owner", scenario.goal);
    assert.equal(run.status, "completed");
    assert.equal(run.output, answer);
    assert.equal(reads, transport === "api" ? 1 : 0);
    assert.equal(turns, sourceSkill ? 4 : 3);
    assert.equal(assessments, 1);
    assert.deepEqual(assessedOutputs, [answer], "raw source rendering must not replace the answer");
    assert.match(synthesisContext, /runtime_structured_observation_synthesis/);
    assert.ok(sourceContext.includes(scenario.goal));
    assert.ok(consumedSource.includes(scenario.source.split("\n").at(-1)!));
    assert.equal(JSON.parse(consumedSource).sourceResultRef.resultId, sourceResultId);
    const events = await runs.events("owner", run.id);
    assert.equal(events.filter((event) => event.type === "tool.completed" && event.data.toolName === sourceToolName).length, 1);
    assert.equal(events.some((event) => event.type === "candidate.structured_tool_detected"), false);
    assert.equal(events.some((event) => event.type === "artifact.acceptance.requested"), false);
    const committed = events.find((event) => event.type === "terminal.delivery_committed");
    assert.equal(committed?.data.output, answer);
  } finally {
    database.close();
    await removeSkillPackage(join(workspaceRoot, "packages"));
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
}
}

test("partial source observations keep complementary acquisition available until the user facts are answered", async () => {
  const database = new AppDatabase(":memory:");
  const goal = "示例公司的董事长和总裁分别是谁？";
  const answer = "根据公司现任领导页面，董事长是周丁，总裁是赵丙。";
  let turns = 0;
  const base = singleStepTestPlanner();
  try {
    const runs = new RunService({ database, skills: new SkillService(database),
      plannerFactory: () => ({ plan: async (task) => {
        const proposal = await base.plan(task);
        return { ...proposal, steps: proposal.steps.map((step) => ({ ...step,
          requiredCapabilities: ["web_research", "conversation_delivery"],
          evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" as const },
        })) };
      } }),
      tools: [{ name: "webfetch", description: "Read registry or current leadership source", inputSchema: { type: "object" },
        executionMode: "parallel", replaySafe: true, parse: (value: unknown) => value as { url: string }, execute: async (_context, input) => ({
          schema: "agentloop.webFetch/v1", content: input.url === "registry" ? "登记：张甲，董事长；李乙，总经理。没有总裁字段。" : answer,
          ...(input.url === "registry" ? { deliveryCandidate: { output: "| 张甲 | 董事长 |\n| 李乙 | 总经理 |" } } : {}),
          evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1", evidenceKinds: { satisfied: ["source_summary"], caveated: [], failed: [] } },
        }) }],
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        turns += 1;
        if (turns <= 2) {
          assert.ok(request.tools.some((tool) => tool.name === "webfetch"), "a receipt from one source must not fence off complementary acquisition");
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `source-${turns}`, name: "webfetch",
            arguments: { url: turns === 1 ? "registry" : "official" } }] };
        }
        return { content: answer, finishReason: "stop", toolCalls: [] };
      } }), assessorFactory: () => approvingTestAssessor(),
    });
    const run = await runs.execute("owner", goal);
    assert.equal(run.status, "completed");
    assert.equal(run.output, answer);
    assert.equal(turns, 3);
    const events = await runs.events("owner", run.id);
    assert.equal(events.filter((event) => event.type === "tool.completed" && event.data.toolName === "webfetch").length, 2);
    assert.equal(events.some((event) => event.type === "candidate.structured_tool_detected"), false);
    assert.equal(events.some((event) => event.type === "loop.convergence_requested"), false);
  } finally { database.close(); }
});

test("source receipts and non-empty fabricated claims cannot bypass semantic assessment or restart repair indefinitely", async () => {
  const database = new AppDatabase(":memory:");
  let assessments = 0;
  let fetches = 0;
  let recoveryCalls = 0;
  try {
    const base = singleStepTestPlanner();
    const runs = new RunService({
      database, skills: new SkillService(database),
      plannerFactory: () => ({ plan: async (task) => {
        const proposal = await base.plan(task);
        return { ...proposal, steps: proposal.steps.map((step) => ({ ...step,
          requiredCapabilities: ["web_research", "conversation_delivery"],
          evidenceContract: { requiredKinds: ["source_summary", "source_urls"], caveatPolicy: "none" as const },
          successCriteria: [{ id: "verified-answer", description: "Answer using the current readable source facts.", source: "task" as const }],
        })) };
      } }),
      recoveryPlannerFactory: () => ({ decide: async (input) => {
        recoveryCalls += 1;
        assert.ok(input.canonicalGap);
        assert.equal(input.action.metadata.localRepairExhausted, true);
        assert.ok(input.availableCapabilities?.some((capability) => capability.id === "web_research"));
        return { actionId: input.action.id, expectedActionRevision: input.action.revision, decision: "fail" as const,
          rationale: "The only available source has no requested name; stop without inventing facts.", evidenceRefs: ["fetch-source"] };
      } }),
      tools: [{ name: "webfetch", description: "Read a source", inputSchema: { type: "object" }, executionMode: "parallel", replaySafe: true,
        parse: (value) => value, execute: async () => {
          fetches += 1;
          return { schema: "agentloop.webFetch/v1", content: "公告仅说明会议召开，没有披露负责人姓名。", truncated: false,
            decoding: { encoding: "utf-8", source: "default", lossy: false, replacementCharacters: 0 },
            evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1", sourceType: "web_page", sourceRefs: [{ url: "https://example.test/announcement" }],
              facts: [], caveats: [], evidenceKinds: { satisfied: ["source_summary", "source_urls"], caveated: [], failed: [] } } };
        } }],
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        if (request.phase === "assessment") {
          assessments += 1;
          const context = request.runtimeContext?.content ?? "";
          assert.match(context, /factualSupport/);
          assert.match(context, /没有披露负责人姓名/);
          assert.match(context, /sourceContent/);
          const match = context.match(/<assessment_context source="server">\n([^\n]+)\n/);
          assert.ok(match);
          const view = JSON.parse(match[1]);
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `assessment-${assessments}`, name: "submit_assessment", arguments: {
            criteria: view.step.successCriteria.map((criterion: { id: string }) => ({ criterionId: criterion.id, satisfied: false,
              rationale: "The readable source does not name the requested person.", evidenceRefs: ["fetch-source"],
              contractCheck: { status: "valid", rationale: "The user requested the person's name." } })),
            skills: [], feedback: "负责人姓名缺少原文支持。",
            failedBoundary: { stepId: view.step.id, missingEvidenceKinds: ["source_summary"], violatedSkillRequirements: [],
              reusableEvidenceRefs: ["fetch-source"], suggestedRepairShape: "repair_leaf" },
          } }] };
        }
        if ((request.runtimeContext?.content ?? "").includes("<runtime_failure_report>")) {
          return { content: "已取得公告，但未核实负责人姓名，不能作出确定回答。", finishReason: "stop", toolCalls: [] };
        }
        if (!request.messages.some((message) => message.role === "tool")) {
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "fetch-source", name: "webfetch", arguments: { url: "https://example.test/announcement" } }] };
        }
        return { content: "负责人是未经来源支持的人名。", finishReason: "stop", toolCalls: [] };
      } }),
    });
    const run = await runs.execute("owner", "查询公告中的负责人姓名");
    assert.equal(run.status, "failed");
    assert.ok(assessments >= 1);
    assert.equal(fetches, 1);
    assert.equal(recoveryCalls, 1);
    const events = await runs.events("owner", run.id);
    assert.equal(events.some((event) => event.type === "recovery.repair_leaf_created" || event.type === "terminal.delivery_committed"), false);
    const outcome = await database.prepare("SELECT status, delivery_receipt_json FROM run_outcomes WHERE run_id = ?").get(run.id) as Record<string, unknown>;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.delivery_receipt_json, null);
    assert.doesNotMatch(run.output ?? "", /负责人是未经来源支持的人名/);
  } finally { database.close(); }
});

for (const approveRepair of [true, false]) {
  test(`unverified source-boundary prose enters canonical recovery instead of Result publication (repair=${approveRepair})`, async () => {
    const database = new AppDatabase(":memory:");
    let fetches = 0;
    let assessments = 0;
    let recoveryCalls = 0;
    const rejectedOutput = "目前无法核实董事长和总裁姓名，原文无法取得，来源访问受限。";
    const answer = "周丁、赵丙";
    try {
      const base = singleStepTestPlanner();
      const runs = new RunService({
        database, skills: new SkillService(database),
        plannerFactory: () => ({ plan: async (task) => {
          const proposal = await base.plan(task);
          return { ...proposal, steps: proposal.steps.map((step) => ({ ...step,
            requiredCapabilities: ["web_research", "conversation_delivery"],
            evidenceContract: { requiredKinds: ["source_summary", "source_urls"], caveatPolicy: "mark_unverified_facts" as const },
            successCriteria: [{ id: "names", description: "Deliver both requested names from readable evidence.", source: "task" as const }],
          })) };
        } }),
        recoveryPlannerFactory: () => ({ decide: async (input) => {
          recoveryCalls += 1;
          assert.ok(input.canonicalGap);
          assert.ok(input.canonicalGap.unmetCriteria?.length);
          assert.ok(input.canonicalGap.evidenceRefs.length);
          assert.equal(input.canonicalGap.status, "open");
          if (!approveRepair) return { actionId: input.action.id, expectedActionRevision: input.action.revision,
            decision: "fail" as const, rationale: "No readable source confirms the requested facts.", evidenceRefs: ["lookup-1"] };
          const repair = repairLeafForFailedBoundary(input.plan!.steps.find((step) => step.id === input.failedBoundary!.stepId)!, input.failedBoundary!, input.plan!.version);
          return { actionId: input.action.id, expectedActionRevision: input.action.revision, decision: "revise_plan" as const,
            rationale: "Read an alternative source and close the same fact gap.", evidenceRefs: ["lookup-1"],
            planRevision: { schema: "agentloop.outcomePlan/v2" as const, shape: "recovery_patch" as const,
              goal: input.plan!.goal, selectedSkillIds: [], steps: [repair] } };
        } }),
        planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "", evidenceRefs: [] }) }),
        tools: [{ name: "webfetch", description: "Read source text", inputSchema: { type: "object" }, executionMode: "parallel", replaySafe: true,
          parse: (value) => value, execute: async () => {
            fetches += 1;
            if (fetches === 2) throw new Error("HTTP 403: source unavailable");
            return { schema: "agentloop.webFetch/v1", content: fetches === 1 ? "只有公司介绍，没有负责人姓名。" : "现任董事长周丁，总裁赵丙。",
              evidenceReceipt: { schema: "agentloop.toolEvidenceReceipt/v1", sourceType: "web_page", sourceRefs: [{ url: `https://example.test/leadership/${fetches}` }],
                evidenceKinds: { satisfied: ["source_summary", "source_urls"], caveated: [], failed: [] } } };
          } }],
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
          if ((request.runtimeContext?.content ?? "").includes("<runtime_failure_report>")) {
            return { content: "来源访问受限，尚未核实姓名。", finishReason: "stop", toolCalls: [] };
          }
          const repair = request.messages.some((message) => message.role === "user" && message.content.includes("Continue the same unresolved canonical GoalGap"));
          if ((repair && fetches < 3) || fetches === 0 || (fetches === 1 && assessments === 1)) {
            return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `lookup-${fetches + 1}`, name: "webfetch", arguments: { url: `https://example.test/leadership/${fetches + 1}` } }] };
          }
          return { content: repair ? answer : rejectedOutput, finishReason: "stop", toolCalls: [] };
        } }),
        assessorFactory: () => ({ assess: async (input) => {
          assessments += 1;
          const approved = await approvingTestAssessor().assess(input);
          if (input.step.role === "repair" && fetches === 3) return approved;
          return { ...approved, approved: false,
            criteria: approved.criteria.map((criterion) => ({ ...criterion, satisfied: false, blocking: true, status: "unverified" as const,
              rationale: "No names were delivered. The full text remains unverified and the source is unavailable." })),
            feedback: "No names were delivered; full text remains unverified. Read an alternative source.",
            failedBoundary: { stepId: input.step.id, missingEvidenceKinds: ["source_summary", "source_urls"], violatedSkillRequirements: [],
              reusableEvidenceRefs: ["lookup-1"], suggestedRepairShape: "repair_leaf" as const } };
        } }),
      });
      const run = await runs.execute("owner", "示例公司的董事长是谁，总裁是谁？只回答名字。");
      const events = await runs.events("owner", run.id);
      assert.equal(run.status, approveRepair ? "completed" : "failed", JSON.stringify(events.filter((event) => /failed|recovery/.test(event.type))));
      assert.equal(recoveryCalls, 1);
      assert.equal(fetches, approveRepair ? 3 : 2);
      assert.ok(assessments >= 2);
      assert.equal(events.some((event) => event.type === "candidate.evidence_boundary_accepted" || event.type === "candidate.validation_deferred"), false);
      assert.ok(events.some((event) => event.type === "run.repairing"));
      assert.equal(events.some((event) => event.type === "run.failed" && event.data.code === "CONFLICT"), false);
      assert.equal(events.some((event) => event.type === "terminal.delivery_committed"), approveRepair);
      assert.equal(events.some((event) => event.type === "plan.step.completed" && event.data.output === rejectedOutput), false);
      const state = await new CanonicalRunStateRepository(database).get(run.id);
      const gaps = state.gaps.filter((gap) => gap.targetId === undefined);
      assert.equal(gaps.length, 1);
      assert.equal(gaps[0]?.status, approveRepair ? "resolved" : "open");
      const outcome = await database.prepare("SELECT status, delivery_receipt_json FROM run_outcomes WHERE run_id = ?").get(run.id) as Record<string, unknown>;
      assert.equal(outcome.status, approveRepair ? "completed" : "failed");
      if (approveRepair) assert.equal(run.output, answer);
      else assert.equal(outcome.delivery_receipt_json, null);
    } finally { database.close(); }
  });
}

for (const approveRepair of [true, false]) {
  test(`automatic repair reuses committed Results and keeps one bounded GoalGap (approve=${approveRepair})`, async () => {
    const database = new AppDatabase(":memory:");
    let reads = 0;
    let repairTurns = 0;
    let sourceResultId: string | undefined;
    try {
      const runs = new RunService({
        database, skills: new SkillService(database), plannerFactory: singleStepTestPlanner,
        recoveryPlannerFactory: () => ({ decide: async (input) => {
          assert.ok(input.canonicalGap);
          assert.equal(input.action.metadata.localRepairExhausted, true);
          const target = input.plan!.steps.find((step) => step.id === input.failedBoundary!.stepId)!;
          const repair = repairLeafForFailedBoundary(target, input.failedBoundary!, input.plan!.version);
          return { actionId: input.action.id, expectedActionRevision: input.action.revision, decision: "revise_plan" as const,
            rationale: "Reconcile the result against already committed evidence.", evidenceRefs: ["read-1"],
            planRevision: { schema: "agentloop.outcomePlan/v2" as const, shape: "recovery_patch" as const, goal: input.plan!.goal, selectedSkillIds: input.plan!.selectedSkillIds,
              steps: [repair] } };
        } }),
        tools: [{ name: "read_probe", description: "Read immutable evidence", inputSchema: { type: "object" }, executionMode: "parallel", replaySafe: true,
          parse: (value) => value, execute: async () => { reads += 1; return { observedValue: "SOURCE_VALUE" }; } }],
        planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "", evidenceRefs: [] }) }),
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
          const repair = request.messages.some((message) => message.role === "user" && message.content.includes("Continue the same unresolved canonical GoalGap"));
          if (repair) {
            repairTurns += 1;
            const result = request.messages.find((message) => message.role === "tool" && message.name === "read_probe");
            assert.ok(result);
            const value = JSON.parse(result.content);
            assert.equal(value.observedValue, "SOURCE_VALUE");
            assert.equal(value.resultRef.resultId, sourceResultId);
            assert.doesNotMatch(JSON.stringify(request.messages), /REJECTED_DRAFT/);
            assert.doesNotMatch(request.runtimeContext?.content ?? "", /REJECTED_DRAFT/);
            assert.match(request.runtimeContext?.content ?? "", /unverified_draft/);
            return { content: "Repair using SOURCE_VALUE", finishReason: "stop", toolCalls: [] };
          }
          const result = request.messages.find((message) => message.role === "tool" && message.name === "read_probe");
          if (result) sourceResultId = JSON.parse(result.content).resultRef.resultId;
          if (reads > 0) return { content: "REJECTED_DRAFT", finishReason: "stop", toolCalls: [] };
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "read-1", name: "read_probe", arguments: {} }] };
        } }),
        assessorFactory: () => ({ assess: async (input) => {
          const approved = await approvingTestAssessor().assess(input);
          if (input.step.role === "repair" && approveRepair) return approved;
          return { ...approved, approved: false,
            criteria: approved.criteria.map((criterion) => ({ ...criterion, satisfied: false })),
            feedback: "Repair the acceptance boundary using the existing evidence.",
            failedBoundary: { stepId: input.step.id, missingEvidenceKinds: ["artifact_acceptance"], violatedSkillRequirements: [],
              reusableEvidenceRefs: ["read-1"], suggestedRepairShape: "repair_leaf" as const } };
        } }),
      });
      const run = await runs.execute("owner", "Produce a recoverable result");
      assert.equal(run.status, approveRepair ? "completed" : "failed", JSON.stringify((await runs.events("owner", run.id)).filter((event) => /failed|recovery/.test(event.type))));
      assert.equal(reads, 1);
      assert.ok(repairTurns > 0, JSON.stringify((await runs.events("owner", run.id)).filter((event) => /failed|recovery/.test(event.type))));
      const state = await new CanonicalRunStateRepository(database).get(run.id);
      const gaps = state.gaps.filter((gap) => gap.targetId === undefined);
      assert.equal(gaps.length, 1);
      assert.equal(gaps[0]?.status, approveRepair ? "resolved" : "open");
      assert.equal(gaps[0]?.repairStepIds?.length, approveRepair ? 2 : 3);
      const events = await runs.events("owner", run.id);
      assert.equal(events.filter((event) => event.type === "recovery.repair_leaf_created").length, approveRepair ? 1 : 2);
      assert.equal(events.some((event) => event.type === "terminal.delivery_committed"), approveRepair);
    } finally { database.close(); }
  });
}

test("restored retrieval evidence consumes the same search and fetch budgets", async () => {
  let executions = 0;
  let turns = 0;
  const grant = createCapabilityGrant({ runId: "restored-budget", actorUserId: "owner", depth: 0,
    allowedToolNames: ["websearch", "webfetch"], allowedSkillIds: [] });
  const result = await runAgentLoop({
    runId: grant.runId, grant, input: "Continue from existing evidence", systemPrompt: "Use existing sources", maxSteps: 3,
    initialToolEvidence: [
      { toolCallId: "prior-search", toolName: "websearch", result: '{"results":[{"url":"https://example.test"}]}', isError: false },
      { toolCallId: "prior-fetch", toolName: "webfetch", result: '{"content":"source already read"}', isError: false },
    ],
    toolCallLimits: { websearch: 1, webfetch: 1 },
    tools: new ToolRegistry(["websearch", "webfetch"].map((name) => ({ name, description: "Retrieve", inputSchema: { type: "object" },
      executionMode: "parallel" as const, replaySafe: true, parse: (value: unknown) => value,
      execute: async () => { executions += 1; return "must not execute"; } }))),
    model: { limits: TEST_MODEL_LIMITS, complete: async () => {
      turns += 1;
      return turns === 1
        ? { content: "", finishReason: "tool_calls", toolCalls: ["websearch", "webfetch"].map((name) => ({ id: `repeat-${name}`, name, arguments: {} })) }
        : { content: "Existing sources reused, missing facts remain unverified.", finishReason: "stop", toolCalls: [] };
    } },
    evaluateCandidate: async () => ({ approved: true, feedback: "" }),
  });
  assert.equal(executions, 0);
  assert.match(result.output, /Existing sources reused/);
});
