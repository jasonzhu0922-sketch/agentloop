import assert from "node:assert/strict";
import test from "node:test";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "@zhujun/agentloop";
import { dataAgentModel } from "../src/data-agent-model.ts";

function adapter(response: ModelResponse, calls: ModelInvocation[] = []): ModelAdapter {
  return {
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
    async complete(invocation) { calls.push(invocation); return response; },
  };
}

const baseInvocation = {
  runId: "data-agent-guard", systemPrompt: "test", runtimeContext: undefined,
  messages: [], tools: [],
} satisfies Omit<ModelInvocation, "phase">;

test("data questions use the fixed intent and Skill without model round trips", async () => {
  const calls: ModelInvocation[] = [];
  const model = dataAgentModel(adapter({ content: "fallback", finishReason: "stop", toolCalls: [] }, calls));
  const intent = await model.complete({ ...baseInvocation, phase: "planning",
    messages: [{ role: "user", content: "查询集团最新月份的员工人数" }],
    tools: [{ name: "resolve_conversation_turn", description: "resolve", inputSchema: { type: "object" } }] });
  assert.equal(intent.toolCalls[0]?.name, "resolve_conversation_turn");
  assert.equal((intent.toolCalls[0]?.arguments as any).mode, "execute");
  const load = await model.complete({ ...baseInvocation, phase: "execution",
    tools: [{ name: "load_skill", description: "load", inputSchema: { type: "object" } }] });
  assert.deepEqual(load.toolCalls[0]?.arguments, { name: "data-analysis" });
  assert.equal(calls.length, 0);
});

test("follow-up references keep the generic resolver path", async () => {
  const calls: ModelInvocation[] = [];
  const model = dataAgentModel(adapter({ content: "generic", finishReason: "stop", toolCalls: [] }, calls));
  await model.complete({ ...baseInvocation, phase: "planning",
    messages: [{ role: "user", content: "把刚才的查询改成同比分析" }],
    tools: [{ name: "resolve_conversation_turn", description: "resolve", inputSchema: { type: "object" } }] });
  assert.equal(calls.length, 1);
});

test("invalid command shapes and guessed Result pointers are corrected before execution", async () => {
  const model = dataAgentModel(adapter({ content: "", finishReason: "tool_calls", toolCalls: [
    { id: "command-1", name: "computer_run_command", arguments: { command: ["python3", "scripts/data_client.py", "catalog"], cwd: "@skills/data-analysis" } },
    { id: "command-duplicate", name: "computer_run_command", arguments: { command: ["python3", "scripts/data_client.py", "catalog"], cwd: "@skills/data-analysis" } },
    { id: "read", name: "read_result", arguments: { resultId: "result-1", pointer: "/sql" } },
  ] }));
  const response = await model.complete({ ...baseInvocation, phase: "execution" });
  assert.equal(response.toolCalls.length, 2);
  assert.deepEqual(response.toolCalls[0]?.arguments, { command: "python3", args: ["scripts/data_client.py", "catalog"], cwd: "@skills/data-analysis" });
  assert.deepEqual(response.toolCalls[1]?.arguments, { resultId: "result-1" });
});

test("data-client query plans drop unsupported metric binding fields", async () => {
  const request = {
    sql: "SELECT COUNT(*) FROM nl2sql_group.mb_index_main_data WHERE is_deleted = %s", params: ["0"],
    query_plan: { metric_bindings: [{ source_id: "mb_index_main_data", metric_id: "market_record_count", expression: "COUNT(*)", filter: "is_deleted='0'" }] },
  };
  const model = dataAgentModel(adapter({ content: "", finishReason: "tool_calls", toolCalls: [{
    id: "execute", name: "computer_run_command", arguments: { command: "python3", cwd: "@skills/data-analysis",
      args: ["scripts/data_client.py", "execute", "--request-json", JSON.stringify(request)] },
  }] }));
  const response = await model.complete({ ...baseInvocation, phase: "execution" });
  const args = (response.toolCalls[0]?.arguments as any).args as string[];
  const normalized = JSON.parse(args[args.indexOf("--request-json") + 1]);
  assert.deepEqual(normalized.query_plan.metric_bindings, [{ source_id: "mb_index_main_data", metric_id: "market_record_count" }]);
});

test("the first retrieve-knowledge file read selects the useful fields once", async () => {
  const prior = { id: "retrieve", name: "computer_run_command", arguments: { command: "python3", cwd: "@skills/data-analysis",
    args: ["scripts/data_client.py", "retrieve-knowledge", "--output", "@workspace/steel_knowledge.json"] } };
  const model = dataAgentModel(adapter({ content: "", finishReason: "tool_calls", toolCalls: [{
    id: "read", name: "computer_read_json", arguments: { path: "steel_knowledge.json" },
  }] }));
  const response = await model.complete({ ...baseInvocation, phase: "execution", messages: [{ role: "assistant", content: "", toolCalls: [prior] }] });
  const value = response.toolCalls[0]?.arguments as any;
  assert.deepEqual(value.queries.map((query: any) => query.pointer), [
    "/sources", "/terms", "/metrics", "/ambiguities", "/gaps", "/selection_contract", "/relationships",
  ]);
});

test("later pagination reads of the same knowledge file are preserved", async () => {
  const retrieve = { id: "retrieve", name: "computer_run_command", arguments: { command: "python3",
    args: ["scripts/data_client.py", "retrieve-knowledge", "--output", "@workspace/steel_knowledge.json"] } };
  const firstRead = { id: "first", name: "computer_read_json", arguments: { path: "steel_knowledge.json", queries: [{ pointer: "/sources" }] } };
  const pagination = { path: "steel_knowledge.json", queries: [{ pointer: "/sources", offset: 5, limit: 5 }] };
  const model = dataAgentModel(adapter({ content: "", finishReason: "tool_calls", toolCalls: [{ id: "page", name: "computer_read_json", arguments: pagination }] }));
  const response = await model.complete({ ...baseInvocation, phase: "execution", messages: [
    { role: "assistant", content: "", toolCalls: [retrieve] }, { role: "assistant", content: "", toolCalls: [firstRead] },
  ] });
  assert.deepEqual(response.toolCalls[0]?.arguments, pagination);
});

test("whole-file reads of knowledge output are converted to focused JSON reads", async () => {
  const retrieve = { id: "retrieve", name: "computer_run_command", arguments: { command: "python3",
    args: ["scripts/data_client.py", "retrieve-knowledge", "--output", "@workspace/steel_knowledge.json"] } };
  const model = dataAgentModel(adapter({ content: "", finishReason: "tool_calls", toolCalls: [{
    id: "whole", name: "computer_read_file", arguments: { path: "steel_knowledge.json" },
  }] }));
  const response = await model.complete({ ...baseInvocation, phase: "execution", messages: [{ role: "assistant", content: "", toolCalls: [retrieve] }] });
  assert.equal(response.toolCalls[0]?.name, "computer_read_json");
  assert.equal((response.toolCalls[0]?.arguments as any).queries[0].pointer, "/sources");
});

test("absolute knowledge file paths are recognized as the same workspace output", async () => {
  const retrieve = { id: "retrieve", name: "computer_run_command", arguments: { command: "python3",
    args: ["scripts/data_client.py", "retrieve-knowledge", "--output", "@workspace/steel_knowledge.json"] } };
  const model = dataAgentModel(adapter({ content: "", finishReason: "tool_calls", toolCalls: [{
    id: "read", name: "computer_read_json", arguments: { path: "E:\\workspace\\conversation\\steel_knowledge.json", queries: [{ pointer: "/sources" }] },
  }] }));
  const response = await model.complete({ ...baseInvocation, phase: "execution", messages: [{ role: "assistant", content: "", toolCalls: [retrieve] }] });
  assert.equal((response.toolCalls[0]?.arguments as any).path, "steel_knowledge.json");
  assert.equal((response.toolCalls[0]?.arguments as any).queries.length, 7);
});

test("final delivery drops internal narration before the last divider", async () => {
  const model = dataAgentModel(adapter({ content: "信息已经齐备，可以提交。\n\n---\n\n- 日期：2025-01-02\n- 指标：144,438 个", finishReason: "stop", toolCalls: [] }));
  const response = await model.complete({ ...baseInvocation, phase: "execution" });
  assert.equal(response.content, "- 日期：2025-01-02\n- 指标：144,438 个");
});

test("simple lookup delivery removes a repeated summary before the bullets", async () => {
  const model = dataAgentModel(adapter({ content: "**回答**\n\n共有 3 项结果。\n\n- 日期：2025-01-02\n- 指标：144,438 个\n- 记录：170,994 条\n\n口径：只统计有效记录。", finishReason: "stop", toolCalls: [] }));
  const response = await model.complete({ ...baseInvocation, phase: "execution", messages: [{ role: "user", content: "查询钢联有多少指标和记录" }] });
  assert.equal(response.content, "- 日期：2025-01-02\n- 指标：144,438 个\n- 记录：170,994 条\n\n口径：只统计有效记录。");
});

test("final delivery never drops requested result bullets", async () => {
  const content = "结果如下：\n\n- A：1\n- B：2\n- C：3\n- D：4\n- E：5\n\n说明：E 是最新补录。";
  const model = dataAgentModel(adapter({ content, finishReason: "stop", toolCalls: [] }));
  const response = await model.complete({ ...baseInvocation, phase: "execution",
    messages: [{ role: "user", content: "查询五个经营指标" }] });
  assert.equal(response.content, content);
});

test("assessment is forced to its only tool and a silent first stream is retried once", async () => {
  const invocations: ModelInvocation[] = [];
  let streams = 0;
  const underlying: ModelAdapter = {
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8_192 },
    async complete(invocation) {
      invocations.push(invocation);
      return { content: "", finishReason: "tool_calls", toolCalls: [] };
    },
    async streamComplete(invocation, sink, signal) {
      invocations.push(invocation);
      streams += 1;
      if (streams === 1) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        return { content: "late", finishReason: "stop", toolCalls: [] };
      }
      await sink({ type: "text_delta", text: "ok" });
      return { content: "ok", finishReason: "stop", toolCalls: [] };
    },
  };
  const model = dataAgentModel(underlying, { firstEventTimeoutMs: 5 });
  await model.complete({ ...baseInvocation, phase: "assessment",
    tools: [{ name: "submit_assessment", description: "assess", inputSchema: { type: "object" } }] });
  assert.deepEqual(invocations[0]?.toolChoice, { name: "submit_assessment" });
  const response = await model.streamComplete!({ ...baseInvocation, phase: "execution" }, () => undefined);
  assert.equal(response.content, "ok");
  assert.equal(streams, 2);
});
