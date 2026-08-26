import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
import type { PlanProposal, Planner, TaskSpec } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("Computer Tool writes are isolated by conversation and reused by follow-up runs", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-conversation-workspace-"));
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("conversation-workspace@example.com", "workspace secure password");
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
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Run visible directories are exposed as read-only planning and execution capability", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-workspace-"));
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-materials-"));
  const database = new AppDatabase(":memory:");
  try {
    await fs.writeFile(join(visible, "market-brief.md"), "Quarterly signal: local visible directory evidence.\n");
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("visible-directory@example.com", "visible secure password");
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
    const started = runs.events(owner.user.id, run.id).find((event) => event.type === "run.started");
    assert.equal(Array.isArray(started?.data.visibleDirectories), true);
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(visible, { recursive: true, force: true });
  }
});

test("Conversation visible directories persist across follow-up runs until explicitly cleared", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-bound-visible-workspace-"));
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-bound-visible-materials-"));
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("bound-visible-directory@example.com", "bound visible secure password");
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
    assert.deepEqual(runs.getConversation(owner.user.id, first.conversationId).conversation.visibleDirectories, [
      await fs.realpath(visible),
    ]);

    await runs.updateConversationVisibleDirectories(owner.user.id, first.conversationId, []);
    await runs.execute(owner.user.id, "after user removed visible directory", {
      allowDangerousTools: true,
      conversationId: first.conversationId,
    });
    assert.deepEqual(planner.visibleDirectoryCounts, [1, 1, 0]);
    assert.deepEqual(runs.getConversation(owner.user.id, first.conversationId).conversation.visibleDirectories, []);
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(visible, { recursive: true, force: true });
  }
});

test("Uploaded sources are bound to a run and read through source tools", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-upload-source-workspace-"));
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("uploaded-source@example.com", "uploaded source secure password");
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
    assert.match(run.output ?? "", /read_source/);
    assert.equal(planner.sourceCount, 1);
    assert.equal(planner.readSourceAvailable, true);
    const started = runs.events(owner.user.id, run.id).find((event) => event.type === "run.started");
    assert.equal(Array.isArray(started?.data.sources), true);
    const sourceRead = runs.events(owner.user.id, run.id).find((event) =>
      event.type === "tool.completed" && event.data.toolName === "read_source"
    );
    assert.match(String(sourceRead?.data.result ?? ""), /North,120/);
    assert.equal(runs.source(owner.user.id, source.id).chunkCount, 1);
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Uploaded source query matches separated search terms instead of one literal phrase", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-upload-source-query-"));
  const database = new AppDatabase(":memory:");
  try {
    const auth = new AuthService(database);
    const skills = new SkillService(database);
    const owner = await auth.register("uploaded-source-query@example.com", "uploaded source query secure password");
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
    const sourceRead = runs.events(owner.user.id, run.id).find((event) =>
      event.type === "tool.completed" && event.data.toolName === "read_source"
    );
    assert.match(String(sourceRead?.data.result ?? ""), /利用AI进行风险预警/);
  } finally {
    database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

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
        recommendedToolNames: ["visible_find_files", "visible_read_file"],
        successCriteria: [{ id: "read", description: "The visible directory file content was read.", source: "planner" }],
      }],
    };
  }
}

class RecordingVisibleDirectoryPlanner implements Planner {
  readonly visibleDirectoryCounts: number[] = [];

  async plan(task: TaskSpec): Promise<PlanProposal> {
    const hasVisibleTools = task.availableToolNames.includes("visible_find_files")
      && task.availableToolNames.includes("visible_read_file");
    this.visibleDirectoryCounts.push(task.visibleDirectories?.length ?? 0);
    return {
      goal: "record visible directory binding",
      selectedSkillIds: [],
      steps: [{
        id: "record-visible-binding",
        objective: "Record whether visible directory bindings were supplied to this run.",
        dependencies: [],
        skillIds: [],
        recommendedToolNames: hasVisibleTools ? ["visible_find_files"] : [],
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
        recommendedToolNames: ["read_source"],
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
