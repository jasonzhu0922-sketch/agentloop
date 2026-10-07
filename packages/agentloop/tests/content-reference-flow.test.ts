import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputerExecutor } from "../src/computer/computer-executor.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ContextAssembler } from "../src/runtime/context-assembler.ts";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import type { ModelMessage, RuntimeEvent } from "../src/runtime/contracts.ts";
import { RuntimeToolArgumentsQueryService } from "../src/runtime/runtime-tool-arguments-query-service.ts";
import { ToolArgumentsReferenceStore } from "../src/runtime/tool-arguments-reference-store.ts";
import { createComputerTools } from "../src/tools/computer-tools.ts";
import { createWebTools } from "../src/tools/web-tools.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";

function assembler(events: RuntimeEvent[] = []) {
  const context = new ContextAssembler({
    runId: "references", systemPrompt: "Use summaries and read references on demand.",
    runtimeContext: { phase: "execution", content: "Complete the requested collection." },
    model: { limits: { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
      complete: async () => { throw new Error("Unexpected compaction"); } },
    emit: async (event) => { events.push(event); },
  });
  context.setPromptProjectionPolicy({ schema: "agentloop.promptProjectionPolicy/v1", policyId: "test", instruction: "", mode: "action_aware", largeToolResultProjectionCharacters: 2048, largeToolResultPreviewCharacters: 800 });
  return context;
}

function append(messages: ModelMessage[], name: string, args: Record<string, unknown>, result: unknown) {
  const id = String(messages.length);
  messages.push({ role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] },
    { role: "tool", name, toolCallId: id, content: JSON.stringify(result), isError: false });
}

function projected(messages: readonly ModelMessage[], name: string) {
  const text = messages.findLast((message) => message.role === "tool" && message.name === name)?.content;
  assert.ok(text);
  return JSON.parse(text.split("\n\n[")[0]);
}

test("web snapshot -> projected ref -> exact read -> consumed summary -> restored ref without refetch", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "reference-flow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const items = Array.from({ length: 10 }, (_, index) => ({ id: index, text: `record-${index}: ` + "详细内容 <tag> &amp; ".repeat(60) }));
  const source = JSON.stringify({ items, page: { count: 10 } });
  assert.ok(source.length > 8000 && source.length < 12000);
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches += 1;
    const response = new Response(source, { headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: "https://example.com/records" });
    return response;
  });
  const executor = new ComputerExecutor(root);
  const tools = [...createWebTools(), ...createComputerTools(executor)];
  const grant = createCapabilityGrant({ actorUserId: "test", runId: "references", depth: 0, workspaceRoot: root,
    allowedToolNames: tools.map((tool) => tool.name), allowedSkillIds: [] });
  const registry = new ToolRegistry(tools).materialize(grant);
  const execute = async (name: string, args: Record<string, unknown>) => {
    const prepared = registry.prepare({ id: name, name, arguments: args });
    return await prepared.tool.execute({ grant }, prepared.input) as Record<string, any>;
  };
  const web = await execute("webfetch", { url: "https://example.com/records" });
  assert.equal(web.content, source, "JSON values must not go through HTML conversion");
  assert.equal(await fs.readFile(join(root, web.contentLocation.path), "utf8"), source);
  assert.equal(web.contentLocation.sha256, createHash("sha256").update(source).digest("hex"));
  const messages: ModelMessage[] = [];
  append(messages, "webfetch", { url: web.url }, web);
  const context = assembler();
  const initial = projected((await context.assemble(messages, [])).messages, "webfetch");
  assert.deepEqual(initial.contentLocation, web.contentLocation);
  assert.equal(initial.contentSummary.properties.items.count, 10);
  assert.equal(initial.content, undefined);
  assert.match(initial.instruction, /Runtime computes the content digest/);

  const args = { path: initial.contentLocation.path, characterOffset: 0, characterLimit: 12000 };
  const read = await execute("computer_read_file", args);
  append(messages, "computer_read_file", args, read);
  const fresh = projected((await context.assemble(messages, [])).messages, "computer_read_file");
  assert.equal(fresh.content, source, "The requested window must reach the next model turn intact despite 2048/800 policy");
  assert.equal(fresh.nextCharacterOffset, null);
  assert.equal(JSON.parse(fresh.content).items[9].id, 9);
  assert.equal(projected((await assembler().assemble(messages, [])).messages, "computer_read_file").content, source,
    "Recovery must also preserve an unconsumed read");

  append(messages, "computer_find_files", { pattern: "*.json" }, { matches: [] });
  for (const instance of [context, assembler()]) {
    const retained = projected((await instance.assemble(messages, [])).messages, "computer_read_file");
    assert.equal(retained.content, source,
      "A complete source below the shared 12000-character window remains usable after an intervening tool call");
    assert.equal(retained.contentLocation.sha256, web.contentLocation.sha256);
  }
  assert.equal(fetches, 1);

  const jsonArgs = { path: args.path, queries: [{ pointer: "/items", offset: 8, limit: 2 }] };
  const jsonRead = await execute("computer_read_json", jsonArgs);
  append(messages, "computer_read_json", jsonArgs, jsonRead);
  const selected = projected((await context.assemble(messages, [])).messages, "computer_read_json");
  assert.equal(selected.queries[0].value[1].id, 9);
  assert.equal(selected.queries[0].totalItems, 10);
});

test("ContextAssembler retains non-overlapping windows and exposes neutral coverage for a small content reference", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "reference-coverage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = "record\n".repeat(1_500);
  assert.ok(source.length < 12_000);
  const executor = new ComputerExecutor(root);
  const reference = await executor.storeContentReference(source);
  const first = await executor.readContentReference(reference.path, 0, 4_000);
  const second = await executor.readContentReference(reference.path, 4_000, 12_000);
  const messages: ModelMessage[] = [];
  append(messages, "computer_read_file", { path: reference.path, characterOffset: 0, characterLimit: 4_000 }, first);
  append(messages, "computer_find_files", { pattern: "*.txt" }, { matches: [] });
  append(messages, "computer_read_file", { path: reference.path, characterOffset: 4_000, characterLimit: 12_000 }, second);
  const assembly = await assembler().assemble(messages, []);
  const reads = assembly.messages.filter((message): message is Extract<ModelMessage, { role: "tool" }> =>
    message.role === "tool" && message.name === "computer_read_file",
  ).map((message) => JSON.parse(message.content) as { content?: string; characterOffset: number });
  assert.deepEqual(reads.map((read) => read.characterOffset), [0, 4_000]);
  assert.equal(reads.map((read) => read.content ?? "").join(""), source);
  const coverageMatch = assembly.runtimeContext.content.match(/<runtime_result_context source="server">\n([\s\S]+?)\n<\/runtime_result_context>/);
  assert.ok(coverageMatch);
  const context = JSON.parse(coverageMatch[1]) as {
    contentReferenceCoverage: Array<{
      path: string;
      characters: number;
      coveredCharacterRanges: Array<{ start: number; end: number }>;
      complete: boolean;
    }>;
    readProtocol: string;
  };
  assert.deepEqual(context.contentReferenceCoverage, [{
    path: reference.path,
    sha256: reference.sha256,
    characters: source.length,
    coveredCharacterRanges: [{ start: 0, end: source.length }],
    complete: true,
  }]);
  assert.match(context.readProtocol, /not read_result/);
  assert.match(context.readProtocol, /12000/);
});

test("command refs survive 2048/800 projection for both small and large stdout/stderr", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "command-ref-flow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executor = new ComputerExecutor(root);
  for (const size of [3000, 9448]) {
    const result = await executor.runCommand({ command: "node", cwd: ".", args: ["-e", `process.stdout.write('x'.repeat(${size})); process.stderr.write('y'.repeat(2500))`], timeoutMs: 5000 });
    const messages: ModelMessage[] = [];
    append(messages, "computer_run_command", {}, result);
    const view = projected((await assembler().assemble(messages, [])).messages, "computer_run_command");
    assert.equal(view.outputReferences.stdout.path, result.stdoutRef?.path);
    assert.equal(view.outputReferences.stderr.path, result.stderrRef?.path);
    assert.equal(view.exitCode, 0);
    for (const [stream, count] of [["stdout", size], ["stderr", 2500]] as const) {
      const ref = view.outputReferences[stream];
      const read = await executor.readContentReference(ref.path, 0, 12000);
      assert.equal(read.content.length, count);
      assert.equal(read.complete, true);
    }
  }
});

test("durable tool-argument references restore through the same store used by query and recovery", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "tool-arguments-reference-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ToolArgumentsReferenceStore(root);
  const original = { command: "node", script: "console.log('evidence');\n".repeat(1200) };
  const projected = store.project(original);
  assert.ok(projected.argumentsRef, "large arguments must be stored outside the durable event payload");

  const events = [{
    type: "assistant.committed",
    data: { toolCalls: [{ id: "call-large", name: "computer_run_command", arguments: projected.arguments, argumentsRef: projected.argumentsRef }] },
  }];
  const queries = new RuntimeToolArgumentsQueryService({
    run: async () => ({ ownerUserId: "user", conversationId: "conversation" }),
    events: async () => events,
    store: () => store,
  });
  const content = await queries.read("user", "run", "call-large");
  assert.deepEqual(content.arguments, original);
  assert.equal(content.path, projected.argumentsRef.path);

  const inlineQueries = new RuntimeToolArgumentsQueryService({
    run: async () => ({ ownerUserId: "user" }),
    events: async () => [{ type: "tool.planned", data: { toolCallId: "call-inline", arguments: { cwd: ".", command: "node" } } }],
    store: () => store,
  });
  assert.deepEqual((await inlineQueries.read("user", "run", "call-inline")).arguments, { cwd: ".", command: "node" });

  const restored = await store.resolveEventData({ toolCallId: "call-large", argumentsRef: projected.argumentsRef });
  assert.deepEqual(restored.arguments, original);
});

test("tool-argument references reject tampering and paths outside the Runtime-owned store", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "tool-arguments-integrity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ToolArgumentsReferenceStore(root);
  const projected = store.project({ payload: "integrity ".repeat(1200) });
  assert.ok(projected.argumentsRef);
  await fs.writeFile(join(root, projected.argumentsRef.path), "{\"payload\":\"changed\"}");
  await assert.rejects(store.read("call-tampered", projected.argumentsRef), /Tool arguments/);
  await assert.rejects(store.read("call-outside", {
    schema: "agentloop.toolArgumentsReference/v1",
    path: "../outside.json",
  }), /Tool arguments/);
});

test("reference windows page exactly, report Runtime-owned digests, and reject invalid ranges and root escape", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "reference-range-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executor = new ComputerExecutor(root);
  const content = "中文🙂\n".repeat(4000);
  const ref = await executor.storeContentReference(content);
  assert.deepEqual(await executor.storeContentReference(content), ref);
  let recovered = "";
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await executor.readContentReference(ref.path, offset, 317);
    recovered += page.content;
    offset = page.nextCharacterOffset;
  }
  assert.equal(recovered, content);
  await assert.rejects(executor.readContentReference(ref.path, 0, 12001), /Invalid.*window/);
  await assert.rejects(executor.readContentReference(ref.path, content.length + 1, 100), /exceeds/);
  await assert.rejects(executor.readContentReference("../outside.txt", 0, 100));
  await fs.writeFile(join(root, ref.path), "changed");
  const changed = await executor.readContentReference(ref.path, 0, 100);
  assert.equal(changed.content, "changed");
  assert.equal(changed.contentLocation.sha256, createHash("sha256").update("changed").digest("hex"));
});

test("oversized web tool serialization retains a readable ref through the agent loop", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "reference-loop-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = JSON.stringify({ records: Array.from({ length: 200 }, (_, id) => ({ id, text: "fact ".repeat(180) })) });
  assert.ok(source.length > 120_000);
  t.mock.method(globalThis, "fetch", async () => {
    const response = new Response(source, { headers: { "content-type": "application/json" } });
    Object.defineProperty(response, "url", { value: "https://example.com/large" });
    return response;
  });
  const tools = [...createWebTools(), ...createComputerTools(new ComputerExecutor(root))];
  let calls = 0;
  const result = await runAgentLoop({
    runId: "large-ref", input: "Read the final record", systemPrompt: "Read from references.",
    tools: new ToolRegistry(tools), availableSkills: [], maxSteps: 4,
    grant: createCapabilityGrant({ actorUserId: "test", runId: "large-ref", depth: 0, workspaceRoot: root,
      allowedToolNames: ["webfetch", "computer_read_json"], allowedSkillIds: [] }),
    contextPolicy: { largeToolResultProjectionCharacters: 2048, largeToolResultPreviewCharacters: 800 },
    model: {
      limits: { contextWindowTokens: 128_000, maxOutputTokens: 16_384 },
      complete: async (input) => {
        calls += 1;
        if (calls === 1) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "fetch", name: "webfetch", arguments: { url: "https://example.com/large" } }] };
        if (calls === 2) {
          const evidence = projected(input.messages, "webfetch");
          assert.equal(evidence.contentSummary.properties.records.count, 200);
          assert.equal(await fs.readFile(join(root, evidence.contentLocation.path), "utf8"), source);
          return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "read", name: "computer_read_json", arguments: {
            path: evidence.contentLocation.path,
            queries: [{ pointer: "/records", offset: 199, limit: 1 }],
          } }] };
        }
        const read = projected(input.messages, "computer_read_json");
        assert.equal(read.queries[0].value[0].id, 199);
        return { content: "Final record: 199", finishReason: "stop", toolCalls: [] };
      },
    },
  });
  assert.equal(result.output, "Final record: 199");
  assert.equal(calls, 3);
});

test("compaction receives durable refs and cannot consume the current requested window", async () => {
  const hash = "a".repeat(64);
  const location = { kind: "content_addressed", path: ".agentloop/content-refs/aa/source.json", sha256: hash, characters: 10000, bytes: 10000 };
  const messages: ModelMessage[] = [{ role: "user", content: "Read the data" }];
  append(messages, "webfetch", {}, {
    schema: "agentloop.webFetch/v1", content: "source ".repeat(1500), contentLocation: location,
    evidenceReceipt: { sourceType: "web_page", sourceRefs: [], facts: [], caveats: [] },
  });
  messages.push({ role: "assistant", content: "old reasoning ".repeat(4000) });
  const window = "exact current window ".repeat(400);
  append(messages, "computer_read_file", { path: location.path, characterLimit: 12000 }, {
    schema: "agentloop.contentReferenceRead/v1", contentLocation: location, content: window,
    characterOffset: 0, returnedCharacters: window.length, nextCharacterOffset: null,
  });
  let summaryCalls = 0;
  const context = new ContextAssembler({
    runId: "compact-ref", systemPrompt: "Read evidence", runtimeContext: { phase: "execution", content: "Read" },
    policy: { proactiveCompactionTokens: 3000, preserveRecentTokens: 1000, pruneProtectTokens: 100 },
    model: { limits: { contextWindowTokens: 64_000, maxOutputTokens: 4096 }, complete: async (input) => {
      summaryCalls += 1;
      const summaryInput = JSON.stringify(input.messages);
      assert.match(summaryInput, /content-refs/);
      assert.match(summaryInput, new RegExp(hash));
      assert.doesNotMatch(summaryInput, /exact current window/);
      return { content: `## Goal\nRead the data\n## Evidence\n${location.path} sha256=${hash}\n## Next Steps\nUse the current window`, toolCalls: [], finishReason: "stop" };
    } },
  });
  const assembly = await context.assemble(messages, []);
  assert.ok(summaryCalls > 0);
  assert.equal(projected(assembly.messages, "computer_read_file").content, window);
});

test("a Runtime-owned content window survives JSON escaping at the tool serialization boundary", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "reference-escaping-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executor = new ComputerExecutor(root);
  const content = "\u0000".repeat(12000);
  const ref = await executor.storeContentReference(content);
  let calls = 0;
  const result = await runAgentLoop({
    runId: "escaped-ref", input: "Read the referenced window", systemPrompt: "Inspect the reference.",
    tools: new ToolRegistry(createComputerTools(executor)), availableSkills: [], maxSteps: 3,
    grant: createCapabilityGrant({ actorUserId: "test", runId: "escaped-ref", depth: 0, workspaceRoot: root,
      allowedToolNames: ["computer_read_file"], allowedSkillIds: [] }),
    model: { limits: { contextWindowTokens: 128_000, maxOutputTokens: 16_384 }, complete: async (input) => {
      calls += 1;
      if (calls === 1) return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "read", name: "computer_read_file", arguments: {
        path: ref.path, characterOffset: 0, characterLimit: 12000,
      } }] };
      const read = projected(input.messages, "computer_read_file");
      assert.equal(read.content, content);
      return { content: "Read 12000 characters", finishReason: "stop", toolCalls: [] };
    } },
  });
  assert.equal(result.output, "Read 12000 characters");
});
