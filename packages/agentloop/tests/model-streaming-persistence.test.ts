import assert from "node:assert/strict";
import test from "node:test";
import type { ModelAdapter } from "../src/runtime/contracts.ts";
import { completeWithStreaming } from "../src/runtime/model-streaming.ts";

test("slow durable stream snapshots do not block provider consumption and coalesce pending state", async () => {
  let releaseFirstSnapshot!: () => void;
  const firstSnapshotBlocked = new Promise<void>((resolve) => { releaseFirstSnapshot = resolve; });
  let providerFinished = false;
  const persisted: string[] = [];
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
    complete: async () => ({ content: "abc", finishReason: "stop", toolCalls: [] }),
    streamComplete: async (_invocation, emit) => {
      await emit({ type: "text_delta", text: "a" });
      await emit({ type: "text_delta", text: "b" });
      await emit({ type: "text_delta", text: "c" });
      providerFinished = true;
      return { content: "abc", finishReason: "stop", toolCalls: [] };
    },
  };
  const completion = completeWithStreaming({
    model,
    invocation: { runId: "slow-stream-store", systemPrompt: "System", phase: "execution", messages: [], tools: [] },
    streamFlushIntervalMs: 0,
    emit: async (event) => {
      if (event.type !== "assistant.streaming") return;
      persisted.push(String(event.data.content));
      if (persisted.length === 1) await firstSnapshotBlocked;
    },
    base: { phase: "execution", step: 1 },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(providerFinished, true, "provider deltas must not wait for the slow TiDB snapshot write");
  assert.deepEqual(persisted, ["a"]);
  releaseFirstSnapshot();
  const response = await completion;
  assert.equal(response.content, "abc");
  assert.deepEqual(persisted, ["a", "abc"], "only the latest pending cumulative snapshot is retained");
});
