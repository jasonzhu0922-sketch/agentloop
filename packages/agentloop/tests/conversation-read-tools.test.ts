import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunService, repairLeafForFailedBoundary } from "../src/runtime/run-service.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { toolNamesForConversationMode } from "../src/runtime/conversation-tool-policy.ts";
import { ToolRegistry, type RuntimeTool } from "../src/tools/tool-registry.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { removeSkillPackage } from "../src/skills/skill-package.ts";
import { approvingTestAssessor, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";
import type { ModelResponse } from "../src/runtime/contracts.ts";
import { connectorOperationTools } from "../../connector-sdk/src/agentloop-adapter.ts";
import { create126MailConnector } from "../../connector-126-mail/src/index.ts";
import { queryScope, timeCoverage } from "../../connector-126-mail/src/mail-query.ts";

function resolve(goal: string, extra: Record<string, unknown> = {}): ModelResponse {
  return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "resolve", name: "resolve_conversation_turn", arguments: {
    mode: "reply", relation: "new_goal", inputMode: "none", effectiveGoal: goal,
    evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
    userConstraints: [], memoryAction: "none", memoryIntents: [], requiredCapabilityReferences: [],
    taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "answer", requiresExecution: false,
      deliverables: [{ targetId: "answer", purpose: goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
    ...extra,
  } }] };
}
function text(content: string): ModelResponse { return { content, finishReason: "stop", toolCalls: [] }; }
function call(name: string, args: Record<string, unknown>): ModelResponse {
  return { content: "", finishReason: "tool_calls", toolCalls: [{ id: `call-${name}`, name, arguments: args }] };
}
function answerPlan(goal: string, capabilities: readonly string[]): ModelResponse {
  return call("submit_outcome_plan", { schema: "agentloop.outcomePlan/v2", goal, shape: "single_leaf", selectedSkillRoles: [],
    leaves: [{ id: "response", objective: goal, role: "deliver", dependsOn: [], requiredFacts: [], skillIds: [],
      requiredCapabilities: ["conversation_delivery", ...capabilities], targetIds: ["answer"], sourceConstraint: null,
      evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" } }],
  });
}
function tool(name: string, effect?: "read" | "write", replaySafe = true): RuntimeTool {
  return { name, description: "Host-declared operation", effect, replaySafe, executionMode: "parallel",
    inputSchema: { type: "object" }, parse: input => input, execute: async () => ({ value: "live-observation" }) };
}

for (const fixture of [
  { name: "data-analysis", evidenceStrategy: "source_grounded", goal: "截至2026年6月底，管理合并账套1001G300的年初起累计毛利率是多少？" },
  { name: "archive-query", evidenceStrategy: "lookup_lite", goal: "查询内部档案中合同的当前状态。" },
]) {
  test(`an evidence-backed reply plans and binds ${fixture.name} before loading its package`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agentloop-reply-skill-"));
    const db = new AppDatabase(":memory:");
    let planningTurns = 0, executionTurns = 0;
    try {
      const packageRoot = join(root, "skills", fixture.name);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "SKILL.md"), ["---", `name: ${fixture.name}`,
        "description: 查询内部业务数据与档案，读取账套指标和合同状态。", "agentloop:",
        "  roles:", "    - source_provider", "  artifactKinds:", "    - none",
        "  sourceKinds:", "    - database", "  producesEvidenceKinds:", "    - source_summary", "---",
        "Read observation.txt in this Skill package and answer from that recorded observation."].join("\n"));
      await writeFile(join(packageRoot, "observation.txt"), "Recorded source observation: fixture-value");
      const skills = new SkillService(db, { skillDirectory: join(root, "skills"), packageStoreRoot: join(root, "packages") });
      await skills.refreshSkillDirectory();
      const skill = (await skills.resolveForConversation("owner"))[0]!;
      await mkdir(join(root, "workspace"));
      const service = new RunService({ database: db, skills, workspaceRoot: join(root, "workspace"),
        assessorFactory: () => approvingTestAssessor(),
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
          if (request.runId.startsWith("conversation-turn:")) return resolve(fixture.goal, {
            evidenceStrategy: fixture.evidenceStrategy,
            taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "lookup", requiresExecution: false,
              deliverables: [{ targetId: "answer", purpose: fixture.goal, expectedArtifactCount: 1, action: "none", kind: "none", surface: "conversation" }] },
          });
          if (request.phase === "planning") {
            planningTurns++;
            assert.ok(request.runtimeContext!.content.includes(skill.id));
            return call("submit_outcome_plan", { schema: "agentloop.outcomePlan/v2", goal: fixture.goal, shape: "single_leaf",
              selectedSkillRoles: [{ skillId: skill.id, role: "source_provider", reason: "Acquire the requested private fact." }],
              leaves: [{ id: "answer", objective: fixture.goal, role: "deliver", dependsOn: [], requiredFacts: [],
                skillIds: [skill.id], requiredCapabilities: ["conversation_delivery", `skill_source_provider.database.${skill.id}`],
                targetIds: ["answer"], sourceConstraint: null,
                evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" } }],
            });
          }
          assert.ok(request.tools.some(item => item.name === "load_skill"), "the admitted Skill must be callable");
          executionTurns++;
          if (executionTurns === 1) return call("load_skill", { name: skill.name });
          if (executionTurns === 2) return call("computer_read_file", { path: `@skills/${skill.name}/observation.txt` });
          assert.match(JSON.stringify(request.messages), /fixture-value/);
          return text("The recorded observation is fixture-value.");
        } }),
      });
      const run = await service.executeConversation("owner", fixture.goal).catch(async error => {
        const failures = await db.prepare("SELECT payload_json FROM run_events WHERE type = 'run.failed'").all();
        assert.fail(`${error}: ${JSON.stringify(failures)}`);
      });
      const events = await service.events("owner", run.id);
      assert.equal(run.status, "completed", JSON.stringify(events.filter(event => /failed|rejected/.test(event.type))));
      assert.equal(planningTurns, 1);
      assert.equal(executionTurns, 3);
      assert.equal(events.find(event => event.type === "conversation.turn.resolved")!.data.mode, "reply");
      const { plan } = await service.plan("owner", run.id);
      assert.deepEqual(plan.selectedSkillIds, [skill.id]);
      assert.deepEqual(plan.steps[0].skillIds, [skill.id]);
      assert.ok(events.some(event => event.type === "tool.completed" && event.data.toolName === "load_skill"));
      assert.ok(events.some(event => event.type === "run.completed"));
      assert.equal(events.some(event => event.type === "tool.rejected"), false);
    } finally {
      db.close();
      await removeSkillPackage(join(root, "packages"));
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("conversation modes retain Run authority independently of effect declarations", () => {
  const tools = [tool("observe", "read", false), tool("mutate", "write"), tool("unclassified"), tool("not_authorized", "read")];
  const authorized = ["observe", "mutate", "unclassified"];
  assert.deepEqual(toolNamesForConversationMode("reply", authorized), authorized);
  assert.deepEqual(toolNamesForConversationMode("clarify", authorized), []);
  assert.deepEqual(toolNamesForConversationMode("execute", authorized), authorized);
  const grant = createCapabilityGrant({ actorUserId: "owner", runId: "run", depth: 0,
    allowedToolNames: authorized, allowedSkillIds: [] });
  const materialized = new ToolRegistry(tools).materialize(grant);
  assert.deepEqual(materialized.definitions.map(item => item.name), authorized);
  assert.throws(() => materialized.prepare({ id: "denied", name: "not_authorized", arguments: {} }), /not available/);
  assert.deepEqual(new ToolRegistry([tool("observe", "write")]).materialize(grant).definitions.map(item => item.name), ["observe"]);
});

test("reply can select a generic service reader and then a visible file without becoming execute", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-read-reply-"));
  const visible = await mkdtemp(join(tmpdir(), "agentloop-read-source-"));
  const db = new AppDatabase(":memory:");
  let reads = 0, planningTurns = 0, executionTurns = 0, assessments = 0;
  const observe = { ...tool("observe_catalog", "read", false), execute: async () => { reads++; return { status: "live-observation" }; } };
  try {
    await writeFile(join(visible, "state.txt"), "file-observation");
    const service = new RunService({ database: db, skills: new SkillService(db), workspaceRoot: root,
      tools: [observe, tool("read_mutation", "write"), tool("unclassified")],
      assessorFactory: () => ({ assess: async input => {
        assessments++;
        assert.deepEqual(input.evidence.toolCalls.map(item => item.toolName), ["observe_catalog", "visible_read_file", "read_result"]);
        assert.match(input.evidence.candidateOutput, /live-observation.*file-observation/);
        return approvingTestAssessor().assess(input);
      } }),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.runId.startsWith("conversation-turn:")) return resolve("Explain the current state", { evidenceStrategy: "lookup_lite" });
        if (request.phase === "planning") {
          planningTurns++;
          return answerPlan("Explain the current state", ["authorized_tool_use"]);
        }
        assert.equal(request.phase, "execution");
        const names = request.tools.map(item => item.name);
        assert.ok(names.includes("observe_catalog"));
        assert.ok(names.includes("visible_read_file"));
        for (const available of ["read_mutation", "unclassified", "visible_extract_tables"]) {
          assert.ok(names.includes(available), `${available} remains authorized in reply mode`);
        }
        assert.equal(names.includes("load_skill"), false, "no Skill is selected by this step");
        executionTurns++;
        if (executionTurns === 1) return call("observe_catalog", {});
        if (executionTurns === 2) return call("visible_read_file", { rootId: "visible_dir_1", path: "state.txt" });
        if (executionTurns === 3) {
          const receipt = request.messages.filter(item => item.role === "tool" && item.name === "visible_read_file").at(-1);
          const resultId = JSON.stringify(receipt).match(/rr_[0-9a-f-]{36}/)?.[0];
          assert.ok(resultId);
          return call("read_result", { resultId });
        }
        assert.match(JSON.stringify(request.messages), /live-observation/);
        assert.match(JSON.stringify(request.messages), /file-observation/);
        return text("live-observation and file-observation");
      } }),
    });
    const run = await service.executeConversation("owner", "Explain the current state", { visibleDirectories: [visible] });
    assert.equal(run.status, "completed", JSON.stringify((await service.events("owner", run.id)).slice(-8)));
    assert.equal(reads, 1); assert.equal(planningTurns, 1); assert.equal(executionTurns, 4); assert.equal(assessments, 1);
    const events = await service.events("owner", run.id);
    const resolved = events.find(event => event.type === "conversation.turn.resolved")!.data;
    assert.equal(resolved.mode, "reply"); assert.equal(resolved.evidenceDemand, "lookup_lite");
    assert.equal(events.some(event => event.type === "conversation.turn.resolution_rejected"), false);
    const { plan } = await service.plan("owner", run.id);
    assert.deepEqual(plan.selectedSkillIds, []);
    assert.equal(plan.steps.length, 1);
    assert.ok(plan.steps[0].evidence?.publishedResult?.inputs?.length);
    const row = await db.prepare("SELECT context_json FROM run_planning_recovery WHERE run_id = ?").get(run.id) as { context_json: string };
    const persisted = JSON.parse(row.context_json);
    assert.ok(persisted.allowedToolNames.includes("observe_catalog"));
    assert.equal(persisted.allowedToolNames.includes("computer_write_file"), true);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); await rm(visible, { recursive: true, force: true }); }
});

test("a reply reads a bound prior Result exactly and publishes its provenance without resolver repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-prior-result-reply-"));
  const db = new AppDatabase(":memory:");
  let turn = 0, read = false, skippedRead = false, resultId = "";
  try {
    const options = { database: db, skills: new SkillService(db), workspaceRoot: root,
      assessorFactory: () => approvingTestAssessor(),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.runId.startsWith("conversation-turn:")) {
          turn++;
          if (turn === 1) return resolve("State the stored definitions");
          const context = JSON.parse(request.runtimeContext!.content.split("\n").slice(1, -1).join("\n"));
          assert.equal(context.conversationWorkingSet.reusableResultCandidates.length > 0, true);
          if (turn === 3) {
            assert.ok(context.conversationWorkingSet.priorGoalCandidates.some((item: { priorIntent?: { mode: string; inputMode: string } }) =>
              item.priorIntent?.mode === "reply" && item.priorIntent.inputMode === "prior_result"));
            return resolve("Acknowledge the prior explanation");
          }
          return resolve("Explain group from the stored definitions", { relation: "continue_prior", inputMode: "prior_result",
            resultCandidateId: context.conversationWorkingSet.reusableResultCandidates[0].candidateId });
        }
        if (turn === 3) return text("Understood.");
        if (turn === 1) return text("Definitions: demo is demonstration data; group is consolidated group reporting.");
        const context = request.runtimeContext!.content;
        const match = context.match(/rr_[0-9a-f-]{36}/);
        assert.ok(match); resultId = match[0];
        if (!skippedRead) { skippedRead = true; return text("An unsupported answer without reading the bound input."); }
        if (!read) { read = true; return call("read_result", { resultId }); }
        assert.match(JSON.stringify(request.messages), /consolidated group reporting/);
        return text("group means consolidated group reporting in the prior definitions.");
      } }),
    } satisfies ConstructorParameters<typeof RunService>[0];
    const service = new RunService(options);
    const first = await service.executeConversation("owner", "State the stored definitions");
    const second = await service.executeConversation("owner", "Explain group from those definitions", { conversationId: first.conversationId });
    assert.equal(second.status, "completed"); assert.equal(turn, 2); assert.equal(read, true);
    const events = await service.events("owner", second.id);
    assert.equal(events.some(event => event.type === "conversation.turn.resolution_rejected"), false);
    const resolution = events.find(event => event.type === "conversation.turn.resolved")!.data;
    assert.equal(resolution.mode, "reply"); assert.equal(resolution.inputMode, "prior_result");
    assert.ok(events.some(event => event.type === "candidate.dependency_results_unread"));
    assert.equal((resolution.targetResult as { resultId: string }).resultId, resultId);
    const { plan } = await service.plan("owner", second.id);
    assert.ok(plan.steps[0].evidence?.publishedResult?.inputs.some(ref => ref.resultId === resultId));
    assert.equal(plan.steps[0].evidence?.toolCalls.filter(item => item.toolName === "read_result").length, 1);
    const restarted = new RunService(options);
    const third = await restarted.executeConversation("owner", "Understood", { conversationId: first.conversationId });
    assert.equal(third.status, "completed");
    assert.equal(turn, 3);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("reply tool calls still obey operation policies before any side effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-policy-reply-"));
  const db = new AppDatabase(":memory:");
  let writes = 0, turns = 0, policyChecks = 0;
  try {
    const service = new RunService({ database: db, skills: new SkillService(db), workspaceRoot: root,
      tools: [{ ...tool("mutate_resource", "write"), execute: async () => { writes++; return "changed"; } }],
      toolExecutionPlugins: [{ id: "resource-policy", version: "1", evaluate: ({ tool }) => {
        policyChecks++;
        return tool.name === "mutate_resource"
          ? { decision: "deny", code: "mutation_not_authorized", reason: "This resource only permits observation." }
          : { decision: "allow" };
      } }],
      assessorFactory: () => approvingTestAssessor(),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
        if (request.runId.startsWith("conversation-turn:")) return resolve("Explain the resource");
        assert.ok(request.tools.some(item => item.name === "mutate_resource"));
        if (turns++ === 0) return call("mutate_resource", {});
        return text("The operation policy denied the mutation.");
      } }),
    });
    const run = await service.executeConversation("owner", "Explain the resource");
    const events = await service.events("owner", run.id);
    assert.equal(run.status, "completed");
    assert.equal(writes, 0);
    assert.equal(policyChecks, 1);
    assert.ok(events.some(event => event.type === "tool.failed" && event.data.toolName === "mutate_resource" && event.data.isError));
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

for (const recovery of [false, true]) {
  test(`126 Mail remains callable in reply ${recovery ? "after a plan revision" : "without effect metadata"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agentloop-mail-reply-"));
    const db = new AppDatabase(":memory:");
    const connection = { id: "mail", connectorKey: "126-mail", ownerType: "user" as const,
      ownerId: "owner", scopes: [], credentialRef: "fixture", status: "active" as const };
    const credentialProvider = { get: async () => ({}) };
    const range = { receivedAtGte: "2026-11-15T16:00:00.000Z", receivedAtLt: "2026-11-16T07:31:00.000Z", timeZone: "Asia/Shanghai" };
    const message = { id: "message-1", from: "fixture@example.test", subject: "Review request",
      receivedAt: "2026-11-16T01:00:00.000Z", text: "Please review the proposal." };
    const operations: string[] = [];
    let revisions = 0;
    const turns = new Map<string, number>();
    const instance = await create126MailConnector(async () => ({
      count: async query => { operations.push("count"); return { count: 1,
        dailyCounts: [{ date: "2026-11-16", weekday: "Monday", count: 1 }], complete: true,
        scope: queryScope(query), temporalCoverage: timeCoverage(query, true), observedAt: range.receivedAtLt }; },
      search: async query => { operations.push("search"); return { messages: [message], totalMatches: 1,
        totalMatchesExact: true, returnedCount: 1, complete: true, scope: queryScope(query),
        temporalCoverage: timeCoverage(query, true), observedAt: range.receivedAtLt }; },
      read: async input => { operations.push("read"); assert.equal(input.messageId, message.id); return message; },
    })).connect({ connection, credentialProvider });
    try {
      const service = new RunService({ database: db, skills: new SkillService(db), workspaceRoot: root,
        runToolProvider: { resolve: async input => {
          assert.deepEqual(input.connectionIds, [connection.id]);
          return connectorOperationTools(instance, { ...input, connection, credentialProvider })
            .map(({ effect: _effect, ...tool }) => tool); // Other authorized providers may omit effect metadata.
        } },
        assessorFactory: () => ({ assess: async input => {
          const approved = await approvingTestAssessor().assess(input);
          if (recovery && input.step.id === "response") return { ...approved, approved: false,
            criteria: approved.criteria.map(item => ({ ...item, satisfied: false })), feedback: "Acquire the mailbox evidence before answering.",
            failedBoundary: { stepId: input.step.id, missingEvidenceKinds: ["source_summary" as const],
              violatedSkillRequirements: [], reusableEvidenceRefs: [], suggestedRepairShape: "revise_plan" as const } };
          assert.deepEqual(operations, ["count", "search", "read"]);
          assert.equal(input.evidence.toolCalls.filter(item => item.toolName.startsWith("connector_126_mail_")).length, 3);
          return approved;
        } }),
        planRevisionAssessorFactory: () => ({ assess: async () => ({ approved: true, feedback: "", evidenceRefs: [] }) }),
        recoveryPlannerFactory: () => ({ decide: async input => {
          revisions++;
          const failed = input.plan!.steps.find(step => step.id === input.failedBoundary!.stepId)!;
          const repair = repairLeafForFailedBoundary(failed, input.failedBoundary!, input.plan!.version);
          return { actionId: input.action.id, expectedActionRevision: input.action.revision, decision: "revise_plan" as const,
            rationale: "Use the authorized mailbox operations to complete the requested reply.", evidenceRefs: [],
            planRevision: { schema: "agentloop.outcomePlan/v2" as const, shape: "recovery_patch" as const,
              goal: input.plan!.goal, selectedSkillIds: [], steps: [{ ...repair,
                requiredCapabilities: ["conversation_delivery", "email.count", "email.search", "email.read"] }] } };
        } }),
        modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async request => {
          if (request.runId.startsWith("conversation-turn:")) return resolve("整理我今天收到的邮件", {
            evidenceStrategy: "source_grounded", requiredCapabilityReferences: [{ kind: "tool_source", reference: "126 邮箱" }],
          });
          if (request.phase === "planning") return answerPlan("整理我今天收到的邮件", ["email.count", "email.search", "email.read"]);
          const toolFor = (operation: string) => request.tools.find(tool => tool.description.includes(`Connector operation: ${operation}`))!;
          for (const operation of ["email.count", "email.search", "email.read"]) assert.ok(toolFor(operation), operation);
          assert.equal(request.tools.some(tool => tool.name === "computer_run_command"), false);
          assert.equal(request.tools.some(tool => tool.name === "computer_write_file"), false);
          if (recovery && revisions === 0) return text("Mailbox evidence is still missing.");
          const turn = turns.get(request.runId) ?? 0;
          turns.set(request.runId, turn + 1);
          if (turn === 0) return call(toolFor("email.count").name, range);
          if (turn === 1) return call(toolFor("email.search").name, range);
          if (turn === 2) return call(toolFor("email.read").name, { messageId: message.id });
          return text("今天收到 1 封邮件：fixture@example.test，Review request，请审阅提案。");
        } }),
      });
      const run = await service.executeConversation("owner", "用126 邮箱整理我今天收到的邮件", {
        connectorConnectionIds: [connection.id], allowDangerousTools: false,
      });
      const events = await service.events("owner", run.id);
      assert.equal(run.status, "completed", JSON.stringify(events.filter(event => /failed|rejected/.test(event.type))));
      assert.equal(events.find(event => event.type === "conversation.turn.resolved")!.data.mode, "reply");
      assert.deepEqual(operations, ["count", "search", "read"]);
      assert.equal(revisions, recovery ? 1 : 0);
      assert.equal(events.filter(event => event.type === "run.completed").length, 1);
      assert.equal(events.some(event => event.type === "recovery.decision_rejected"), false);
      const { plan } = await service.plan("owner", run.id);
      const completed = plan.steps.find(step => step.retiredAt === undefined)!;
      for (const operation of ["email_count", "email_search", "email_read"]) {
        assert.ok(completed.executionBinding.resolvedToolNames.some(name => name.includes(operation)));
      }
      assert.ok(completed.evidence?.publishedResult?.inputs.length);
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  });
}
