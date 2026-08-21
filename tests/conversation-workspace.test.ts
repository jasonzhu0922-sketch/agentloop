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
        requiredToolNames: ["visible_find_files", "visible_read_file"],
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
        requiredToolNames: hasVisibleTools ? ["visible_find_files"] : [],
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

class NoToolCompletionModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;

  async complete(): Promise<ModelResponse> {
    return { content: "visible directory binding recorded", finishReason: "stop", toolCalls: [] };
  }
}
