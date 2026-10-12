import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalModelStreamCaptureStore } from "../local-agent-runtime/src/persistence/model-stream-capture-store.ts";

test("Local Agent stores anomalous raw model SSE outside the workspace with private permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentloop-model-stream-"));
  try {
    const store = new LocalModelStreamCaptureStore(root);
    const raw = Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    const reference = await store.capture({
      schema: "agentloop.modelStreamRawCapture/v1",
      runId: "run/unsafe-segment",
      request: {
        protocol: "chat-completions",
        model: "deepseek-v4-flash",
        phase: "execution",
        stream: true,
        canonicalMessageCount: 46,
        providerMessageCount: 47,
        toolCount: 41,
        toolChoice: "auto",
        runtimeContextPlacement: "system",
      },
      response: {
        status: 200,
        contentType: "text/event-stream",
        providerRequestId: "provider-request-1",
      },
      anomalyReasons: ["empty_stop_completion"],
      rawSse: raw,
      rawBytes: raw.byteLength,
      rawSha256: "a".repeat(64),
      truncated: false,
    });

    assert.match(reference.ref, /^local-model-stream-capture:run_unsafe-segment\//);
    const runRoot = join(root, "run_unsafe-segment");
    const files = await readdir(runRoot);
    const rawName = files.find((file) => file.endsWith(".sse"));
    const metadataName = files.find((file) => file.endsWith(".json"));
    assert.ok(rawName);
    assert.ok(metadataName);
    assert.deepEqual(await readFile(join(runRoot, rawName)), raw);
    const metadata = JSON.parse(await readFile(join(runRoot, metadataName), "utf8")) as Record<string, unknown>;
    assert.equal(metadata.runId, "run/unsafe-segment");
    assert.equal(JSON.stringify(metadata).includes("authorization"), false);
    if (process.platform !== "win32") {
      assert.equal((await stat(join(runRoot, rawName))).mode & 0o777, 0o600);
      assert.equal((await stat(join(runRoot, metadataName))).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
