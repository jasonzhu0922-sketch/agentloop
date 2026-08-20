import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthService } from "../src/auth/auth-service.ts";
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
