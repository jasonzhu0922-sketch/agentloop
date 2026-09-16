import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AppDatabase } from "../src/storage/database.ts";
import { RunRepository } from "../src/storage/repositories/run-repository.ts";
import { SqlToolResultStore } from "../src/storage/repositories/tool-result-store.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { createToolResultReader } from "../src/tools/tool-result-reader.ts";
import type { ToolResultStore } from "../src/storage/repositories/tool-result-store.ts";

test("SqlToolResultStore persists complete content behind an opaque bounded locator", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await insertRun(database, "run-1", "user-1");
    const store = new SqlToolResultStore(database);
    const content = `HEAD:${"x".repeat(2_000)}:TAIL`;
    const ref = await store.put({
      ownerUserId: "user-1",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "large_tool",
      content,
      createdAt: 100,
    });

    assert.match(ref.locator, /^tool-result:\/\/[0-9a-f-]+$/);
    assert.equal(ref.characters, content.length);
    assert.equal(ref.sha256.length, 64);
    assert.doesNotMatch(ref.locator, /Users|workspace|\.agentloop/);

    const window = await store.read({
      ownerUserId: "user-1",
      runId: "run-1",
      locator: ref.locator,
      offset: content.length - 5,
      limit: 5,
      expectedSha256: ref.sha256,
    });
    assert.equal(window.content, ":TAIL");
    assert.equal(window.truncated, true);
    assert.equal(window.nextOffset, undefined);
  } finally {
    await database.close();
  }
});

test("SqlToolResultStore is idempotent per Run ToolCall and rejects changed content", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await insertRun(database, "run-1", "user-1");
    const store = new SqlToolResultStore(database);
    const input = {
      ownerUserId: "user-1",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "large_tool",
      content: "complete result",
      createdAt: 100,
    } as const;
    const first = await store.put(input);
    const second = await store.put({ ...input, createdAt: 200 });

    assert.deepEqual(second, first);
    await assert.rejects(
      () => store.put({ ...input, content: "different result", createdAt: 300 }),
      /different content/,
    );
  } finally {
    await database.close();
  }
});

test("SqlToolResultStore rejects corrupted length metadata instead of trusting a PostgreSQL BIGINT value", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await insertRun(database, "run-1", "user-1");
    const store = new SqlToolResultStore(database);
    const ref = await store.put({
      ownerUserId: "user-1",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "large_tool",
      content: "complete result",
      createdAt: Date.now(),
    });
    await database.prepare("UPDATE tool_result_blobs SET characters = ? WHERE locator = ?").run(999, ref.locator);
    await assert.rejects(
      () => store.read({ ownerUserId: "user-1", runId: "run-1", locator: ref.locator, offset: 0, limit: 10 }),
      /integrity check/,
    );
  } finally {
    await database.close();
  }
});

test("SqlToolResultStore returns not-found across owner and Run boundaries", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await insertRun(database, "run-1", "user-1");
    await insertRun(database, "run-2", "user-2");
    const store = new SqlToolResultStore(database);
    await assert.rejects(
      () => store.put({
        ownerUserId: "user-2",
        runId: "run-1",
        toolCallId: "foreign-call",
        toolName: "large_tool",
        content: "must not persist",
        createdAt: 99,
      }),
      /Run not found/,
    );
    const ref = await store.put({
      ownerUserId: "user-1",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "large_tool",
      content: "secret content",
      createdAt: 100,
    });

    await assert.rejects(
      () => store.read({ ownerUserId: "user-2", runId: "run-1", locator: ref.locator, offset: 0, limit: 20 }),
      /Tool result not found/,
    );
    await assert.rejects(
      () => store.read({ ownerUserId: "user-1", runId: "run-2", locator: ref.locator, offset: 0, limit: 20 }),
      /Tool result not found/,
    );
    await assert.rejects(
      () => store.read({
        ownerUserId: "user-1",
        runId: "run-1",
        locator: ref.locator,
        offset: 0,
        limit: 20,
        expectedSha256: "0".repeat(64),
      }),
      /hash does not match/,
    );
  } finally {
    await database.close();
  }
});

test("read_tool_result revalidates the current Run grant and returns a bounded window", async () => {
  const database = new AppDatabase(":memory:");
  try {
    await insertRun(database, "run-1", "user-1");
    const store = new SqlToolResultStore(database);
    const ref = await store.put({
      ownerUserId: "user-1",
      runId: "run-1",
      toolCallId: "original-call",
      toolName: "large_tool",
      content: "0123456789",
      createdAt: 100,
    });
    const tool = createToolResultReader(store);
    const input = tool.parse({ locator: ref.locator, sha256: ref.sha256, offset: 3, limit: 4 });
    const result = await tool.execute({
      grant: createCapabilityGrant({
        actorUserId: "user-1",
        runId: "run-1",
        depth: 0,
        allowedToolNames: [tool.name],
        allowedSkillIds: [],
      }),
    }, input) as Record<string, unknown>;

    assert.equal(result.schema, "agentloop.toolResultWindow/v1");
    assert.equal(result.content, "3456");
    assert.equal(result.nextOffset, 7);
    assert.equal(result.toolCallId, "original-call");
  } finally {
    await database.close();
  }
});

test("read_tool_result accepts a host object-store locator without assuming the SQL locator format", async () => {
  const content = "complete object storage result";
  const sha256 = createHash("sha256").update(content).digest("hex");
  const locator = "object-store:v1:abc123";
  const store: ToolResultStore = {
    async put() {
      return { locator, sha256, characters: content.length };
    },
    async findByToolCall() {
      return undefined;
    },
    async read(input) {
      assert.equal(input.locator, locator);
      assert.equal(input.ownerUserId, "user-1");
      assert.equal(input.runId, "run-1");
      assert.equal(input.expectedSha256, sha256);
      return {
        locator,
        sha256,
        characters: content.length,
        toolCallId: "object-call",
        toolName: "object_tool",
        offset: input.offset,
        content: content.slice(input.offset, input.offset + input.limit),
        truncated: false,
      };
    },
  };
  const tool = createToolResultReader(store);
  const input = tool.parse({ locator, sha256, offset: 0, limit: 100 });
  const result = await tool.execute({
    grant: createCapabilityGrant({
      actorUserId: "user-1",
      runId: "run-1",
      depth: 0,
      allowedToolNames: [tool.name],
      allowedSkillIds: [],
    }),
  }, input) as Record<string, unknown>;

  assert.equal(result.locator, locator);
  assert.equal(result.content, content);
});

async function insertRun(database: AppDatabase, runId: string, ownerUserId: string): Promise<void> {
  await new RunRepository(database).insertRun({
    id: runId,
    ownerUserId,
    allowDangerousTools: true,
    input: "test",
    createdAt: 1,
  });
}
