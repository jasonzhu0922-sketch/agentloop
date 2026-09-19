import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { AppError } from "../src/shared/errors.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { ConversationResultRepository } from "../src/storage/repositories/conversation-result-repository.ts";
import { createConversationResultTool } from "../src/tools/conversation-result-tool.ts";

test("read_conversation_result reads only a hashed completed Outcome in the same conversation", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const owner = "user-result-reader";
    const conversationId = "conversation-result-reader";
    const otherConversationId = "conversation-result-other";
    const output = "accepted semantic outcome ".repeat(1_000);
    const sha256 = createHash("sha256").update(output).digest("hex");
    const now = Date.now();
    await database.prepare(`INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(conversationId, owner, "Result reader", now, now);
    await database.prepare(`INSERT INTO conversations(id, owner_user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(otherConversationId, owner, "Other result reader", now, now);
    await insertRunOutcome(database, { runId: "completed-result", owner, conversationId, status: "completed", output, now });
    await insertRunOutcome(database, { runId: "failed-result", owner, conversationId, status: "failed", output, now });
    await insertRunOutcome(database, { runId: "other-conversation-result", owner, conversationId: otherConversationId, status: "completed", output, now });

    const tool = createConversationResultTool(new ConversationResultRepository(database));
    const grant = createCapabilityGrant({
      actorUserId: owner,
      runId: "current-run",
      conversationId,
      depth: 0,
      allowedToolNames: [tool.name],
      allowedSkillIds: [],
    });
    const read = await tool.execute({ grant }, tool.parse({
      runId: "completed-result", sha256, offset: 12, maxCharacters: 55,
    })) as { content: string; returnedCharacters: number; hasMore: boolean };
    assert.equal(read.content, output.slice(12, 67));
    assert.equal(read.returnedCharacters, 55);
    assert.equal(read.hasMore, true);

    for (const input of [
      { runId: "completed-result", sha256: "0".repeat(64) },
      { runId: "failed-result", sha256 },
      { runId: "other-conversation-result", sha256 },
    ]) {
      await assert.rejects(
        () => tool.execute({ grant }, tool.parse(input)),
        (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
      );
    }
  } finally {
    database.close();
  }
});

async function insertRunOutcome(
  database: AppDatabase,
  input: { runId: string; owner: string; conversationId: string; status: "completed" | "failed"; output: string; now: number },
): Promise<void> {
  await database.prepare(`
    INSERT INTO runs(id, owner_user_id, conversation_id, parent_run_id, depth, allow_dangerous_tools, model_key, status, input, output, error_code, created_at, finished_at)
    VALUES (?, ?, ?, NULL, 0, 0, NULL, ?, 'prior input', ?, NULL, ?, ?)
  `).run(input.runId, input.owner, input.conversationId, input.status, input.output, input.now, input.now);
  await database.prepare(`
    INSERT INTO run_outcomes(run_id, plan_id, status, output, reason_code, committed_at)
    VALUES (?, NULL, ?, ?, 'test', ?)
  `).run(input.runId, input.status, input.output, input.now);
}
