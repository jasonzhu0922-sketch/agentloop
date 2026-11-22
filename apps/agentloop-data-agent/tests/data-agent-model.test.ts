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

test("explicit file requests resolve to a workspace artifact and load its file Skill", async () => {
  const calls: ModelInvocation[] = [];
  const model = dataAgentModel(adapter({ content: "fallback", finishReason: "stop", toolCalls: [] }, calls));
  const messages = [{ role: "user" as const, content: "查询钢联最近一个月的数据并导出 Excel 文件" }];
  const intent = await model.complete({ ...baseInvocation, phase: "planning", messages,
    tools: [{ name: "resolve_conversation_turn", description: "resolve", inputSchema: { type: "object" } }] });
  const taskIntent = (intent.toolCalls[0]?.arguments as any).taskIntent;
  assert.equal(taskIntent.operation, "create_artifact");
  assert.deepEqual(taskIntent.deliverables[0], { targetId: "answer-file", purpose: messages[0].content, expectedArtifactCount: 1,
    action: "create", kind: "spreadsheet", format: "xlsx", surface: "workspace_artifact" });
  const load = await model.complete({ ...baseInvocation, phase: "execution", messages,
    tools: [{ name: "load_skill", description: "load", inputSchema: { type: "object" } }] });
  assert.deepEqual(load.toolCalls.map(call => call.arguments), [{ name: "data-analysis" }, { name: "xlsx" }]);
  assert.equal(calls.length, 0);
});

test("document export formats select the matching file capability", async () => {
  const cases = [
    ["生成 Word 报告", "document", "docx", "docx"],
    ["导出 PDF 文件", "document", "pdf", "pdf"],
    ["制作 PPT 演示文稿", "presentation", "pptx", "pptx"],
    ["生成 HTML 看板", "html", "html", "build-dashboard"],
    ["输出 Markdown 文件", "document", "markdown", undefined],
  ] as const;
  for (const [input, kind, format, skillName] of cases) {
    const model = dataAgentModel(adapter({ content: "fallback", finishReason: "stop", toolCalls: [] }));
    const messages = [{ role: "user" as const, content: `查询经营指标并${input}` }];
    const intent = await model.complete({ ...baseInvocation, phase: "planning", messages,
      tools: [{ name: "resolve_conversation_turn", description: "resolve", inputSchema: { type: "object" } }] });
    const target = (intent.toolCalls[0]?.arguments as any).taskIntent.deliverables[0];
    assert.equal(target.kind, kind, input); assert.equal(target.format, format, input);
    const load = await model.complete({ ...baseInvocation, phase: "execution", messages,
      tools: [{ name: "load_skill", description: "load", inputSchema: { type: "object" } }] });
    assert.deepEqual(load.toolCalls.map(call => (call.arguments as any).name), ["data-analysis", ...(skillName ? [skillName] : [])], input);
  }
});

test("an explicit Excel format wins over the generic report word", async () => {
  const model = dataAgentModel(adapter({ content: "fallback", finishReason: "stop", toolCalls: [] }));
  const messages = [{ role: "user" as const, content: "查询收入并生成 Excel 报告" }];
  const intent = await model.complete({ ...baseInvocation, phase: "planning", messages,
    tools: [{ name: "resolve_conversation_turn", description: "resolve", inputSchema: { type: "object" } }] });
  const target = (intent.toolCalls[0]?.arguments as any).taskIntent.deliverables[0];
  assert.equal(target.kind, "spreadsheet");
  assert.equal(target.format, "xlsx");
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

test("an inline query plan removes a duplicate query-plan file argument", async () => {
  const request = { sql: "SELECT MAX(period) FROM business.monthly", params: [], query_plan: { context_id: "ctx_" + "a".repeat(64) } };
  const model = dataAgentModel(adapter({ content: "", finishReason: "tool_calls", toolCalls: [{
    id: "execute", name: "computer_run_command", arguments: { command: "python3", cwd: "@skills/data-analysis",
      args: ["scripts/data_client.py", "execute", "--request-json", JSON.stringify(request),
        "--query-plan", "@workspace/query-context.json", "--output", "@workspace/result.json"] },
  }] }));
  const response = await model.complete({ ...baseInvocation, phase: "execution" });
  const args = (response.toolCalls[0]?.arguments as any).args as string[];
  assert.equal(args.includes("--query-plan"), false);
  assert.deepEqual(JSON.parse(args[args.indexOf("--request-json") + 1]), request);
});

test("a query-plan file remains when the SQL request has no inline plan", async () => {
  const request = { sql: "SELECT MAX(period) FROM business.monthly", params: [] };
  const expected = ["scripts/data_client.py", "execute", "--request-json", JSON.stringify(request),
    "--query-plan", "@workspace/query-context.json", "--output", "@workspace/result.json"];
  const model = dataAgentModel(adapter({ content: "", finishReason: "tool_calls", toolCalls: [{
    id: "execute", name: "computer_run_command", arguments: { command: "python3", cwd: "@skills/data-analysis", args: expected },
  }] }));
  const response = await model.complete({ ...baseInvocation, phase: "execution" });
  assert.deepEqual((response.toolCalls[0]?.arguments as any).args, expected);
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
    "/sources", "/terms", "/metrics", "/entities", "/ambiguities", "/gaps", "/selection_contract",
  ]);
  assert.deepEqual(value.queries[0], { pointer: "/sources", offset: 0, limit: 3 });
  assert.deepEqual(value.queries[2], { pointer: "/metrics", offset: 0, limit: 5 });
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

test("query-context reads use the declared workspace output instead of guessed aliases or hidden refs", async () => {
  const context = { id: "context", name: "computer_run_command", arguments: { command: "python3",
    args: ["scripts/data_client.py", "get-query-context", "--output", "@workspace/hr_ctx.json"] } };
  for (const path of ["@workspace/hr_ctx.json", `@workspace/.data-agent-contexts/ctx_${"a".repeat(64)}.json`]) {
    const model = dataAgentModel(adapter({ content: "", finishReason: "tool_calls", toolCalls: [{
      id: "read", name: "computer_read_json", arguments: { path, queries: [{ pointer: "/plan_seed" }] },
    }] }));
    const response = await model.complete({ ...baseInvocation, phase: "execution", messages: [{ role: "assistant", content: "", toolCalls: [context] }] });
    assert.deepEqual(response.toolCalls[0]?.arguments, { path: "hr_ctx.json", queries: [{ pointer: "/plan_seed" }] });
  }
});

test("unknown JSON paths are not silently redirected to a context file", async () => {
  const context = { id: "context", name: "computer_run_command", arguments: { command: "python3",
    args: ["scripts/data_client.py", "get-query-context", "--output", "@workspace/hr_ctx.json"] } };
  const original = { path: "@workspace/other.json", queries: [{ pointer: "" }] };
  const model = dataAgentModel(adapter({ content: "", finishReason: "tool_calls", toolCalls: [{ id: "read", name: "computer_read_json", arguments: original }] }));
  const response = await model.complete({ ...baseInvocation, phase: "execution", messages: [{ role: "assistant", content: "", toolCalls: [context] }] });
  assert.deepEqual(response.toolCalls[0]?.arguments, original);
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

test("successful simple numeric lookups use deterministic assessment", async () => {
  const calls: ModelInvocation[] = [];
  const model = dataAgentModel(adapter({ content: "fallback", finishReason: "stop", toolCalls: [] }, calls));
  const context = {
    canonicalIntent: { userInput: "查询人力月报数据中最新的月份" },
    openEvidenceConcerns: [], assessmentGaps: [], temporalEvidenceGap: false,
    step: { successCriteria: [{ id: "business-answer" }, { id: "skill-contract" }] },
    skills: [{ id: "discovered:data-analysis" }],
    evidence: {
      candidateOutput: "最新月份是 2025 年 3 月（202503）。",
      toolCalls: [{ toolCallId: "sql-call", toolName: "computer_run_command", isError: false,
        result: JSON.stringify({ stdout: { content: { schema: "nl2sql.query-result/v1", status: "completed",
          dataset: { columns: ["latest_month"], rows: [["202503"]] } } } }) }],
    },
  };
  const runtimeContext = {
    id: "assessment", phase: "assessment" as const,
    content: '<assessment_context source="server">' + JSON.stringify(context) + '</assessment_context>',
  };
  const response = await model.complete({ ...baseInvocation, phase: "assessment", runtimeContext,
    tools: [{ name: "submit_assessment", description: "assess", inputSchema: { type: "object" } }] });
  assert.equal(calls.length, 0);
  assert.equal(response.toolCalls[0]?.name, "submit_assessment");
  const args = response.toolCalls[0]?.arguments as any;
  assert.deepEqual(args.criteria.map((item: any) => item.criterionId), ["business-answer", "skill-contract"]);
  assert.equal(args.criteria.every((item: any) => item.satisfied), true);
  assert.equal(args.skills[0].skillId, "discovered:data-analysis");
  assert.equal(args.failedBoundary, null);
});

test("empty temporal evidence gap objects do not force model assessment", async () => {
  for (const temporalEvidenceGap of [null, { hasGap: false }, { status: "clear" }]) {
    const calls: ModelInvocation[] = [];
    const model = dataAgentModel(adapter({ content: "fallback", finishReason: "stop", toolCalls: [] }, calls));
    const context = {
      canonicalIntent: { userInput: "查询人力月报最新月份" },
      openEvidenceConcerns: [], assessmentGaps: [], temporalEvidenceGap,
      step: { successCriteria: [{ id: "business-answer" }] },
      skills: [{ id: "discovered:data-analysis" }],
      evidence: {
        candidateOutput: "最新月份是 2025 年 3 月（202503）。",
        toolCalls: [{ toolCallId: "sql-call", isError: false, result: JSON.stringify({
          schema: "nl2sql.query-result/v1", status: "completed", dataset: { rows: [["202503"]] },
        }) }],
      },
    };
    const response = await model.complete({ ...baseInvocation, phase: "assessment", runtimeContext: {
      id: "assessment", phase: "assessment",
      content: '<assessment_context>' + JSON.stringify(context) + '</assessment_context>',
    }, tools: [{ name: "submit_assessment", description: "assess", inputSchema: { type: "object" } }] });
    assert.equal(calls.length, 0, JSON.stringify(temporalEvidenceGap));
    assert.equal(response.toolCalls[0]?.name, "submit_assessment");
  }
});

test("analysis requests and ungrounded lookup values keep model assessment", async () => {
  const cases = [
    ["分析各月人力变化趋势", "2025 年 3 月为最高值。", "202503"],
    ["查询人力月报最新月份", "最新月份是 2025 年 4 月（202504）。", "202503"],
  ];
  for (const [input, candidate, row] of cases) {
    const calls: ModelInvocation[] = [];
    const model = dataAgentModel(adapter({ content: "", finishReason: "tool_calls", toolCalls: [{
      id: "assessment", name: "submit_assessment", arguments: { criteria: [], skills: [], feedback: "", failedBoundary: null, concernResolutions: [] },
    }] }, calls));
    const context = { canonicalIntent: { userInput: input }, openEvidenceConcerns: [], assessmentGaps: [],
      step: { successCriteria: [{ id: "business-answer" }] }, skills: [], evidence: { candidateOutput: candidate,
        toolCalls: [{ toolCallId: "sql-call", isError: false,
          result: JSON.stringify({ schema: "nl2sql.query-result/v1", status: "completed", dataset: { rows: [[row]] } }) }] } };
    const runtimeContext = {
      id: "assessment", phase: "assessment" as const,
      content: '<assessment_context>' + JSON.stringify(context) + '</assessment_context>',
    };
    await model.complete({ ...baseInvocation, phase: "assessment", runtimeContext,
      tools: [{ name: "submit_assessment", description: "assess", inputSchema: { type: "object" } }] });
    assert.equal(calls.length, 1, input);
  }
});
