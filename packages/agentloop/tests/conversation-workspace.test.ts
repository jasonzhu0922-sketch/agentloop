import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PlanProposal, Planner, TaskSpec } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { AppError } from "../src/shared/errors.ts";
import { SourceRepository } from "../src/storage/repositories/source-repository.ts";
import type { RuntimeTool } from "../src/tools/tool-registry.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS, testOwner } from "./runtime-test-helpers.ts";

test("Computer Tool writes are isolated by conversation and reused by follow-up runs", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-conversation-workspace-"));
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => new ConversationWriteModel(),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const first = await runs.execute(owner.user.id, "write shared.txt as first", {
      allowDangerousTools: true,
    });
    const second = await runs.execute(owner.user.id, "write followup.txt as second", {
      allowDangerousTools: true,
      conversationId: first.conversationId,
    });
    const third = await runs.execute(owner.user.id, "write shared.txt as third", {
      allowDangerousTools: true,
    });

    assert.equal(second.conversationId, first.conversationId);
    assert.notEqual(third.conversationId, first.conversationId);
    assert.equal(await fs.readFile(join(workspace, "conversations", first.conversationId!, "shared.txt"), "utf8"), "first\n");
    assert.equal(await fs.readFile(join(workspace, "conversations", first.conversationId!, "followup.txt"), "utf8"), "second\n");
    assert.equal(await fs.readFile(join(workspace, "conversations", third.conversationId!, "shared.txt"), "utf8"), "third\n");
    await assert.rejects(() => fs.stat(join(workspace, "shared.txt")));
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("uploaded source storage can be Runtime-owned while the work workspace stays shared", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-shared-workspace-"));
  const sourceStorage = await fs.mkdtemp(join(tmpdir(), "agentloop-runtime-sources-"));
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      sourceStorageRoot: sourceStorage,
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async () => ({ content: "unused", finishReason: "stop" as const, toolCalls: [] }) }),
    });
    await runs.ensureConversation(owner.user.id, "conversation-source-root", "upload a note");
    const source = await runs.uploadSource(owner.user.id, {
      conversationId: "conversation-source-root",
      originalName: "note.txt",
      content: Buffer.from("runtime-owned upload\n"),
    });
    const row = await database.prepare("SELECT storage_path FROM sources WHERE id = ?").get(source.id) as { storage_path: string };
    assert.ok(row.storage_path.startsWith(sourceStorage));
    assert.equal(row.storage_path.startsWith(workspace), false);
    assert.equal(await fs.readFile(row.storage_path, "utf8"), "runtime-owned upload\n");
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(sourceStorage, { recursive: true, force: true });
  }
});

test("owner-scoped Runtime storage isolates workspaces and uploaded sources", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-owner-workspace-"));
  const sourceStorage = await fs.mkdtemp(join(tmpdir(), "agentloop-owner-sources-"));
  const database = new AppDatabase(":memory:");
  try {
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      sourceStorageRoot: sourceStorage,
      ownerScopedWorkspace: true,
      modelFactory: () => new ConversationWriteModel(),
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });
    const firstOwner = "owner/a";
    const secondOwner = "owner-b";
    const firstConversationId = "first-conversation";
    const secondConversationId = "second-conversation";
    await runs.ensureConversation(firstOwner, firstConversationId, "first owner workspace");
    await runs.ensureConversation(secondOwner, secondConversationId, "second owner workspace");
    await runs.execute(firstOwner, "write owner.txt as first", { allowDangerousTools: true, conversationId: firstConversationId });
    await runs.execute(secondOwner, "write owner.txt as second", { allowDangerousTools: true, conversationId: secondConversationId });
    const firstSource = await runs.uploadSource(firstOwner, { conversationId: firstConversationId, originalName: "brief.txt", content: Buffer.from("first source\n") });
    const secondSource = await runs.uploadSource(secondOwner, { conversationId: secondConversationId, originalName: "brief.txt", content: Buffer.from("second source\n") });

    assert.equal(await fs.readFile(join(workspace, "users", "user-owner%2Fa", "conversations", firstConversationId, "owner.txt"), "utf8"), "first\n");
    assert.equal(await fs.readFile(join(workspace, "users", "user-owner-b", "conversations", secondConversationId, "owner.txt"), "utf8"), "second\n");
    assert.equal(await fs.readFile(join(sourceStorage, "users", "user-owner%2Fa", "conversations", firstConversationId, "sources", firstSource.id, "original"), "utf8"), "first source\n");
    assert.equal(await fs.readFile(join(sourceStorage, "users", "user-owner-b", "conversations", secondConversationId, "sources", secondSource.id, "original"), "utf8"), "second source\n");
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(sourceStorage, { recursive: true, force: true });
  }
});

test("Run visible directories are exposed as read-only planning and execution capability", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-workspace-"));
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-materials-"));
  const database = new AppDatabase(":memory:");
  try {
    await fs.writeFile(join(visible, "market-brief.md"), "Quarterly signal: local visible directory evidence.\n");

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner = new VisibleDirectoryPlanner();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => new VisibleDirectoryReadModel(),
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.execute(owner.user.id, "读取 market-brief.md", {
      allowDangerousTools: true,
      visibleDirectories: [visible],
    });

    assert.equal(run.status, "completed");
    assert.match(run.output ?? "", /local visible directory evidence/);
    assert.equal(planner.visibleDirectoryCount, 1);
    assert.equal(planner.visibleToolAvailable, true);
    const started = (await runs.events(owner.user.id, run.id)).find((event) => event.type === "run.started");
    assert.equal(Array.isArray(started?.data.visibleDirectories), true);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(visible, { recursive: true, force: true });
  }
});

test("Conversation visible directories persist across follow-up runs until explicitly cleared", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-bound-visible-workspace-"));
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-bound-visible-materials-"));
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner = new RecordingVisibleDirectoryPlanner();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => new NoToolCompletionModel(),
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });

    const first = await runs.execute(owner.user.id, "bind visible directory", {
      allowDangerousTools: true,
      visibleDirectories: [visible],
    });
    assert.ok(first.conversationId);
    const second = await runs.execute(owner.user.id, "reuse bound visible directory", {
      allowDangerousTools: true,
      conversationId: first.conversationId,
    });

    assert.equal(second.conversationId, first.conversationId);
    assert.deepEqual(planner.visibleDirectoryCounts, [1, 1]);
    assert.deepEqual((await runs.getConversation(owner.user.id, first.conversationId)).conversation.visibleDirectories, [
      await fs.realpath(visible),
    ]);

    await runs.updateConversationVisibleDirectories(owner.user.id, first.conversationId, []);
    await runs.execute(owner.user.id, "after user removed visible directory", {
      allowDangerousTools: true,
      conversationId: first.conversationId,
    });
    assert.deepEqual(planner.visibleDirectoryCounts, [1, 1, 0]);
    assert.deepEqual((await runs.getConversation(owner.user.id, first.conversationId)).conversation.visibleDirectories, []);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(visible, { recursive: true, force: true });
  }
});

test("Conversation entry classifies with Runtime-owned external context handles", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-auto-visible-workspace-"));
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-auto-visible-materials-"));
  const database = new AppDatabase(":memory:");
  try {
    await fs.writeFile(join(visible, "performance.xlsx"), "xlsx-like fixture");

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner = new RecordingVisibleDirectoryPlanner();
    const model = new ContextAwareConversationIntentModel();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });

    const executionRun = await runs.executeConversation(owner.user.id, "帮我分析一下这个绩效评价情况", {
      allowDangerousTools: true,
      visibleDirectories: [visible],
    });
    const replyRun = await runs.executeConversation(owner.user.id, "刚才我问了什么？", {
      allowDangerousTools: true,
      conversationId: executionRun.conversationId,
    });

    assert.equal(executionRun.status, "completed");
    assert.equal(replyRun.status, "completed");
    assert.equal(model.intentCalls, 2);
    assert.match(model.intentContexts[0] ?? "", /agentloop\.conversationTurnContext\/v1/);
    assert.match(model.intentContexts[0] ?? "", /"visibleDirectories":\[/);
    assert.deepEqual(planner.visibleDirectoryCounts, [1, 0]);
    assert.deepEqual(planner.responseOnlyFlags, [false, true]);
    assert.equal(planner.availableToolNameSnapshots[0]?.includes("visible_find_files"), true);
    assert.equal(planner.availableToolNameSnapshots[0]?.includes("visible_read_files"), true);
    assert.deepEqual(planner.availableToolNameSnapshots[1], []);
    assert.deepEqual((await runs.events(owner.user.id, executionRun.id)).find((event) => event.type === "conversation.intent.classified")?.data, { kind: "execute" });
    assert.deepEqual((await runs.events(owner.user.id, replyRun.id)).find((event) => event.type === "conversation.intent.classified")?.data, { kind: "reply" });
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(visible, { recursive: true, force: true });
  }
});

test("a question about a prior artifact remains a direct reply despite an over-eager resolver", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const planner = new RecordingVisibleDirectoryPlanner();
    const model = new OverEagerPriorArtifactResolverModel();
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });

    const prior = await runs.execute(owner.user.id, "deliver the prior presentation", {
      allowDangerousTools: true,
    });
    const reply = await runs.executeConversation(owner.user.id, "我的意思是你回答我，你为什么能够这么快把 ppt 做好？", {
      allowDangerousTools: true,
      conversationId: prior.conversationId,
    });

    assert.equal(reply.status, "completed");
    assert.match(reply.output ?? "", /直接解释/);
    assert.deepEqual(planner.responseOnlyFlags, [false, true]);
    const resolved = (await runs.events(owner.user.id, reply.id)).find((event) => event.type === "conversation.turn.resolved");
    assert.equal(resolved?.data.mode, "reply");
    assert.equal(resolved?.data.inputMode, "none");
    assert.equal(resolved?.data.targetArtifact, undefined);
    assert.equal(resolved?.data.targetResult, undefined);

    const implementationQuestion = await runs.executeConversation(owner.user.id, "那所有的 pptx 制作都是使用你这个 Python 脚本来生成吗？", {
      allowDangerousTools: true,
      conversationId: prior.conversationId,
    });
    assert.equal(implementationQuestion.status, "completed");
    assert.match(implementationQuestion.output ?? "", /直接解释/);
    assert.deepEqual(planner.responseOnlyFlags, [false, true, true]);
    const implementationResolution = (await runs.events(owner.user.id, implementationQuestion.id))
      .find((event) => event.type === "conversation.turn.resolved");
    assert.equal(implementationResolution?.data.mode, "reply");
    assert.equal(implementationResolution?.data.inputMode, "none");
    assert.equal(implementationResolution?.data.targetArtifact, undefined);
    assert.equal(implementationResolution?.data.targetResult, undefined);

    const mutation = await runs.executeConversation(owner.user.id, "请把上一轮的 PPT 改得更专业一些。", {
      allowDangerousTools: true,
      conversationId: prior.conversationId,
    });
    // This model only returns prose: the explicit artifact mutation is
    // executable, but cannot complete without producing the bound artifact.
    assert.equal(mutation.status, "failed");
    assert.deepEqual(planner.responseOnlyFlags, [false, true, true, false]);
    const mutationResolution = (await runs.events(owner.user.id, mutation.id)).find((event) => event.type === "conversation.turn.resolved");
    assert.equal(mutationResolution?.data.mode, "execute");
    assert.equal((await runs.events(owner.user.id, mutation.id)).some((event) => event.type === "terminal.delivery_committed"), false);
  } finally {
    await database.close();
  }
});

test("a structured prior-artifact transform overrides an erroneous source-research strategy", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-prior-artifact-transform-"));
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const model = new ErroneousSourceStrategyArtifactTransformModel();
    const initialPlanner = singleStepTestPlanner();
    let capturedTask: TaskSpec | undefined;
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async (task) => {
          if (task.canonicalState.intent.userInput === "write prior.html as initial") return await initialPlanner.plan(task);
          capturedTask = task;
          throw new Error("captured structured artifact transform");
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const prior = await runs.execute(owner.user.id, "write prior.html as initial", { allowDangerousTools: true });
    assert.equal((await runs.processArtifacts(owner.user.id, prior.id)).some((artifact) => artifact.path === "prior.html"), true);

    await assert.rejects(() => runs.executeConversation(owner.user.id, "html 需要自包含，不要引用外部内容。", {
      allowDangerousTools: true,
      conversationId: prior.conversationId,
    }));
    assert.equal(capturedTask?.canonicalState.intent.turnResolution?.evidenceDemand, "none");
    assert.equal(capturedTask?.canonicalState.intent.understanding.evidence.need, "none");
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a prior-artifact transform keeps implementation artifacts out of canonical terminal deliverables", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-terminal-deliverable-boundary-"));
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const model = new ProcessArtifactPollutingResolverModel();
    const initialPlanner = singleStepTestPlanner();
    let capturedTask: TaskSpec | undefined;
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async (task) => {
          if (task.canonicalState.intent.userInput === "write merged_output.pdf as initial") return await initialPlanner.plan(task);
          capturedTask = task;
          throw new Error("captured repaired terminal deliverable intent");
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const prior = await runs.execute(owner.user.id, "write merged_output.pdf as initial", { allowDangerousTools: true });
    assert.equal((await runs.processArtifacts(owner.user.id, prior.id)).some((artifact) => artifact.path === "merged_output.pdf"), true);

    await assert.rejects(() => runs.executeConversation(owner.user.id, "现在把合并文件拆分为平均的 4 份", {
      allowDangerousTools: true,
      conversationId: prior.conversationId,
    }), /Run failed/);

    assert.equal(model.resolverAttempts, 2);
    assert.match(model.repairPrompts[0] ?? "", /Remove unrequested terminal deliverable\(s\): split_pdfs_script/);
    assert.equal(capturedTask?.canonicalState.intent.turnResolution?.relation, "refine_prior");
    assert.match(capturedTask?.canonicalState.intent.turnResolution?.effectiveGoal ?? "", /平均拆分为 4 份/);
    assert.doesNotMatch(capturedTask?.canonicalState.intent.turnResolution?.effectiveGoal ?? "", /合并为一个/);
    const understanding = capturedTask?.canonicalState.intent.understanding;
    assert.equal(understanding?.format, "pdf");
    assert.deepEqual(understanding?.deliverables?.map((deliverable) => deliverable.targetId), ["prior_artifact_transformation"]);
    assert.deepEqual(understanding?.artifactTargets?.map((target) => target.id), [
      "prior_artifact_transformation.1",
      "prior_artifact_transformation.2",
      "prior_artifact_transformation.3",
      "prior_artifact_transformation.4",
    ]);
    assert.equal(understanding?.artifactTargets?.some((target) => target.kind === "code"), false);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a uniquely named reusable artifact repairs resolver lineage instead of falling back to a new goal", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-prior-artifact-lineage-"));
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const model = new PriorArtifactLineageDriftModel();
    const initialPlanner = singleStepTestPlanner();
    let capturedTask: TaskSpec | undefined;
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async (task) => {
          if (task.canonicalState.intent.userInput === "write merged_output.pdf as initial") return await initialPlanner.plan(task);
          capturedTask = task;
          throw new Error("captured repaired prior artifact lineage");
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const prior = await runs.execute(owner.user.id, "write merged_output.pdf as initial", { allowDangerousTools: true });
    await assert.rejects(() => runs.executeConversation(owner.user.id, "现在把合并文件拆分为平均的 4 份", {
      allowDangerousTools: true,
      conversationId: prior.conversationId,
    }), /Run failed/);

    const resolution = capturedTask?.canonicalState.intent.turnResolution;
    assert.equal(resolution?.relation, "refine_prior");
    assert.equal(resolution?.inputMode, "prior_artifact");
    assert.equal(resolution?.targetRunId, prior.id);
    assert.equal(resolution?.targetArtifact?.path, "merged_output.pdf");
    assert.equal(resolution?.source, "model_guarded");
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("an artifact edit can continue a failed goal while retaining the earlier artifact's producer", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-artifact-input-owner-"));
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const initialModel = new ConversationWriteModel();
    const objective = "在 daz 这个 sheet 顶部增加表头行，一共三列：姓名 工号 年龄";
    let resolverCalls = 0;
    let selectedArtifactPath = "workbook.xlsx";
    const capturedTasks: TaskSpec[] = [];
    const model: ModelAdapter = {
      limits: TEST_MODEL_LIMITS,
      async complete(request) {
        if (!request.runId.startsWith("conversation-turn:")) return await initialModel.complete(request);
        resolverCalls += 1;
        return { content: "", finishReason: "tool_calls", toolCalls: [{
          id: `edit-resolution-${resolverCalls}`, name: "resolve_conversation_turn", arguments: {
            mode: "execute", relation: "continue_prior", inputMode: "prior_artifact",
            targetGoalCandidateId: resolverCalls === 1 ? "goal_candidate_1" : "goal_candidate_2",
            targetArtifact: { path: selectedArtifactPath }, effectiveGoal: objective,
            taskIntent: { schema: "agentloop.conversationTaskIntent/v1", operation: "transform_artifact",
              requiresExecution: true, deliverables: [{ targetId: "updated-workbook", purpose: objective,
                expectedArtifactCount: 1, action: "modify", kind: "spreadsheet", format: "xlsx", surface: "workspace_artifact" }] },
            evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
            userConstraints: [], requiredCapabilityReferences: [],
          },
        }] };
      },
    };
    const runs = new RunService({ database, skills: new SkillService(database), workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => ({ async plan(task) {
        if (task.canonicalState.intent.userInput.startsWith("write ")) return await singleStepTestPlanner().plan(task);
        capturedTasks.push(task);
        throw new AppError("PLANNING_ERROR", "stop after captured artifact binding", 422);
      } }),
      assessorFactory: () => approvingTestAssessor(),
    });
    const producer = await runs.execute(owner.user.id, "write workbook.xlsx as initial", { allowDangerousTools: true });
    assert.ok((await runs.processArtifacts(owner.user.id, producer.id)).some((artifact) => artifact.path === "workbook.xlsx"));
    const failedRunIds: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(() => runs.executeConversation(owner.user.id, objective, {
        allowDangerousTools: true, conversationId: producer.conversationId,
      }), (error: unknown) => {
        if (!(error instanceof AppError) || !/stop after captured artifact binding/.test(error.message)) return false;
        failedRunIds.push(String(error.details?.runId));
        return true;
      });
    }
    assert.equal(resolverCalls, 3, "each valid resolution must reach Planner without contract retries");
    assert.equal(capturedTasks.length, 3);
    for (const [index, task] of capturedTasks.entries()) {
      const resolution = task.canonicalState.intent.turnResolution!;
      assert.equal(resolution.relation, "refine_prior");
      assert.equal(resolution.targetRunId, index === 0 ? producer.id : failedRunIds[0]);
      assert.deepEqual(resolution.targetArtifact, { runId: producer.id, path: "workbook.xlsx" });
      assert.equal(resolution.effectiveGoal, objective);
    }
    const persisted = capturedTasks[2]!.conversationWorkingSet?.resolvedIntents?.find((item) => item.runId === failedRunIds[1]);
    assert.equal(persisted?.resolution.targetRunId, failedRunIds[0]);
    assert.deepEqual(persisted?.resolution.targetArtifact, { runId: producer.id, path: "workbook.xlsx" });
    selectedArtifactPath = "unissued-workbook.xlsx";
    await assert.rejects(() => runs.executeConversation(owner.user.id, objective, {
      allowDangerousTools: true, conversationId: producer.conversationId,
    }), /canonical contract after 3 attempts/);
    assert.equal(capturedTasks.length, 3, "an unissued artifact must never reach Planner");
    assert.equal(resolverCalls, 6, "invalid bindings retain the bounded three-attempt limit");
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a malformed canonical turn resolution exhausts bounded repair and never falls back", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-turn-resolution-fail-closed-"));
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const model = new AlwaysMalformedPriorArtifactResolverModel();
    let plannerCalls = 0;
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async (task) => {
          plannerCalls += 1;
          return await singleStepTestPlanner().plan(task);
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const prior = await runs.execute(owner.user.id, "write merged_output.pdf as initial", { allowDangerousTools: true });
    const plannerCallsBeforeFollowUp = plannerCalls;
    let failedRunId: string | undefined;
    await assert.rejects(
      () => runs.executeConversation(owner.user.id, "现在把合并文件拆分为平均的 4 份", {
        allowDangerousTools: true,
        conversationId: prior.conversationId,
      }),
      (error: unknown) => {
        failedRunId = error instanceof AppError && typeof error.details?.runId === "string" ? error.details.runId : undefined;
        return error instanceof AppError && error.code === "PLANNING_ERROR" && /canonical contract after 3 attempts/.test(error.message);
      },
    );

    assert.ok(failedRunId);
    assert.equal(model.resolverAttempts, 3);
    assert.equal(plannerCalls, plannerCallsBeforeFollowUp);
    const events = await runs.events(owner.user.id, failedRunId);
    assert.equal(events.filter((event) => event.type === "conversation.turn.resolution_rejected").length, 3);
    assert.equal(events.some((event) => event.type === "conversation.turn.resolved"), false);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("conversation resolver gives field-specific repair feedback for a missing artifact count", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const model = new MissingExpectedArtifactCountResolverModel();
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async () => { throw new AppError("PLANNING_ERROR", "stop after repaired resolver", 422); },
      }),
    });

    let runId: string | undefined;
    await assert.rejects(
      () => runs.executeConversation(owner.user.id, "生成一个 PDF 文件"),
      (error: unknown) => {
        if (!(error instanceof AppError) || error.code !== "PLANNING_ERROR") return false;
        runId = typeof error.details?.runId === "string" ? error.details.runId : undefined;
        return /stop after repaired resolver/.test(error.message);
      },
    );

    assert.equal(model.resolverAttempts, 2);
    assert.equal(model.repairPrompts.length, 1);
    assert.match(model.repairPrompts[0] ?? "", /taskIntent\.deliverables\[0\]\.expectedArtifactCount must be an integer from 1 to 8/);
    assert.ok(runId);
    const events = await runs.events(owner.user.id, runId);
    const rejected = events.find((event) => event.type === "conversation.turn.resolution_rejected");
    assert.deepEqual(rejected?.data.deliverableExpectedArtifactCounts, [null]);
  } finally {
    await database.close();
  }
});

test("conversation resolver gives field-specific repair feedback for an invalid evidence strategy", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const model = new InvalidEvidenceStrategyResolverModel();
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async () => { throw new AppError("PLANNING_ERROR", "stop after repaired resolver", 422); },
      }),
    });

    await assert.rejects(
      () => runs.executeConversation(owner.user.id, "生成一个 PDF 文件"),
      /stop after repaired resolver/,
    );

    assert.equal(model.resolverAttempts, 2);
    assert.match(
      model.repairPrompts[0] ?? "",
      /evidenceStrategy must be one of none, lookup_lite, source_grounded, strict_user_source, or bound_visible_sources/,
    );
  } finally {
    await database.close();
  }
});

// Exercise parser failures that previously fell through a separate feedback
// validator and produced the same non-actionable message on every retry.
for (const fixture of [
  { name: "non-ASCII target ID", deliverable: { targetId: "众筹推荐" }, feedback: /deliverables\[0\]\.targetId must match/ },
  { name: "duplicate target ID", duplicate: true, feedback: /deliverables\[1\]\.targetId must be unique/ },
  { name: "oversized purpose", deliverable: { purpose: "a".repeat(501) }, feedback: /deliverables\[0\]\.purpose must be/ },
  { name: "invalid action", deliverable: { action: "generate" }, feedback: /deliverables\[0\]\.action must be/ },
  { name: "invalid semantic kind", deliverable: { kind: "pptx" }, feedback: /deliverables\[0\]\.kind must be/ },
  { name: "invalid surface", deliverable: { surface: "file" }, feedback: /deliverables\[0\]\.surface must be/ },
  { name: "oversized format", deliverable: { format: "x".repeat(33) }, feedback: /deliverables\[0\]\.format must be/ },
  { name: "count exceeding the aggregate bound", deliverable: { expectedArtifactCount: 5 }, duplicate: true, distinctId: true, feedback: /at most 8 workspace artifacts in total/ },
  { name: "long multi-artifact ID", deliverable: { targetId: "a".repeat(127), expectedArtifactCount: 2 }, feedback: /targetId must be at most 126/ },
  { name: "inferred capability", root: { requiredCapabilityReferences: [{ kind: "skill", reference: "presentations" }] }, feedback: /requiredCapabilityReferences must be/ },
  { name: "bound strategy without a directory", root: { evidenceStrategy: "bound_visible_sources" }, feedback: /evidenceStrategy and sourceBinding must agree/ },
  { name: "empty primary directory binding", root: { sourceBinding: { mode: "primary_data", visibleDirectoryIds: [] } }, feedback: /evidenceStrategy and sourceBinding must agree/ },
  { name: "uploaded source used as a directory", root: { sourceBinding: { mode: "primary_data", visibleDirectoryIds: ["src_uploaded"] } }, feedback: /sourceBinding must contain mode/ },
  { name: "missing prior Result selector", root: { inputMode: "prior_result" }, feedback: /inputMode=prior_result requires resultCandidateId/ },
  { name: "missing prior artifact selector", root: { inputMode: "prior_artifact" }, feedback: /inputMode=prior_artifact requires targetArtifact.path/ },
  { name: "reply that requests new evidence", root: { mode: "reply", evidenceStrategy: "lookup_lite" }, noExecution: true, feedback: /mode=reply or clarify requires evidenceStrategy=none/ },
]) {
  test(`conversation resolver repairs ${fixture.name} using its parser rejection`, async () => {
    const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-resolver-repair-"));
    const database = new AppDatabase(":memory:");
    try {
      const owner = testOwner();
      let attempts = 0;
      const repairPrompts: string[] = [];
      const model: ModelAdapter = {
        limits: TEST_MODEL_LIMITS,
        complete: async (request) => {
          assert.ok(request.runId.startsWith("conversation-turn:"));
          attempts += 1;
          if (attempts > 1) repairPrompts.push(request.systemPrompt);
          const repaired = attempts > 1 && fixture.feedback.test(request.systemPrompt);
          const deliverable = {
            targetId: "crowdfunding-deck", purpose: "制作游戏众筹推荐演示文稿", expectedArtifactCount: 1,
            action: "create", kind: "presentation", format: "pptx", surface: "workspace_artifact",
            ...(repaired ? {} : fixture.deliverable),
          };
          return {
            content: "", finishReason: "tool_calls",
            toolCalls: [{ id: `resolution-${attempts}`, name: "resolve_conversation_turn", arguments: {
              mode: "execute", relation: "new_goal", inputMode: "none",
              effectiveGoal: "基于上传的游戏设计稿，生成游戏众筹推荐 PPTX。",
              evidenceStrategy: "none", sourceBinding: { mode: "none", visibleDirectoryIds: [] },
              userConstraints: [], requiredCapabilityReferences: [],
              taskIntent: {
                schema: "agentloop.conversationTaskIntent/v1", operation: "create_artifact",
                requiresExecution: repaired || !fixture.noExecution,
                deliverables: [deliverable, ...(!repaired && fixture.duplicate ? [{ ...deliverable, ...(fixture.distinctId ? { targetId: "second-deck" } : {}) }] : [])],
              },
              ...(repaired ? {} : fixture.root),
            } }],
          };
        },
      };
      const runs = new RunService({
        database, workspaceRoot: workspace, skills: new SkillService(database), modelFactory: () => model,
        plannerFactory: () => ({ plan: async (task) => {
          assert.equal(task.canonicalState.intent.understanding.deliverables[0]?.kind, "presentation");
          assert.equal(task.sources?.[0]?.originalName, "游戏设计稿.md");
          throw new AppError("PLANNING_ERROR", "repaired resolution reached Planner", 422);
        } }),
      });
      const conversation = "resolver-repair-fixture";
      await runs.ensureConversation(owner.user.id, conversation, "设计稿");
      await runs.uploadSource(owner.user.id, { conversationId: conversation, originalName: "游戏设计稿.md", content: Buffer.from("# 游戏设计稿\n玩家探索村庄并发现秘密。") });
      let runId: string | undefined;
      await assert.rejects(
        () => runs.executeConversation(owner.user.id, "帮我生成一份 pptx，用于游戏众筹推荐", { conversationId: conversation }),
        (error: unknown) => {
          if (!(error instanceof AppError)) return false;
          runId = typeof error.details?.runId === "string" ? error.details.runId : undefined;
          return /repaired resolution reached Planner/.test(error.message);
        },
      );
      assert.equal(attempts, 2);
      assert.equal(repairPrompts.length, 1);
      assert.match(repairPrompts[0]!, fixture.feedback);
      assert.ok(runId);
      const events = await runs.events(owner.user.id, runId);
      const rejected = events.filter((event) => event.type === "conversation.turn.resolution_rejected");
      assert.equal(rejected.length, 1);
      assert.match(String(rejected[0]?.data.feedback), fixture.feedback);
      assert.ok(events.some((event) => event.type === "conversation.turn.resolved"));
    } finally {
      await database.close();
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
}

test("conversation resolver preserves a concrete contract error after three unrepairable attempts", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const validModel = new MissingExpectedArtifactCountResolverModel();
    let attempts = 0;
    let plannerCalls = 0;
    const runs = new RunService({
      database, skills: new SkillService(database),
      modelFactory: () => ({ limits: TEST_MODEL_LIMITS, complete: async (request) => {
        attempts += 1;
        const response = await validModel.complete(request);
        const args = response.toolCalls[0]!.arguments as Record<string, unknown>;
        args.requiredCapabilityReferences = [{ kind: "skill", reference: "invented-skill" }];
        return response;
      } }),
      plannerFactory: () => ({ plan: async () => { plannerCalls += 1; throw new Error("invalid resolution reached Planner"); } }),
    });
    await assert.rejects(() => runs.executeConversation(owner.user.id, "生成一个 PDF 文件"), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /canonical contract after 3 attempts/);
      assert.match(String(error.details?.repairFeedback), /requiredCapabilityReferences must be/);
      return true;
    });
    assert.equal(attempts, 3);
    assert.equal(plannerCalls, 0);
  } finally {
    await database.close();
  }
});

test("a new-goal resolver exposes only Runtime-issued candidates and repairs invented prior selectors", async () => {
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-new-goal-candidate-schema-"));
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const model = new InventedNewGoalCandidateResolverModel();
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async () => { throw new AppError("PLANNING_ERROR", "stop after candidate-safe resolver", 422); },
      }),
    });

    await assert.rejects(
      () => runs.executeConversation(owner.user.id, "根据当前材料生成一个众筹介绍 PPTX", {
        allowDangerousTools: true,
        visibleDirectories: [visible],
      }),
      /stop after candidate-safe resolver/,
    );

    assert.equal(model.resolverAttempts, 2);
    assert.equal(model.firstSchemaHadTargetGoalCandidateId, false);
    assert.equal(model.firstSchemaHadTargetArtifact, false);
    assert.deepEqual(model.firstRelationEnum, ["new_goal"]);
    assert.deepEqual(model.firstVisibleDirectoryIdEnum, ["visible_dir_1"]);
    assert.match(model.firstRuntimeContext, /"priorGoalCandidates":\[\]/);
    assert.match(model.firstRuntimeContext, /"reusableArtifacts":\[\]/);
    assert.match(model.firstRuntimeContext, /"reusableResultCandidates":\[\]/);
    assert.match(model.repairPrompts[0] ?? "", /targetArtifact\.path must select one unambiguous Runtime-issued reusable prior artifact path/);
  } finally {
    await database.close();
    await fs.rm(visible, { recursive: true, force: true });
  }
});

test("a prior Result continuation does not turn historical ToolSource provenance into a new acquisition requirement", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-prior-result-tool-source-"));
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    let capturedTask: TaskSpec | undefined;
    const sourceTool = ontoflowToolSourceFixture();
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      tools: [sourceTool],
      modelFactory: () => priorResultContinuationResolver("prior_result"),
      plannerFactory: () => ({
        plan: async (task) => {
          if (task.canonicalState.intent.userInput === "seed reusable ODS result") return await singleStepTestPlanner().plan(task);
          capturedTask = task;
          throw new Error("captured prior Result continuation task");
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const prior = await runs.execute(owner.user.id, "seed reusable ODS result");
    await assert.rejects(() => runs.executeConversation(owner.user.id, "Use the prior Result to produce the DDM report without refreshing data.", {
      conversationId: prior.conversationId,
    }), /Run failed/);

    assert.equal(capturedTask?.canonicalState.intent.turnResolution?.inputMode, "prior_result");
    assert.ok(capturedTask?.canonicalState.intent.turnResolution?.targetResult);
    assert.equal(capturedTask?.canonicalState.intent.turnResolution?.evidenceDemand, "none");
    assert.deepEqual(capturedTask?.canonicalState.intent.requiredToolSourceIds, []);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("a refresh-sources continuation retains an explicitly named ToolSource requirement", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-refresh-source-tool-source-"));
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    let capturedTask: TaskSpec | undefined;
    const sourceTool = ontoflowToolSourceFixture();
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      tools: [sourceTool],
      modelFactory: () => priorResultContinuationResolver("refresh_sources"),
      plannerFactory: () => ({
        plan: async (task) => {
          if (task.canonicalState.intent.userInput === "seed reusable ODS result") return await singleStepTestPlanner().plan(task);
          capturedTask = task;
          throw new Error("captured refresh-sources continuation task");
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const prior = await runs.execute(owner.user.id, "seed reusable ODS result");
    await assert.rejects(() => runs.executeConversation(owner.user.id, "Refresh source data with ontoflow-jtbc, then produce the DDM report.", {
      conversationId: prior.conversationId,
    }), /Run failed/);

    assert.equal(capturedTask?.canonicalState.intent.turnResolution?.inputMode, "refresh_sources");
    assert.deepEqual(capturedTask?.canonicalState.intent.requiredToolSourceIds, ["ontoflow-jtbc"]);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("conversation resolver publishes Action-bound model lifecycle telemetry with its non-stream deadline", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const lines: string[] = [];
    const owner = testOwner();
    const model = new TimedConversationIntentModel();
    const runs = new RunService({
      database,
      runEventLogSink: (line) => { lines.push(line); },
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => ({
        plan: async () => { throw new AppError("PLANNING_ERROR", "stop after resolver telemetry", 422); },
      }),
    });
    let runId: string | undefined;
    await assert.rejects(
      () => runs.executeConversation(owner.user.id, "你好"),
      (error: unknown) => {
        if (!(error instanceof AppError) || error.code !== "PLANNING_ERROR") return false;
        runId = typeof error.details?.runId === "string" ? error.details.runId : undefined;
        return true;
      },
    );
    assert.ok(runId);
    const events = await runs.events(owner.user.id, runId);
    const started = events.find((event) => event.type === "model.request.started" && event.data.purpose === "conversation_turn_resolver");
    const completed = events.find((event) => event.type === "model.request.completed" && event.data.purpose === "conversation_turn_resolver");
    assert.ok(started);
    assert.ok(completed);
    assert.equal(completed.data.providerRequestId, "resolver-provider-request");
    assert.match(lines.find((line) => line.includes("event=model.request.completed")) ?? "", /providerRequestId="resolver-provider-request"/);
    assert.equal(started.data.request && typeof started.data.request === "object" && (started.data.request as { stream?: unknown }).stream, false);
    assert.equal(typeof started.data.actionId, "string");
    assert.equal(completed.data.actionId, started.data.actionId);
    assert.equal(typeof started.data.actionDeadlineAt, "number");
    const actionCreated = events.find((event) => event.type === "action.created" && event.data.actionId === started.data.actionId);
    assert.ok(actionCreated);
    assert.equal(Number(started.data.actionDeadlineAt) - actionCreated.createdAt, 25_000);
    const committed = events.find((event) => event.type === "action.result_committed" && event.data.actionId === started.data.actionId);
    assert.ok(committed);
    assert.ok((started.seq ?? 0) < (completed.seq ?? 0));
    assert.ok((completed.seq ?? 0) < (committed.seq ?? 0));
  } finally {
    await database.close();
  }
});

test("conversation resolver publishes an Action-bound failed model request before its Action fails", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const lines: string[] = [];
    const owner = testOwner();
    const runs = new RunService({
      database,
      runEventLogSink: (line) => { lines.push(line); },
      skills: new SkillService(database),
      modelFactory: () => new FailingConversationResolverModel(),
    });
    let runId: string | undefined;
    await assert.rejects(
      () => runs.executeConversation(owner.user.id, "你好"),
      (error: unknown) => {
        if (!(error instanceof AppError) || error.code !== "MODEL_ERROR") return false;
        runId = typeof error.details?.runId === "string" ? error.details.runId : undefined;
        return true;
      },
    );
    assert.ok(runId);
    const events = await runs.events(owner.user.id, runId);
    const failed = events.find((event) => event.type === "model.request.failed" && event.data.purpose === "conversation_turn_resolver");
    assert.ok(failed);
    assert.equal(failed.data.code, "MODEL_ERROR");
    assert.equal(failed.data.providerRequestId, "resolver-provider-failure");
    assert.match(lines.find((line) => line.includes("event=model.request.failed")) ?? "", /providerRequestId="resolver-provider-failure"/);
    const actionFailed = events.find((event) => event.type === "action.failed" && event.data.actionId === failed.data.actionId);
    assert.ok(actionFailed);
    assert.ok((failed.seq ?? 0) < (actionFailed.seq ?? 0));
  } finally {
    await database.close();
  }
});

test("Conversation resolver atomically binds only the visible directory selected as primary data", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-atomic-visible-workspace-"));
  const unrelated = await fs.mkdtemp(join(tmpdir(), "agentloop-atomic-visible-unrelated-"));
  const performance = await fs.mkdtemp(join(tmpdir(), "agentloop-atomic-visible-performance-"));
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    let capturedTask: TaskSpec | undefined;
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      modelFactory: () => ({
        limits: TEST_MODEL_LIMITS,
        complete: async (request) => {
          if (request.runId.startsWith("conversation-turn:")) {
            return {
              content: "",
              finishReason: "tool_calls" as const,
              toolCalls: [{
                id: "atomic-visible-resolution",
                name: "resolve_conversation_turn",
                arguments: {
                  mode: "execute",
                  relation: "new_goal",
                  inputMode: "none",
                  effectiveGoal: "读取 2026 年 8 月个人绩效评定表，汇总各等级与分值的人数及占比。",
                  taskIntent: {
                    schema: "agentloop.conversationTaskIntent/v1",
                    operation: "analysis",
                    requiresExecution: true,
                    deliverables: [],
                  },
                  evidenceStrategy: "bound_visible_sources",
                  sourceBinding: { mode: "primary_data", visibleDirectoryIds: ["visible_dir_2"] },
                  userConstraints: [],
                },
              }],
            };
          }
          return { content: "绩效分布已汇总。", finishReason: "stop" as const, toolCalls: [] };
        },
      }),
      plannerFactory: () => ({
        plan: async (task) => {
          capturedTask = task;
          return {
            goal: "analyze selected performance data",
            selectedSkillIds: [],
            steps: [{
              id: "aggregate-performance",
              objective: "Aggregate the selected performance table into counts and shares.",
              dependencies: [],
              skillIds: [],
              role: "fact_acquisition",
              requiredCapabilities: ["visible_directory_read"],
              sourceConstraint: { requiredVisibleDirectoryIds: [task.visibleDirectories![0]!.id] },
              evidenceContract: { requiredKinds: ["source_summary"], caveatPolicy: "mark_unverified_facts" },
              successCriteria: [{ id: "delivered", description: "The requested distribution is delivered.", source: "planner" }],
            }],
          };
        },
      }),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.executeConversation(owner.user.id, "分析 2026 年 8 月个人绩效评定表的等级和分值分布", {
      visibleDirectories: [unrelated, performance],
    });

    assert.equal(run.status, "completed");
    assert.deepEqual(capturedTask?.visibleDirectories?.map((directory) => directory.id), ["visible_dir_2"]);
    assert.equal(capturedTask?.canonicalState.intent.understanding.operation, "analysis");
    assert.equal(capturedTask?.canonicalState.intent.understanding.evidence.need, "source_grounded");
    assert.equal(capturedTask?.canonicalState.intent.understanding.operationProfiles.includes("data_analysis"), true);
    assert.equal(capturedTask?.availableToolNames.includes("visible_extract_tables"), true);
    const resolved = (await runs.events(owner.user.id, run.id)).find((event) => event.type === "conversation.turn.resolved");
    assert.deepEqual(resolved?.data.sourceBinding, { mode: "primary_data", visibleDirectoryIds: ["visible_dir_2"] });
    assert.equal(resolved?.data.evidenceDemand, "source_grounded");
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(unrelated, { recursive: true, force: true });
    await fs.rm(performance, { recursive: true, force: true });
  }
});

test("clarification turns do not misrepresent their intentionally tool-free step as an unavailable integration", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => ({
        limits: TEST_MODEL_LIMITS,
        complete: async (request: ModelInvocation): Promise<ModelResponse> => {
          if (request.runId.startsWith("conversation-turn:")) {
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{
                id: "clarify-target",
                name: "resolve_conversation_turn",
                arguments: {
                  mode: "clarify",
                  relation: "new_goal",
                  inputMode: "none",
                  effectiveGoal: "A database analysis was requested, but the target table name is still missing.",
                  taskIntent: {
                    schema: "agentloop.conversationTaskIntent/v1",
                    operation: "analysis",
                    requiresExecution: false,
                    deliverables: [],
                  },
                  evidenceStrategy: "none",
                  sourceBinding: { mode: "none", visibleDirectoryIds: [] },
                  userConstraints: ["Ask for the concrete database schema and table name before analysis."],
                },
              }],
            };
          }
          assert.match(request.systemPrompt, /intentionally tool-free clarification step/);
          assert.match(request.systemPrompt, /Do not claim that MCP servers, Skills, or Tools are unavailable/);
          return {
            content: "请提供实际的数据域和表名（schema.table_name），收到后才能开始查询和建模。",
            finishReason: "stop",
            toolCalls: [],
          };
        },
      }),
    });

    const run = await runs.executeConversation(owner.user.id, "请分析数据库中的目标表");

    assert.equal(run.status, "completed");
    assert.match(run.output ?? "", /请提供实际的数据域和表名/);
    assert.doesNotMatch(run.output ?? "", /MCP.*不可用|工具.*不可用/);
    const events = await runs.events(owner.user.id, run.id);
    assert.equal(events.find((event) => event.type === "conversation.intent.classified")?.data.resolutionMode, "clarify");
    const assessment = events.find((event) => event.type === "skill.compliance.assessed");
    assert.equal(assessment?.data.assessmentProfile, "deterministic");
    assert.equal(assessment?.data.assessmentMethod, "rule");
  } finally {
    await database.close();
  }
});

test("Generic Run execution does not opt into conversation intent classification", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new ContextAwareConversationIntentModel();
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    await assert.rejects(
      () => runs.executeConversation(owner.user.id, "你好", { conversationIntent: "auto" }),
      /conversationIntent is Runtime-owned/,
    );
    const genericRun = await runs.execute(owner.user.id, "process this generic task");
    assert.equal(genericRun.status, "completed");
    assert.equal(model.intentCalls, 0);
    assert.equal((await runs.events(owner.user.id, genericRun.id)).some((event) => event.type === "conversation.intent.classified"), false);

    const conversationRun = await runs.executeConversation(owner.user.id, "你好");
    assert.equal(conversationRun.status, "completed");
    assert.equal(model.intentCalls, 1);
    assert.deepEqual((await runs.events(owner.user.id, conversationRun.id)).find((event) => event.type === "conversation.intent.classified")?.data, { kind: "reply" });
  } finally {
    await database.close();
  }
});

test("reply delivery targets remain canonical through planning, assessment, and terminal commit", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => new GreetingTargetConversationModel(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.executeConversation(owner.user.id, "你好");

    assert.equal(run.status, "completed");
    assert.match(run.output ?? "", /你好/);
    const stored = await database.prepare("SELECT state_json FROM canonical_run_states WHERE run_id = ?")
      .get<{ state_json: string }>(run.id);
    assert.ok(stored);
    const state = JSON.parse(stored.state_json) as {
      phase: string;
      targets: Record<string, { status: string; ownerStepIds: string[] }>;
      gaps: Array<{ targetId?: string; status: string }>;
    };
    assert.equal(state.phase, "completed");
    assert.equal(state.targets.greeting_reply?.status, "accepted");
    assert.deepEqual(state.targets.greeting_reply?.ownerStepIds, ["response"]);
    assert.equal(state.gaps.find((gap) => gap.targetId === "greeting_reply")?.status, "resolved");
    assert.equal((await runs.events(owner.user.id, run.id)).some((event) => event.type === "run.failed"), false);
  } finally {
    await database.close();
  }
});

test("a resource-free artifact conversation turn fails closed after using the canonical Resolver contract", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = testOwner();
    const model = new ContextAwareConversationIntentModel();
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.executeConversation(owner.user.id, "请生成一个 HTML 文件");
    assert.equal(run.status, "failed");
    assert.equal(model.intentCalls, 1);
    const events = await runs.events(owner.user.id, run.id);
    assert.deepEqual(events.find((event) => event.type === "conversation.intent.classified")?.data, { kind: "execute" });
    assert.equal(events.some((event) => event.type === "conversation.turn.resolved"), true);
  } finally {
    await database.close();
  }
});

test("Uploaded sources are bound to a run and read through source tools", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-upload-source-workspace-"));
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner = new UploadedSourcePlanner();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => new UploadedSourceReadModel(),
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });
    const source = await runs.uploadSource(owner.user.id, {
      originalName: "revenue.csv",
      mimeType: "text/csv",
      content: Buffer.from("region,revenue\nNorth,120\nSouth,80\n", "utf8"),
    });

    const run = await runs.execute(owner.user.id, "分析上传文件中的收入", {
      allowDangerousTools: true,
      sourceIds: [source.id],
    });

    assert.equal(run.status, "completed");
    assert.equal(run.sources?.length, 1);
    assert.equal(run.sources?.[0]?.originalName, "revenue.csv");
    assert.match(run.output ?? "", /read_source/);
    assert.equal(planner.sourceCount, 1);
    assert.equal(planner.readSourceAvailable, true);
    const conversation = await runs.getConversation(owner.user.id, run.conversationId!);
    assert.equal(conversation.runs[0].sources?.length, 1);
    assert.equal(conversation.runs[0].sources?.[0]?.originalName, "revenue.csv");
    const started = (await runs.events(owner.user.id, run.id)).find((event) => event.type === "run.started");
    assert.equal(Array.isArray(started?.data.sources), true);
    const sourceRead = (await runs.events(owner.user.id, run.id)).find((event) =>
      event.type === "tool.completed" && event.data.toolName === "read_source"
    );
    assert.match(String(sourceRead?.data.result ?? ""), /North,120/);
    assert.equal((await runs.source(owner.user.id, source.id)).chunkCount, 1);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Uploaded source query matches separated search terms instead of one literal phrase", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-upload-source-query-"));
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => new UploadedSourceQueryModel(),
      plannerFactory: () => new UploadedSourcePlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });
    const source = await runs.uploadSource(owner.user.id, {
      originalName: "foreign-affairs-plan.md",
      mimeType: "text/markdown",
      content: Buffer.from([
        "打造智能化因公出国数字化管理平台。",
        "应用RPA等技术自动化高频流程，利用AI进行风险预警与合规检查。",
        "第一阶段推进风险国别AI预警、照片AI质检和材料智能预审。",
      ].join("\n"), "utf8"),
    });

    const run = await runs.execute(owner.user.id, "总结外事业务 AI 规划", {
      allowDangerousTools: true,
      sourceIds: [source.id],
    });

    assert.equal(run.status, "completed");
    const sourceRead = (await runs.events(owner.user.id, run.id)).find((event) =>
      event.type === "tool.completed" && event.data.toolName === "read_source"
    );
    assert.match(String(sourceRead?.data.result ?? ""), /利用AI进行风险预警/);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Uploaded CID-font PDFs with ToUnicode maps become readable source chunks", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-upload-cid-pdf-"));
  const database = new AppDatabase(":memory:");
  try {

    const owner = testOwner();
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      modelFactory: () => { throw new Error("model is not used"); },
    });
    const source = await runs.uploadSource(owner.user.id, {
      originalName: "评估报告案例.pdf",
      mimeType: "application/pdf",
      content: minimalUnicodeCmapPdf("上海虹桥站 碳减排评估报告"),
    });

    assert.equal(source.status, "ready");
    assert.equal(source.chunkCount, 1);
    assert.match(source.summary ?? "", /上海虹桥站\s*碳减排评估报告/);
    const chunks = await new SourceRepository(database).chunks(source.id);
    assert.match(chunks[0]?.content ?? "", /上海虹桥站\s*碳减排评估报告/);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

function minimalUnicodeCmapPdf(text: string): Buffer {
  const entries = [...text];
  const encoded = entries
    .map((_char, index) => (index + 1).toString(16).padStart(4, "0"))
    .join("");
  const cmapEntries = entries
    .map((char, index) => `<${(index + 1).toString(16).padStart(4, "0")}> <${utf16BeHex(char)}>`)
    .join("\n");
  const content = `BT /F1 12 Tf 72 720 Td <${encoded}> Tj ET`;
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${entries.length} beginbfchar
${cmapEntries}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /TestCID /Encoding /Identity-H /ToUnicode 6 0 R >>",
    `<< /Length ${Buffer.byteLength(cmap, "latin1")} >>\nstream\n${cmap}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function utf16BeHex(value: string): string {
  const utf16 = Buffer.from(value, "utf16le");
  const swapped = Buffer.alloc(utf16.length);
  for (let index = 0; index + 1 < utf16.length; index += 2) {
    swapped[index] = utf16[index + 1]!;
    swapped[index + 1] = utf16[index]!;
  }
  return swapped.toString("hex").toUpperCase();
}

function ontoflowToolSourceFixture(): RuntimeTool<unknown> {
  return {
    name: "mcp_ontoflow_jtbc_call_rdb_sql_api_query",
    description: "Read approved ODS metadata.",
    source: {
      id: "ontoflow-jtbc",
      aliases: ["ontoflow-jtbc"],
      transport: "mcp",
      capabilities: [{
        id: "data_asset.ods_read",
        category: "data_asset",
        producesEvidenceKinds: ["source_summary", "schema_summary", "record_counts"],
        sourceKinds: ["database"],
      }],
    },
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (input) => input,
    execute: async () => ({ source_summary: "fixture ODS metadata" }),
  };
}

function priorResultContinuationResolver(inputMode: "prior_result" | "refresh_sources"): ModelAdapter {
  return {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      if (!request.runId.startsWith("conversation-turn:")) {
        return { content: "seed result completed", finishReason: "stop", toolCalls: [] };
      }
      const refreshSources = inputMode === "refresh_sources";
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: `resolve-${inputMode}`,
          name: "resolve_conversation_turn",
          arguments: {
            mode: "execute",
            relation: "continue_prior",
            inputMode,
            targetGoalCandidateId: "goal_candidate_1",
            ...(refreshSources ? {} : { resultCandidateId: "result_candidate_1" }),
            effectiveGoal: refreshSources
              ? "Refresh the ODS source through ontoflow-jtbc and produce the DDM report."
              : "Use the previously acquired ODS Result from ontoflow-jtbc to produce the DDM report.",
            taskIntent: {
              schema: "agentloop.conversationTaskIntent/v1",
              operation: "create_artifact",
              requiresExecution: true,
              deliverables: [{
                targetId: "ddm-report",
                purpose: "Produce the requested DDM report.",
                expectedArtifactCount: 1,
                action: "create",
                kind: "document",
                format: "md",
                surface: "workspace_artifact",
              }],
            },
            evidenceStrategy: refreshSources ? "source_grounded" : "none",
            sourceBinding: { mode: "none", visibleDirectoryIds: [] },
            userConstraints: refreshSources ? ["Refresh the source data before delivery."] : ["Do not refresh source data."],
          },
        }],
      };
    },
  };
}

class ConversationWriteModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      const task = request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      const match = /^write ([^ ]+) as ([^ ]+)$/.exec(task);
      assert.notEqual(match, null);
      assert.match(request.runtimeContext?.content ?? "", /"workspace":\{"root":".*\/conversations\/[^"]+"/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "write",
          name: "computer_write_file",
          arguments: { path: match![1], content: `${match![2]}\n` },
        }],
      };
    }
    return { content: "file written", finishReason: "stop", toolCalls: [] };
  }
}

class VisibleDirectoryPlanner implements Planner {
  visibleDirectoryCount = 0;
  visibleToolAvailable = false;

  async plan(task: TaskSpec): Promise<PlanProposal> {
    this.visibleDirectoryCount = task.visibleDirectories?.length ?? 0;
    this.visibleToolAvailable = task.availableToolNames.includes("visible_find_files")
      && task.availableToolNames.includes("visible_read_file");
    return {
      goal: "read visible material",
      selectedSkillIds: [],
      steps: [{
        id: "read_visible_material",
        objective: "Find and read market-brief.md from the authorized visible directory.",
        dependencies: [],
        skillIds: [],
        requiredCapabilities: ["visible_directory_read"],
        successCriteria: [{ id: "read", description: "The visible directory file content was read.", source: "planner" }],
      }],
    };
  }
}

class RecordingVisibleDirectoryPlanner implements Planner {
  readonly visibleDirectoryCounts: number[] = [];
  readonly availableToolNameSnapshots: string[][] = [];
  readonly responseOnlyFlags: boolean[] = [];
  lastAvailableToolNames: readonly string[] = [];

  async plan(task: TaskSpec): Promise<PlanProposal> {
    const hasVisibleTools = task.availableToolNames.includes("visible_find_files")
      && task.availableToolNames.includes("visible_read_file");
    const taskUnderstanding = task.canonicalState.intent.understanding;
    const sourceGrounded = taskUnderstanding.evidence.need !== "none";
    this.visibleDirectoryCounts.push(task.visibleDirectories?.length ?? 0);
    this.availableToolNameSnapshots.push([...task.availableToolNames]);
    this.responseOnlyFlags.push(task.responseOnly === true);
    this.lastAvailableToolNames = task.availableToolNames;
    return {
      goal: "record visible directory binding",
      selectedSkillIds: [],
      steps: [{
        id: "record-visible-binding",
        objective: "Record whether visible directory bindings were supplied to this run.",
        dependencies: [],
        skillIds: [],
        role: sourceGrounded ? "fact_acquisition" : "deliver",
        requiredCapabilities: hasVisibleTools ? ["visible_directory_read"] : [],
        ...(taskUnderstanding.deliverables === undefined || taskUnderstanding.deliverables.length === 0
          ? {}
          : { targetIds: taskUnderstanding.deliverables.map((target) => target.targetId) }),
        ...(sourceGrounded && task.visibleDirectories![0] !== undefined ? {
          sourceConstraint: { requiredVisibleDirectoryIds: [task.visibleDirectories![0].id] },
          evidenceContract: { requiredKinds: ["source_summary" as const], caveatPolicy: "mark_unverified_facts" as const },
        } : {}),
        successCriteria: [{
          id: "recorded",
          description: "The visible directory binding count was observed by the planner.",
          source: "planner",
        }],
      }],
    };
  }
}

class VisibleDirectoryReadModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    assert.match(request.runtimeContext?.content ?? "", /"visibleDirectories":\[/);
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "find-visible",
          name: "visible_find_files",
          arguments: { rootId: "visible_dir_1", pattern: "**/market-brief.md" },
        }],
      };
    }
    if (this.calls === 2) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-visible",
          name: "visible_read_file",
          arguments: { rootId: "visible_dir_1", path: "market-brief.md" },
        }],
      };
    }
    return {
      content: "Read market-brief.md: local visible directory evidence.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class UploadedSourcePlanner implements Planner {
  sourceCount = 0;
  readSourceAvailable = false;

  async plan(task: TaskSpec): Promise<PlanProposal> {
    this.sourceCount = task.sources?.length ?? 0;
    this.readSourceAvailable = task.availableToolNames.includes("read_source");
    return {
      goal: "read uploaded source",
      selectedSkillIds: [],
      steps: [{
        id: "read-uploaded-source",
        objective: "Read the uploaded revenue source and summarize the observed rows.",
        dependencies: [],
        skillIds: [],
        requiredCapabilities: ["uploaded_source_read"],
        successCriteria: [{ id: "read-source", description: "The uploaded source chunk was read.", source: "planner" }],
      }],
    };
  }
}

class UploadedSourceReadModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    assert.match(request.runtimeContext?.content ?? "", /"sources":\[/);
    this.calls += 1;
    if (this.calls === 1) {
      const context = request.runtimeContext?.content ?? "";
      const sourceId = /"id":"(src_[a-f0-9]{32})"/.exec(context)?.[1];
      assert.ok(sourceId);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-source",
          name: "read_source",
          arguments: { sourceId, chunkIndex: 0 },
        }],
      };
    }
    return {
      content: "Uploaded source read through read_source.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class UploadedSourceQueryModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      const context = request.runtimeContext?.content ?? "";
      const sourceId = /"id":"(src_[a-f0-9]{32})"/.exec(context)?.[1];
      assert.ok(sourceId);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-source-query",
          name: "read_source",
          arguments: {
            sourceId,
            chunkIndex: 0,
            query: "人工智能 AI 智能化 规划",
            maxChunks: 10,
          },
        }],
      };
    }
    return {
      content: "Uploaded source query matched AI planning evidence.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class NoToolCompletionModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;

  async complete(): Promise<ModelResponse> {
    return { content: "visible directory binding recorded", finishReason: "stop", toolCalls: [] };
  }
}

class ContextAwareConversationIntentModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  intentCalls = 0;
  readonly intentContexts: string[] = [];

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.runId.startsWith("conversation-turn:")) {
      this.intentCalls += 1;
      const context = request.runtimeContext?.content ?? "";
      this.intentContexts.push(context);
      assert.match(context, /agentloop\.conversationTurnContext\/v1/);
      const latest = request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      const mode = latest.includes("分析") || latest.includes("生成") ? "execute" : "reply";
      const usesVisibleData = latest.includes("分析");
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: `intent-${this.intentCalls}`,
          name: "resolve_conversation_turn",
          arguments: {
            mode,
            relation: "new_goal",
            inputMode: "none",
            effectiveGoal: latest,
            taskIntent: {
              schema: "agentloop.conversationTaskIntent/v1",
              operation: latest.includes("生成") ? "create_artifact" : mode === "execute" ? "analysis" : "answer",
              requiresExecution: mode === "execute",
              deliverables: latest.includes("生成")
                ? [{
                  targetId: "requested-html",
                  purpose: "Generate the requested HTML file.",
                  expectedArtifactCount: 1,
                  action: "create",
                  kind: "html",
                  format: "html",
                  surface: "workspace_artifact",
                }]
                : [],
            },
            evidenceStrategy: usesVisibleData ? "bound_visible_sources" : "none",
            sourceBinding: usesVisibleData
              ? { mode: "primary_data", visibleDirectoryIds: ["visible_dir_1"] }
              : { mode: "none", visibleDirectoryIds: [] },
            userConstraints: [],
          },
        }],
      };
    }
    return { content: "conversation intent handled", finishReason: "stop", toolCalls: [] };
  }
}

class GreetingTargetConversationModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.runId.startsWith("conversation-turn:")) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "resolve-greeting",
          name: "resolve_conversation_turn",
          arguments: {
            mode: "reply",
            relation: "new_goal",
            inputMode: "none",
            effectiveGoal: "Greet the user warmly and invite them to state what they need help with.",
            taskIntent: {
              schema: "agentloop.conversationTaskIntent/v1",
              operation: "answer",
              requiresExecution: false,
              deliverables: [{
                targetId: "greeting_reply",
                purpose: "A friendly greeting that asks the user what they need help with.",
                expectedArtifactCount: 1,
                action: "none",
                kind: "none",
                surface: "conversation",
              }],
            },
            evidenceStrategy: "none",
            sourceBinding: { mode: "none", visibleDirectoryIds: [] },
            userConstraints: [],
          },
        }],
      };
    }
    return { content: "你好，有什么可以帮你？", finishReason: "stop", toolCalls: [] };
  }
}

class TimedConversationIntentModel extends ContextAwareConversationIntentModel {
  readonly completeTimeoutMs = 10_000;
  readonly operationTimeoutMs = 90_000;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    return { ...await super.complete(request), providerRequestId: "resolver-provider-request" };
  }
}

class FailingConversationResolverModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  readonly completeTimeoutMs = 10_000;
  readonly operationTimeoutMs = 90_000;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.runId.startsWith("conversation-turn:")) {
      throw new AppError("MODEL_ERROR", "Conversation resolver provider request timed out", 502, {
        providerRequestId: "resolver-provider-failure",
      });
    }
    return { content: "unused", finishReason: "stop", toolCalls: [] };
  }
}

class OverEagerPriorArtifactResolverModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.runId.startsWith("conversation-turn:")) {
      const latest = request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      const mutation = /改得更专业|修改|重新生成/u.test(latest);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "over-eager-resolution",
          name: "resolve_conversation_turn",
          arguments: {
            mode: mutation ? "execute" : "reply",
            relation: "continue_prior",
            inputMode: "none",
            targetGoalCandidateId: "goal_candidate_1",
            effectiveGoal: "重新读取并验收上一轮 PPT，再解释为何生成得快。",
            taskIntent: {
              schema: "agentloop.conversationTaskIntent/v1",
              operation: mutation ? "transform_artifact" : "answer",
              requiresExecution: mutation,
              deliverables: mutation
                ? [{ targetId: "prior-presentation", purpose: "Deliver the professionally revised prior presentation.", expectedArtifactCount: 1, action: "modify", kind: "presentation", format: "pptx", surface: "workspace_artifact" }]
                : [],
            },
            evidenceStrategy: "none",
            sourceBinding: { mode: "none", visibleDirectoryIds: [] },
            userConstraints: ["基于上一轮产物解释"],
          },
        }],
      };
    }
    return {
      content: request.messages.some((message) => /为什么能够这么快|所有的 pptx 制作/u.test(message.content))
        ? "直接解释：这是对话问题，不会重新读取或修改上一轮产物。"
        : "此前交付已经完成。",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class ErroneousSourceStrategyArtifactTransformModel extends ConversationWriteModel {
  override async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (!request.runId.startsWith("conversation-turn:")) return await super.complete(request);
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "erroneous-source-strategy",
        name: "resolve_conversation_turn",
        arguments: {
          mode: "execute",
          relation: "refine_prior",
          inputMode: "prior_artifact",
          targetGoalCandidateId: "goal_candidate_1",
          targetArtifact: { path: "prior.html" },
          effectiveGoal: "将 prior.html 修改为不依赖外部资源的自包含文件。",
          taskIntent: {
            schema: "agentloop.conversationTaskIntent/v1",
            operation: "transform_artifact",
            requiresExecution: true,
            deliverables: [{
              targetId: "self-contained-html",
              purpose: "Make the prior HTML self-contained.",
              expectedArtifactCount: 1,
              action: "modify",
              kind: "html",
              format: "html",
              surface: "workspace_artifact",
            }],
          },
          evidenceStrategy: "source_grounded",
          sourceBinding: { mode: "none", visibleDirectoryIds: [] },
          userConstraints: ["不引用外部资源"],
        },
      }],
    };
  }
}

class ProcessArtifactPollutingResolverModel extends ConversationWriteModel {
  resolverAttempts = 0;
  readonly repairPrompts: string[] = [];

  override async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (!request.runId.startsWith("conversation-turn:")) return await super.complete(request);
    this.resolverAttempts += 1;
    if (this.resolverAttempts > 1) this.repairPrompts.push(request.systemPrompt);
    const polluted = this.resolverAttempts === 1;
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: `terminal-deliverable-resolution-${this.resolverAttempts}`,
        name: "resolve_conversation_turn",
        arguments: {
          mode: "execute",
          relation: "continue_prior",
          inputMode: "prior_artifact",
          targetGoalCandidateId: "goal_candidate_1",
          targetArtifact: { path: "merged_output.pdf" },
          effectiveGoal: "将 merged_output.pdf 平均拆分为 4 份 PDF 子文件并交付。",
          taskIntent: polluted
            ? {
              schema: "agentloop.conversationTaskIntent/v1",
              operation: "transform_artifact",
              requiresExecution: true,
              deliverables: [{
                targetId: "split_pdf_parts",
                purpose: "将合并 PDF 平均拆分为四份 PDF 子文件并交付。",
                expectedArtifactCount: 4,
                action: "transform",
                kind: "document",
                format: "pdf",
                surface: "workspace_artifact",
              }, {
                targetId: "split_pdfs_script",
                purpose: "生成用于执行拆分的 Python 脚本。",
                expectedArtifactCount: 1,
                action: "create" as const,
                kind: "code" as const,
                format: "py",
                surface: "workspace_artifact" as const,
              }],
            }
            : {
              schema: "agentloop.conversationTaskIntent/v1",
              operation: "transform_artifact",
              requiresExecution: true,
              deliverables: [{
                targetId: "prior_artifact_transformation",
                purpose: "将合并 PDF 平均拆分为四份 PDF 子文件并交付。",
                expectedArtifactCount: 4,
                action: "transform",
                kind: "document",
                format: "pdf",
                surface: "workspace_artifact",
              }],
            },
          evidenceStrategy: "none",
          sourceBinding: { mode: "none", visibleDirectoryIds: [] },
          userConstraints: ["现在把合并文件拆分为平均的 4 份"],
        },
      }],
    };
  }
}

class MissingExpectedArtifactCountResolverModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  resolverAttempts = 0;
  readonly repairPrompts: string[] = [];

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (!request.runId.startsWith("conversation-turn:")) {
      return { content: "unused", finishReason: "stop", toolCalls: [] };
    }
    this.resolverAttempts += 1;
    if (this.resolverAttempts > 1) this.repairPrompts.push(request.systemPrompt);
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: `missing-artifact-count-${this.resolverAttempts}`,
        name: "resolve_conversation_turn",
        arguments: {
          mode: "execute",
          relation: "new_goal",
          inputMode: "none",
          effectiveGoal: "生成一个 PDF 文件。",
          taskIntent: {
            schema: "agentloop.conversationTaskIntent/v1",
            operation: "create_artifact",
            requiresExecution: true,
            deliverables: [{
              targetId: "requested-pdf",
              purpose: "生成用户请求的 PDF 文件。",
              ...(this.resolverAttempts === 1 ? {} : { expectedArtifactCount: 1 }),
              action: "create",
              kind: "document",
              format: "pdf",
              surface: "workspace_artifact",
            }],
          },
          evidenceStrategy: "none",
          sourceBinding: { mode: "none", visibleDirectoryIds: [] },
          userConstraints: [],
        },
      }],
    };
  }
}

class InvalidEvidenceStrategyResolverModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  resolverAttempts = 0;
  readonly repairPrompts: string[] = [];

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (!request.runId.startsWith("conversation-turn:")) {
      return { content: "unused", finishReason: "stop", toolCalls: [] };
    }
    this.resolverAttempts += 1;
    if (this.resolverAttempts > 1) this.repairPrompts.push(request.systemPrompt);
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: `invalid-evidence-strategy-${this.resolverAttempts}`,
        name: "resolve_conversation_turn",
        arguments: {
          mode: "execute",
          relation: "new_goal",
          inputMode: "none",
          effectiveGoal: "生成一个 PDF 文件。",
          taskIntent: {
            schema: "agentloop.conversationTaskIntent/v1",
            operation: "create_artifact",
            requiresExecution: true,
            deliverables: [{
              targetId: "requested-pdf",
              purpose: "生成用户请求的 PDF 文件。",
              expectedArtifactCount: 1,
              action: "create",
              kind: "document",
              format: "pdf",
              surface: "workspace_artifact",
            }],
          },
          evidenceStrategy: this.resolverAttempts === 1 ? "unsupported" : "none",
          sourceBinding: { mode: "none", visibleDirectoryIds: [] },
          userConstraints: [],
        },
      }],
    };
  }
}

class InventedNewGoalCandidateResolverModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  resolverAttempts = 0;
  readonly repairPrompts: string[] = [];
  firstSchemaHadTargetGoalCandidateId = false;
  firstSchemaHadTargetArtifact = false;
  firstRelationEnum: readonly unknown[] = [];
  firstVisibleDirectoryIdEnum: readonly unknown[] = [];
  firstRuntimeContext = "";

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (!request.runId.startsWith("conversation-turn:")) {
      return { content: "unused", finishReason: "stop", toolCalls: [] };
    }
    this.resolverAttempts += 1;
    if (this.resolverAttempts === 1) {
      const schema = request.tools[0]?.inputSchema as { readonly properties?: Readonly<Record<string, unknown>> };
      const properties = schema.properties ?? {};
      this.firstSchemaHadTargetGoalCandidateId = properties.targetGoalCandidateId !== undefined;
      this.firstSchemaHadTargetArtifact = properties.targetArtifact !== undefined;
      this.firstRelationEnum = (properties.relation as { readonly enum?: readonly unknown[] } | undefined)?.enum ?? [];
      const sourceBinding = properties.sourceBinding as { readonly properties?: Readonly<Record<string, unknown>> } | undefined;
      const visibleDirectoryIds = sourceBinding?.properties?.visibleDirectoryIds as { readonly items?: { readonly enum?: readonly unknown[] } } | undefined;
      this.firstVisibleDirectoryIdEnum = visibleDirectoryIds?.items?.enum ?? [];
      this.firstRuntimeContext = request.runtimeContext?.content ?? "";
    } else {
      this.repairPrompts.push(request.systemPrompt);
    }
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: `invented-new-goal-candidate-${this.resolverAttempts}`,
        name: "resolve_conversation_turn",
        arguments: {
          mode: "execute",
          relation: "new_goal",
          inputMode: "none",
          ...(this.resolverAttempts === 1
            ? {
                targetGoalCandidateId: "goal_candidate_1",
                targetArtifact: { path: "/workspace/game-crowdfunding.pptx" },
              }
            : {}),
          effectiveGoal: "根据当前材料生成一个用于众筹介绍的 PPTX。",
          taskIntent: {
            schema: "agentloop.conversationTaskIntent/v1",
            operation: "create_artifact",
            requiresExecution: true,
            deliverables: [{
              targetId: "crowdfunding-presentation",
              purpose: "交付用于游戏众筹介绍的演示文稿。",
              expectedArtifactCount: 1,
              action: "create",
              kind: "presentation",
              format: "pptx",
              surface: "workspace_artifact",
            }],
          },
          evidenceStrategy: "none",
          sourceBinding: { mode: "none", visibleDirectoryIds: [] },
          userConstraints: ["用于游戏众筹介绍"],
        },
      }],
    };
  }
}

class PriorArtifactLineageDriftModel extends ConversationWriteModel {
  override async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (!request.runId.startsWith("conversation-turn:")) return await super.complete(request);
    const schema = request.tools[0]?.inputSchema as { readonly properties?: Readonly<Record<string, unknown>> };
    const properties = schema.properties ?? {};
    assert.deepEqual(
      (properties.targetGoalCandidateId as { readonly enum?: readonly unknown[] } | undefined)?.enum,
      ["goal_candidate_1"],
    );
    const targetArtifact = properties.targetArtifact as { readonly properties?: Readonly<Record<string, unknown>> } | undefined;
    assert.deepEqual(
      (targetArtifact?.properties?.path as { readonly enum?: readonly unknown[] } | undefined)?.enum,
      ["merged_output.pdf"],
    );
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: "prior-artifact-lineage-drift",
        name: "resolve_conversation_turn",
        arguments: {
          mode: "execute",
          relation: "new_goal",
          inputMode: "none",
          targetArtifact: { path: "merged_output.pdf" },
          effectiveGoal: "将 merged_output.pdf 平均拆分为 4 份 PDF 子文件并交付。",
          taskIntent: {
            schema: "agentloop.conversationTaskIntent/v1",
            operation: "transform_artifact",
            requiresExecution: true,
            deliverables: [{
              targetId: "split_pdf_parts",
              purpose: "将合并 PDF 平均拆分为四份 PDF 子文件并交付。",
              expectedArtifactCount: 4,
              action: "transform",
              kind: "document",
              format: "pdf",
              surface: "workspace_artifact",
            }],
          },
          evidenceStrategy: "none",
          sourceBinding: { mode: "none", visibleDirectoryIds: [] },
          userConstraints: [],
        },
      }],
    };
  }
}

class AlwaysMalformedPriorArtifactResolverModel extends ConversationWriteModel {
  resolverAttempts = 0;

  override async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (!request.runId.startsWith("conversation-turn:")) return await super.complete(request);
    this.resolverAttempts += 1;
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{
        id: `malformed-prior-artifact-${this.resolverAttempts}`,
        name: "resolve_conversation_turn",
        arguments: {
          mode: "execute",
          relation: "refine_prior",
          inputMode: "prior_artifact",
          targetGoalCandidateId: "goal_candidate_1",
          targetArtifact: { path: "merged_output.pdf" },
          effectiveGoal: "将 merged_output.pdf 平均拆分为 4 份 PDF 子文件并交付。",
          taskIntent: {
            schema: "agentloop.conversationTaskIntent/v1",
            operation: "transform_artifact",
            requiresExecution: true,
            deliverables: [{
              targetId: "split_pdf_parts",
              purpose: "将合并 PDF 平均拆分为四份 PDF 子文件并交付。",
              action: "transform",
              kind: "document",
              format: "pdf",
              surface: "workspace_artifact",
            }],
          },
          evidenceStrategy: "none",
          sourceBinding: { mode: "none", visibleDirectoryIds: [] },
          userConstraints: [],
        },
      }],
    };
  }
}
