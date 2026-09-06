import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { artifactStepToolProgressPolicy } from "../src/runtime/tool-progress-policy.ts";
import type {
  CapabilityGrant,
  ModelAdapter,
  ModelInvocation,
  ModelResponse,
  ModelStreamSink,
  RuntimeEvent,
} from "../src/runtime/contracts.ts";
import { AppError } from "../src/shared/errors.ts";
import { ToolRegistry } from "../src/tools/tool-registry.ts";
import type { RuntimeTool } from "../src/tools/tool-registry.ts";
import { TEST_MODEL_LIMITS } from "./runtime-test-helpers.ts";

test("parallel tools settle into model source order while completion events stay truthful", async () => {
  const model = new ParallelScenarioModel();
  const events: RuntimeEvent[] = [];
  const registry = new ToolRegistry([
    numberTool("slow_double", 20, (value) => value * 2),
    numberTool("fast_square", 1, (value) => value * value),
  ]);
  const grant = makeGrant(["slow_double", "fast_square"]);

  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Test agent",
    input: "calculate",
    model,
    tools: registry,
    grant,
    maxSteps: 4,
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "done");
  const toolMessages = result.messages.filter((message) => message.role === "tool");
  assert.deepEqual(toolMessages.map((message) => message.name), ["slow_double", "fast_square"]);
  assert.deepEqual(toolMessages.map((message) => message.content), ["6", "16"]);
  const completionNames = events
    .filter((event) => event.type === "tool.completed")
    .map((event) => event.data.toolName);
  assert.deepEqual(completionNames, ["fast_square", "slow_double"]);
});

test("execution turns use the model-declared output budget", async () => {
  let observedMaxOutputTokens: number | undefined;
  const highOutputModel: ModelAdapter = {
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 32_768 },
    complete: async (request) => {
      observedMaxOutputTokens = request.maxOutputTokens;
      return { content: "done", finishReason: "stop", toolCalls: [] };
    },
  };
  const grant = makeGrant([]);

  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Test agent",
    input: "finish",
    model: highOutputModel,
    tools: new ToolRegistry([]),
    grant,
    maxSteps: 1,
  });

  assert.equal(result.output, "done");
  assert.equal(observedMaxOutputTokens, 32_768);
});

test("batch source reads are observed as one tool action with many source receipts", async () => {
  const events: RuntimeEvent[] = [];
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "read-35",
            name: "visible_read_files",
            arguments: {
              rootId: "visible_dir_1",
              files: Array.from({ length: 35 }, (_, index) => ({ path: `kb-${index + 1}.md` })),
            },
          }],
        };
      }
      return { content: "source summary ready", finishReason: "stop", toolCalls: [] };
    },
  };
  const registry = new ToolRegistry([{
    name: "visible_read_files",
    description: "read many files",
    inputSchema: {
      type: "object",
      required: ["files"],
      properties: { files: { type: "array" } },
    },
    executionMode: "parallel",
    replaySafe: true,
    parse: (input) => input,
    execute: async (_context, input) => {
      const files = (input as { files: Array<{ path: string }> }).files;
      const sourceRefs = files.map((file, index) => ({
        sourceRefId: `visible_dir_1:${file.path}`,
        rootId: "visible_dir_1",
        path: file.path,
        characters: 100 + index,
      }));
      return {
        schema: "agentloop.visibleReadFiles/v1",
        requested: files.length,
        returned: files.length,
        evidenceReceipt: {
          schema: "agentloop.toolEvidenceReceipt/v1",
          sourceType: "visible_files",
          receiptId: "receipt-35",
          sourceRefs,
          facts: files.map((file) => ({ kind: "source_summary", path: file.path })),
          caveats: [],
          evidenceKinds: { satisfied: ["source_read", "source_refs"], caveated: [], failed: [] },
        },
      };
    },
  }]);

  await runAgentLoop({
    runId: "run-batch-source-observed",
    systemPrompt: "Test agent",
    input: "read sources",
    model,
    tools: registry,
    grant: makeGrant(["visible_read_files"]),
    maxSteps: 4,
    shouldConvergeAfterToolStep: () => ({ converge: true, reason: "lookup_evidence_ready" }),
    emit: (event) => { events.push(event); },
  });

  const completed = events.find((event) => event.type === "tool.completed");
  assert.equal(completed?.data.toolName, "visible_read_files");
  assert.equal(completed?.data.sourceBatchReadCount, 35);
  assert.equal(completed?.data.sourceReadCount, 35);
  assert.equal(completed?.data.sourceRefCount, 35);
  const queued = events.find((event) => event.type === "loop.convergence_queued");
  assert.equal((queued?.data.sourceAcquisition as { batchCount?: number })?.batchCount, 1);
  assert.equal((queued?.data.sourceAcquisition as { sourceReadCount?: number })?.sourceReadCount, 35);
  assert.equal((queued?.data.sourceAcquisition as { uniqueSourceReadCount?: number })?.uniqueSourceReadCount, 35);
});

test("tool calls from a length-truncated model response are never dispatched", async () => {
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "unsafe_write",
    description: "A replay-unsafe effect",
    inputSchema: { type: "object" },
    executionMode: "exclusive",
    replaySafe: false,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return "written";
    },
  };
  const model = new TruncatedScenarioModel();
  const grant = makeGrant(["unsafe_write"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Test agent",
    input: "write",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 3,
  });
  assert.equal(result.output, "recovered");
  assert.equal(executions, 0);
  const toolMessage = result.messages.find((message) => message.role === "tool");
  assert.match(toolMessage?.content ?? "", /output limit/);
});

test("the runtime, not model prose, enforces the step budget", async () => {
  const tool: RuntimeTool<unknown> = {
    name: "read_only",
    description: "Read-only test tool",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => ({ ok: true }),
  };
  const grant = makeGrant(["read_only"]);
  const events: RuntimeEvent[] = [];
  await assert.rejects(
    () => runAgentLoop({
      runId: grant.runId,
      systemPrompt: "Never stop",
      input: "loop",
      model: new EndlessToolModel(),
      tools: new ToolRegistry([tool]),
      grant,
      maxSteps: 2,
      emit: (event) => { events.push(event); },
    }),
    (error: unknown) => error !== null
      && typeof error === "object"
      && "code" in error
      && (error as { code: unknown }).code === "RUN_LIMIT_EXCEEDED",
  );
  assert.equal(events.filter((event) => event.type === "tool.completed").length, 1);
  assert.equal(events.filter((event) => event.type === "loop.convergence_requested").length, 1);
  assert.equal(events.filter((event) => event.type === "tool.rejected").length, 1);
});

test("the final budgeted turn converges without tools and submits existing evidence for assessment", async () => {
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "collect_evidence",
    description: "Collect canonical evidence",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return { artifact: "ready", qa: "passed" };
    },
  };
  const model = new ConvergenceScenarioModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["collect_evidence"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Complete the admitted step.",
    input: "produce and verify the artifact",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 2,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (candidate) => ({
      approved: candidate.output.includes("artifact ready")
        && candidate.toolEvidence.some((item) => item.toolName === "collect_evidence" && !item.isError),
      feedback: "",
    }),
  });

  assert.equal(result.output, "artifact ready; QA passed; evidence: collect_evidence");
  assert.equal(executions, 1);
  assert.equal(model.calls, 2);
  assert.equal(events.filter((event) => event.type === "loop.convergence_requested").length, 1);
  assert.equal(events.filter((event) => event.type === "candidate.approved").length, 1);
  assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
});

test("the final budgeted turn can execute missing required evidence before convergence", async () => {
  let produceExecutions = 0;
  let acceptExecutions = 0;
  const produceTool: RuntimeTool<unknown> = {
    name: "produce_artifact",
    description: "Produce an artifact",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async () => {
      produceExecutions += 1;
      return { path: "poster.png", bytes: 12 };
    },
  };
  const acceptTool: RuntimeTool<unknown> = {
    name: "verify_artifact_acceptance",
    description: "Verify artifact acceptance",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      acceptExecutions += 1;
      return {
        verdict: "accepted",
        evidenceKinds: { satisfied: ["artifact_acceptance"], caveated: [], failed: [] },
      };
    },
  };
  const model = new FinalEvidenceAtLimitModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["produce_artifact", "verify_artifact_acceptance"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Produce and verify the artifact.",
    input: "make poster",
    model,
    tools: new ToolRegistry([produceTool, acceptTool]),
    grant,
    maxSteps: 2,
    convergenceGraceSteps: 0,
    candidateRepairGraceSteps: 0,
    shouldUseFinalConvergence: (context) =>
      context.toolEvidence.some((item) => item.toolName === "verify_artifact_acceptance" && !item.isError),
    shouldConvergeAfterToolStep: (context) => ({
      converge: context.latestToolEvidence.some((item) => item.toolName === "verify_artifact_acceptance" && !item.isError),
      reason: "artifact_acceptance_observed",
    }),
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (candidate) => ({
      approved: candidate.output.includes("poster.png accepted")
        && candidate.toolEvidence.some((item) => item.toolName === "verify_artifact_acceptance" && !item.isError),
      feedback: "",
    }),
  });

  assert.equal(result.output, "poster.png accepted with artifact_acceptance evidence");
  assert.equal(produceExecutions, 1);
  assert.equal(acceptExecutions, 1);
  assert.equal(model.calls, 3);
  assert.equal(events.filter((event) => event.type === "loop.final_convergence_grace_granted").length, 1);
  assert.equal(events.filter((event) => event.type === "candidate.approved").length, 1);
  assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
});

test("artifact receipts that satisfy required evidence complete without a final model rewrite", async () => {
  let writeExecutions = 0;
  let verifyExecutions = 0;
  const writeTool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write artifact",
    inputSchema: { type: "object" },
    executionMode: "exclusive",
    replaySafe: false,
    parse: (value) => value,
    execute: async () => {
      writeExecutions += 1;
      return {
        path: "report.html",
        bytes: 18,
        sha256: "write-sha",
        artifactReceipt: {
          schema: "agentloop.artifactReceipt/v1",
          artifact: { path: "report.html", kind: "html", bytes: 18, sha256: "write-sha" },
          evidenceKinds: {
            satisfied: ["artifact_path", "artifact_non_empty"],
            caveated: [],
            failed: [],
          },
        },
      };
    },
  };
  const verifyTool: RuntimeTool<unknown> = {
    name: "verify_artifact_acceptance",
    description: "Verify artifact acceptance",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      verifyExecutions += 1;
      return {
        schema: "agentloop.artifactAcceptance/v1",
        artifact: { path: "report.html", kind: "html", bytes: 18, sha256: "accepted-sha" },
        verdict: "accepted",
        evidenceKinds: {
          satisfied: ["artifact_acceptance", "artifact_openable", "format_matches_request"],
          caveated: [],
          failed: [],
        },
      };
    },
  };
  let modelCalls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    async complete(request: ModelInvocation): Promise<ModelResponse> {
      modelCalls += 1;
      if (modelCalls === 1) {
        assert.equal(request.tools.some((tool) => tool.name === "computer_write_file"), true);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "write-report", name: "computer_write_file", arguments: { path: "report.html" } }],
        };
      }
      if (modelCalls === 2) {
        assert.equal(request.tools.some((tool) => tool.name === "verify_artifact_acceptance"), true);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "verify-report", name: "verify_artifact_acceptance", arguments: { artifactPath: "report.html" } }],
        };
      }
      throw new Error("Runtime should complete from receipts without a final convergence model turn");
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["computer_write_file", "verify_artifact_acceptance"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "生成并验收产物。",
    input: "生成一个报告页面",
    model,
    tools: new ToolRegistry([writeTool, verifyTool]),
    grant,
    maxSteps: 8,
    convergenceGraceSteps: 4,
    progressPolicy: artifactStepToolProgressPolicy(["artifact_path", "artifact_non_empty", "artifact_acceptance"]),
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (candidate) => {
      assert.match(candidate.output, /已完成并通过当前步骤的验收检查/);
      assert.match(candidate.output, /report\.html/);
      assert.doesNotMatch(candidate.output, /Runtime evidence satisfies the current step evidence contract/);
      assert.doesNotMatch(candidate.output, /Evidence tool calls/);
      assert.equal(candidate.toolEvidence.some((item) => item.toolCallId === "write-report"), true);
      assert.equal(candidate.toolEvidence.some((item) => item.toolCallId === "verify-report"), true);
      return { approved: true, feedback: "" };
    },
  });

  assert.match(result.output, /已完成并通过当前步骤的验收检查/);
  assert.match(result.output, /report\.html/);
  assert.doesNotMatch(result.output, /Runtime evidence satisfies the current step evidence contract/);
  assert.doesNotMatch(result.output, /Evidence tool calls/);
  assert.equal(writeExecutions, 1);
  assert.equal(verifyExecutions, 1);
  assert.equal(modelCalls, 2);
  assert.equal(events.filter((event) => event.type === "candidate.evidence_completion_detected").length, 1);
  assert.equal(events.filter((event) => event.type === "loop.convergence_queued").length, 0);
  assert.equal(events.filter((event) => event.type === "loop.convergence_requested").length, 0);
  assert.equal(events.filter((event) => event.type === "candidate.approved").length, 1);
});

test("source-only evidence receipts do not replace a produce step delivery candidate", async () => {
  let readExecutions = 0;
  let modelCalls = 0;
  const readSourceTool: RuntimeTool<unknown> = {
    name: "read_source",
    description: "Read uploaded source",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      readExecutions += 1;
      return {
        schema: "agentloop.uploadedSourceRead/v1",
        chunks: [{ chunkIndex: 0, content: "总分 7.46 / 100。评价等级：需重点整改。" }],
        evidenceReceipt: {
          schema: "agentloop.toolEvidenceReceipt/v1",
          facts: [{ kind: "source_summary", sourceId: "src_report", returnedChunkCount: 1 }],
          evidenceKinds: {
            satisfied: ["source_summary", "explicit_caveats"],
            caveated: [],
            failed: [],
          },
        },
      };
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    async complete(): Promise<ModelResponse> {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          content: "我先读取上传报告。",
          finishReason: "tool_calls",
          toolCalls: [{ id: "read-report", name: "read_source", arguments: { sourceId: "src_report" } }],
        };
      }
      return {
        content: "报告解读：总分 7.46/100，等级为需重点整改，重点关注交通部门低分预警。",
        finishReason: "stop",
        toolCalls: [],
      };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["read_source"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Interpret the uploaded report in Chinese.",
    input: "解读一下这个文件",
    model,
    tools: new ToolRegistry([readSourceTool]),
    grant,
    maxSteps: 3,
    progressPolicy: artifactStepToolProgressPolicy(["source_summary", "explicit_caveats"]),
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (candidate) => {
      assert.doesNotMatch(candidate.output, /Runtime evidence satisfies the current step evidence contract/);
      return { approved: true, feedback: "" };
    },
  });

  assert.equal(result.output, "报告解读：总分 7.46/100，等级为需重点整改，重点关注交通部门低分预警。");
  assert.equal(readExecutions, 1);
  assert.equal(modelCalls, 2);
  assert.equal(events.some((event) => event.type === "candidate.evidence_completion_detected"), false);
  assert.equal(events.filter((event) => event.type === "candidate.approved").length, 1);
});

test("conversation produce candidates carry explicit caveats as structured delivery evidence", async () => {
  let modelCalls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    async complete(): Promise<ModelResponse> {
      modelCalls += 1;
      return {
        content: "已完成汇总分析，团队整体表现较好。",
        finishReason: "stop",
        toolCalls: [],
      };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant([]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Summarize the analysis.",
    input: "给我一个汇总分析",
    model,
    tools: new ToolRegistry([]),
    grant,
    maxSteps: 2,
    stepSemanticFrame: {
      completionBoundary: ["explicit_caveats"],
      evidenceMode: "produce_without_external_evidence",
      phaseRole: "delivery",
    },
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (candidate) => {
      assert.ok(candidate.deliveryCandidate);
      assert.equal(candidate.deliveryCandidate.schema, "agentloop.runtimeDeliveryCandidate/v1");
      assert.equal(candidate.deliveryCandidate.caveats.length > 0, true);
      assert.equal(candidate.stepSemanticFrame?.completionBoundary.includes("explicit_caveats"), true);
      assert.match(candidate.deliveryCandidate.output, /## (?:限制说明|Limitations)/);
      return { approved: true, feedback: "" };
    },
  });

  assert.equal(modelCalls, 1);
  assert.ok(result.deliveryCandidate);
  assert.equal(result.deliveryCandidate.schema, "agentloop.runtimeDeliveryCandidate/v1");
  assert.equal(result.deliveryCandidate.caveats.length > 0, true);
  assert.match(result.deliveryCandidate.output, /## (?:限制说明|Limitations)/);
  assert.equal(events.filter((event) => event.type === "candidate.approved").length, 1);
});

test("structured tool candidates go directly to assessment without a final model rewrite", async () => {
  let executions = 0;
  let assessmentCalls = 0;
  const caveat = "目录结果需要以精确 API_ID 再确认。";
  const delivery = [
    "合同备案记录查询 API has sysId input and verified output fields.",
    "",
    "## 限制说明",
    "",
    `- ${caveat}`,
  ].join("\n");
  const tool: RuntimeTool<unknown> = {
    name: "lookup_api",
    description: "Return structured API lookup evidence",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return {
        schema: "api_catalog_result/v1",
        deliveryCandidate: {
          output: delivery,
        },
        assessmentProjection: {
          match_count: 1,
          primary_api_id: "M_DWD_CONTRACT_RECORD_PLATFORM.D_A_BSTACW00_HTBA_001",
          output_field_counts: { "M_DWD_CONTRACT_RECORD_PLATFORM.D_A_BSTACW00_HTBA_001": 32 },
        },
        evidenceReceipt: {
          schema: "agentloop.toolEvidenceReceipt/v1",
          sourceType: "api_catalog",
          receiptId: "api-receipt-with-visible-caveat",
          facts: [{ kind: "source_summary", primary_api_id: "M_DWD_CONTRACT_RECORD_PLATFORM.D_A_BSTACW00_HTBA_001" }],
          caveats: [caveat],
          evidenceKinds: { satisfied: ["source_summary"], caveated: ["explicit_caveats"], failed: [] },
        },
        rawRows: "x".repeat(20_000),
      };
    },
  };
  const model = new StructuredCandidateModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["lookup_api"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Complete the admitted step.",
    input: "query contract filing API",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 4,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (candidate) => {
      assessmentCalls += 1;
      assert.match(candidate.output, /sysId/);
      assert.equal(candidate.output.split(caveat).length - 1, 1);
      const projected = candidate.projectedToolEvidence.find((item) => item.toolCallId === "lookup-1");
      assert.match(projected?.result ?? "", /api_catalog_result\/v1/);
      assert.match(projected?.result ?? "", /primary_api_id/);
      assert.doesNotMatch(projected?.result ?? "", /xxxxxxxxxxxxxxxxxxxxxxxx/);
      return { approved: true, feedback: "" };
    },
  });

  assert.equal(result.output, delivery);
  assert.equal(executions, 1);
  assert.equal(model.calls, 1);
  assert.equal(assessmentCalls, 1);
  assert.equal(events.filter((event) => event.type === "candidate.structured_tool_detected").length, 1);
  assert.equal(events.filter((event) => event.type === "loop.convergence_requested").length, 0);
  assert.equal(events.filter((event) => event.type === "candidate.approved").length, 1);
});

test("structured stdout candidates from command-style tools go directly to assessment", async () => {
  let executions = 0;
  let assessmentCalls = 0;
  const tool: RuntimeTool<unknown> = {
    name: "lookup_api",
    description: "Return command-style API lookup evidence",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          schema: "api_catalog_result/v1",
          deliveryCandidate: {
            output: "员工画像标签人员查询 API has countNum and sql inputs.",
          },
          assessmentProjection: {
            match_count: 1,
            primary_api_id: "M_ADS_FACT_MDYG_USER_TRIP_LABEL.D_A_BSTAMDYG_CL002",
          },
          stdoutRef: {
            path: ".agentloop/tool-results/aa/example.stdout.txt",
            sha256: "a".repeat(64),
            characters: 30_000,
            bytes: 30_000,
            previewCharacters: 2_000,
          },
        }),
        stderr: "",
      };
    },
  };
  const model = new StructuredCandidateModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["lookup_api"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Complete the admitted step.",
    input: "query employee profile API",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 4,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (candidate) => {
      assessmentCalls += 1;
      assert.match(candidate.output, /countNum/);
      const projected = candidate.projectedToolEvidence.find((item) => item.toolCallId === "lookup-1");
      assert.match(projected?.result ?? "", /api_catalog_result\/v1/);
      assert.match(projected?.result ?? "", /primary_api_id/);
      return { approved: true, feedback: "" };
    },
  });

  assert.match(result.output, /员工画像标签人员查询/);
  assert.equal(executions, 1);
  assert.equal(model.calls, 1);
  assert.equal(assessmentCalls, 1);
  assert.equal(events.filter((event) => event.type === "candidate.structured_tool_detected").length, 1);
  assert.equal(events.filter((event) => event.type === "loop.convergence_requested").length, 0);
  assert.equal(events.filter((event) => event.type === "candidate.approved").length, 1);
});

test("oversized structured stdout candidates from command projections go directly to assessment", async () => {
  let executions = 0;
  let assessmentCalls = 0;
  const delivery = `合同备案记录查询 API has sysId input.\n${"出参字段 ".repeat(1200)}`;
  const caveat = "Candidate ranking requires exact API_ID confirmation.";
  const tool: RuntimeTool<unknown> = {
    name: "lookup_api",
    description: "Return projected command-style API lookup evidence",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          schema: "agentloop.commandOutputProjection/v1",
          stream: "stdout",
          sourceSchema: "api_catalog_result/v1",
          deliveryCandidate: { output: delivery, format: "markdown" },
          assessmentProjection: {
            match_count: 1,
            primary_api_id: "M_DWD_CONTRACT_RECORD_PLATFORM.D_A_BSTACW00_HTBA_001",
          },
          evidenceReceipt: {
            schema: "agentloop.toolEvidenceReceipt/v1",
            sourceType: "api_catalog",
            receiptId: "api-receipt-large-candidate",
            sourceRefs: [{ url: "https://eplat.baocloud.cn/service/D_A_BSTABD00_SHUTU_AGENT" }],
            facts: [{ kind: "source_summary", primary_api_id: "M_DWD_CONTRACT_RECORD_PLATFORM.D_A_BSTACW00_HTBA_001" }],
            caveats: [caveat],
            evidenceKinds: { satisfied: ["source_summary", "source_urls"], caveated: ["explicit_caveats"], failed: [] },
          },
          contentLocation: {
            kind: "content_addressed",
            stream: "stdout",
            path: ".agentloop/tool-results/aa/example.stdout.txt",
            sha256: "a".repeat(64),
            characters: 30_000,
            bytes: 30_000,
            previewCharacters: 2_000,
          },
        }),
        stderr: "",
      };
    },
  };
  const model = new StructuredCandidateModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["lookup_api"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Complete the admitted step.",
    input: "query contract API",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 4,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (candidate) => {
      assessmentCalls += 1;
      assert.match(candidate.output, /^合同备案记录查询 API has sysId input/);
      assert.match(candidate.output, /## 限制说明/);
      assert.match(candidate.output, new RegExp(caveat));
      const projected = candidate.projectedToolEvidence.find((item) => item.toolCallId === "lookup-1");
      assert.match(projected?.result ?? "", /api_catalog_result\/v1/);
      assert.match(projected?.result ?? "", /primary_api_id/);
      assert.match(projected?.result ?? "", /"deliveryCandidate"/);
      return { approved: true, feedback: "" };
    },
  });

  assert.match(result.output, /^合同备案记录查询 API has sysId input/);
  assert.match(result.output, /## 限制说明/);
  assert.match(result.output, new RegExp(caveat));
  assert.equal(executions, 1);
  assert.equal(model.calls, 1);
  assert.equal(assessmentCalls, 1);
  assert.equal(events.filter((event) => event.type === "candidate.structured_tool_detected").length, 1);
  assert.equal(events.filter((event) => event.type === "loop.convergence_requested").length, 0);
  assert.equal(events.filter((event) => event.type === "candidate.approved").length, 1);
});

test("an empty completion candidate is repaired within the same budgeted step", async () => {
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "collect_evidence",
    description: "Collect canonical evidence",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return { artifact: "ready", qa: "passed" };
    },
  };
  const model = new EmptyThenConvergedModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["collect_evidence"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Complete the admitted step.",
    input: "produce and verify the artifact",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 2,
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "artifact ready; QA passed; evidence: collect_evidence");
  assert.equal(executions, 1);
  assert.equal(model.calls, 3);
  assert.equal(events.filter((event) => event.type === "loop.convergence_requested").length, 1);
  assert.equal(events.filter((event) => event.type === "candidate.rejected").length, 1);
  assert.equal(events.filter((event) => event.type === "step.started").length, 2);
  assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
});

test("a length-truncated completion candidate receives bounded repair grace", async () => {
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["collect_evidence"]);
  const registry = new ToolRegistry([
    numberTool("collect_evidence", 1, (value) => value),
  ]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Complete concisely",
    input: "collect then summarize",
    model: new LengthCompletionRepairModel(),
    tools: registry,
    grant,
    maxSteps: 2,
    candidateRepairGraceSteps: 2,
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "short complete candidate");
  assert.equal(events.filter((event) => event.type === "candidate.rejected").length, 1);
  assert.equal(events.filter((event) => event.type === "loop.candidate_repair_grace_granted").length, 1);
});

test("a length-truncated execution turn with tools receives a forward-action repair directive", async () => {
  let calls = 0;
  const grant = makeGrant(["collect_evidence"]);
  const registry = new ToolRegistry([
    numberTool("collect_evidence", 1, (value) => value),
  ]);
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(request.tools.some((tool) => tool.name === "collect_evidence"), true);
        return {
          content: "",
          reasoningContent: "long internal draft ".repeat(1_000),
          finishReason: "length",
          toolCalls: [],
        };
      }
      if (calls === 2) {
        assert.equal(request.tools.some((tool) => tool.name === "collect_evidence"), true);
        assert.match(request.runtimeContext?.content ?? "", /one bounded forward action/);
        assert.doesNotMatch(request.runtimeContext?.content ?? "", /Do not request or emit tool calls/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "collect", name: "collect_evidence", arguments: { value: 1 } }],
        };
      }
      assert.deepEqual(request.tools, []);
      return { content: "evidence collected", finishReason: "stop", toolCalls: [] };
    },
  };

  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Collect evidence.",
    input: "collect then summarize",
    model,
    tools: registry,
    grant,
    maxSteps: 3,
    candidateRepairGraceSteps: 2,
    shouldConvergeAfterToolStep: () => ({ converge: true, reason: "evidence_ready" }),
  });

  assert.equal(result.output, "evidence collected");
  assert.equal(calls, 3);
});

test("prepare-stage argument rejection receives a schema repair directive", async () => {
  let calls = 0;
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write a file",
    inputSchema: { type: "object" },
    executionMode: "exclusive",
    replaySafe: false,
    parse: (value) => {
      const record = value as { mode?: string; overwrite?: boolean };
      if (record.mode !== undefined && record.overwrite !== undefined) {
        throw new AppError("BAD_REQUEST", "mode and overwrite cannot both be set; use exactly one", 400);
      }
      return value;
    },
    execute: async () => {
      executions += 1;
      return { path: "report.md", bytes: 6, sha256: "sha" };
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "write-invalid",
            name: "computer_write_file",
            arguments: { path: "report.md", content: "hello\n", mode: "create", overwrite: false },
          }],
        };
      }
      if (calls === 2) {
        assert.match(request.runtimeContext?.content ?? "", /runtime_tool_argument_repair/);
        assert.match(request.runtimeContext?.content ?? "", /prefer `mode` and remove the legacy `overwrite` field/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "write-valid",
            name: "computer_write_file",
            arguments: { path: "report.md", content: "hello\n", mode: "create" },
          }],
        };
      }
      assert.deepEqual(request.tools, []);
      return { content: "report written", finishReason: "stop", toolCalls: [] };
    },
  };
  const grant = makeGrant(["computer_write_file"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Write the report.",
    input: "write report",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 3,
    shouldConvergeAfterToolStep: () => ({ converge: true, reason: "artifact_written" }),
  });

  assert.equal(result.output, "report written");
  assert.equal(calls, 3);
  assert.equal(executions, 1);
});

test("repeated prepare-stage argument rejection stops before burning the step budget", async () => {
  let calls = 0;
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write a file",
    inputSchema: { type: "object" },
    executionMode: "exclusive",
    replaySafe: false,
    parse: (value) => {
      const record = value as { mode?: string; overwrite?: boolean };
      if (record.mode !== undefined && record.overwrite !== undefined) {
        throw new AppError("BAD_REQUEST", "mode and overwrite cannot both be set; use exactly one", 400);
      }
      return value;
    },
    execute: async () => {
      executions += 1;
      return { path: "report.md", bytes: 6, sha256: "sha" };
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls > 1) {
        assert.match(request.runtimeContext?.content ?? "", /runtime_tool_argument_repair/);
      }
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: `write-invalid-${calls}`,
          name: "computer_write_file",
          arguments: { path: "report.md", content: "hello\n", mode: "create", overwrite: false },
        }],
      };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["computer_write_file"]);
  await assert.rejects(
    () => runAgentLoop({
      runId: grant.runId,
      systemPrompt: "Write the report.",
      input: "write report",
      model,
      tools: new ToolRegistry([tool]),
      grant,
      maxSteps: 8,
      emit: (event) => { events.push(event); },
    }),
    (error: unknown) => error instanceof AppError
      && error.code === "RUN_LIMIT_EXCEEDED"
      && error.message.includes("without forward progress"),
  );

  assert.equal(calls, 3);
  assert.equal(executions, 0);
  const noProgress = events.filter((event) => event.type === "loop.no_progress");
  assert.equal(noProgress.length, 2);
  assert.equal(noProgress.at(-1)?.data.stalled, true);
});

test("a rejected assessed candidate grants bounded tool repair grace", async () => {
  let executions = 0;
  let assessments = 0;
  const tool: RuntimeTool<unknown> = {
    name: "read_evidence",
    description: "Read verification evidence",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return executions === 1 ? { report: "read" } : { evidence: "consistent" };
    },
  };
  const model = new CandidateRepairGraceModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["read_evidence"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Verify the report.",
    input: "verify",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 2,
    candidateRepairGraceSteps: 2,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (candidate) => {
      assessments += 1;
      return {
        approved: candidate.output.includes("evidence consistent"),
        feedback: "Need direct evidence comparison before approval.",
      };
    },
  });

  assert.equal(result.output, "report verified; evidence consistent");
  assert.equal(executions, 2);
  assert.equal(assessments, 2);
  assert.equal(events.filter((event) => event.type === "loop.candidate_repair_grace_granted").length, 1);
  assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
});

test("rejected completion candidates are not projected as prior assistant answers during repair", async () => {
  let calls = 0;
  const rejectedText = "最终用户可见结果即为上一条消息中的结构化分析总结";
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return { content: rejectedText, finishReason: "stop", toolCalls: [] };
      }
      assert.equal(
        request.messages.some((message) =>
          message.role === "assistant" && message.content.includes(rejectedText)
        ),
        false,
      );
      assert.match(request.runtimeContext?.content ?? "", /standalone replacement/);
      return { content: "完整总结：已基于当前证据直接交付分析结果。", finishReason: "stop", toolCalls: [] };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant([]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Summarize the uploaded source.",
    input: "分析总结外事业务在十五五 AI 领域的工作计划",
    model,
    tools: new ToolRegistry([]),
    grant,
    maxSteps: 3,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (candidate) => ({
      approved: !candidate.output.includes("上一条消息"),
      feedback: "Return the full user-facing summary without referencing a prior candidate.",
    }),
  });

  assert.equal(calls, 2);
  assert.equal(result.output, "完整总结：已基于当前证据直接交付分析结果。");
  assert.equal(result.messages.some((message) =>
    message.role === "assistant" && message.content.includes(rejectedText)
  ), false);
  assert.equal(events.filter((event) => event.type === "candidate.rejected").length, 1);
});

test("deferred validation candidate stops repair loop with a caveat", async () => {
  let executions = 0;
  let assessments = 0;
  const tool: RuntimeTool<unknown> = {
    name: "render_probe",
    description: "Probe renderer availability",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return executions === 1
        ? { fileChanges: [{ changeType: "created", path: "deck.pptx" }] }
        : { error: "renderer unavailable" };
    },
  };
  const model = new DeferredValidationModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["render_probe"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Build and validate.",
    input: "build deck",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 2,
    candidateRepairGraceSteps: 4,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (candidate) => {
      assessments += 1;
      return assessments === 1
        ? { approved: false, feedback: "Renderer missing; try one probe." }
        : {
          approved: false,
          feedback: "Renderer remains unavailable; leave visual validation to the user.",
          deferredValidation: true,
        };
    },
  });

  assert.equal(result.deferredValidation, true);
  assert.match(result.output, /leave visual validation to the user/);
  assert.equal(executions, 2);
  assert.equal(assessments, 2);
  assert.equal(events.filter((event) => event.type === "candidate.validation_deferred").length, 1);
  assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
});

test("evidence-boundary candidate stops repair loop with a caveat", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async () => {
      calls += 1;
      return {
        content: "Verified metadata is available, but full text remains unverified because the source returned HTTP 403.",
        finishReason: "stop",
        toolCalls: [],
      };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant([]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Research public sources.",
    input: "research",
    model,
    tools: new ToolRegistry([]),
    grant,
    maxSteps: 3,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async () => ({
      approved: false,
      feedback: "Proceed only as a limited evidence-boundary delivery.",
      evidenceBoundary: true,
    }),
  });

  assert.equal(calls, 1);
  assert.equal(result.completionCaveat?.reason, "evidence_boundary");
  assert.match(result.output, /Evidence boundary note/);
  assert.equal(events.filter((event) => event.type === "candidate.evidence_boundary_accepted").length, 1);
  assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
});

test("candidate repair assessment limit accepts the latest output with a caveat", async () => {
  let calls = 0;
  let assessments = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async () => {
      calls += 1;
      return { content: `candidate ${calls}`, finishReason: "stop", toolCalls: [] };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant([]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Produce the candidate.",
    input: "produce",
    model,
    tools: new ToolRegistry([]),
    grant,
    maxSteps: 3,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async () => {
      assessments += 1;
      return { approved: false, feedback: "Quality issue remained after repair." };
    },
  });

  assert.equal(calls, 3);
  assert.equal(assessments, 3);
  assert.equal(result.completionCaveat?.reason, "repair_limit");
  assert.match(result.output, /Repair caveat/);
  assert.doesNotMatch(result.output, /Quality issue remained after repair/);
  assert.equal(events.filter((event) => event.type === "candidate.completion_caveated").length, 1);
  assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
});

test("candidate repair assessment limit can be blocked for unmet prerequisite criteria", async () => {
  let calls = 0;
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async () => {
      calls += 1;
      return { content: `missing input candidate ${calls}`, finishReason: "stop", toolCalls: [] };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant([]);

  await assert.rejects(
    () => runAgentLoop({
      runId: grant.runId,
      systemPrompt: "Read the required source file.",
      input: "read missing source",
      model,
      tools: new ToolRegistry([]),
      grant,
      maxSteps: 3,
      emit: (event) => { events.push(event); },
      evaluateCandidate: async () => ({
        approved: false,
        feedback: "No source file was found, so no success criteria are satisfied.",
        allowRepairLimitCompletion: false,
      }),
    }),
    (error) => error instanceof Error && /cannot be accepted with a repair-limit caveat/.test(error.message),
  );

  assert.equal(calls, 3);
  assert.equal(events.filter((event) => event.type === "candidate.repair_limit_blocked").length, 1);
  assert.equal(events.filter((event) => event.type === "candidate.completion_caveated").length, 0);
});

test("a mid-work model is granted convergence grace steps to reach real completion", async () => {
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "render",
    description: "Render the artifact",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return { rendered: true };
    },
  };
  const model = new GraceCompletionModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["render"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Render until done.",
    input: "render",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 2,
    convergenceGraceSteps: 2,
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "rendered artifact");
  assert.equal(executions, 2);
  assert.equal(events.filter((event) => event.type === "loop.convergence_requested").length, 0);
  assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
});

test("distinct tool calls keep extending grace while the model makes progress", async () => {
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "work",
    description: "Do one unit of work",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return "ok";
    },
  };
  const model = new DistinctGraceModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["work"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Work until done.",
    input: "work",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 2,
    convergenceGraceSteps: 3,
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "done");
  assert.equal(executions, 3);
  assert.equal(events.filter((event) => event.type === "loop.no_progress").length, 0);
  assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
});

test("artifact grace rejects excessive read-only exploration and redirects to evidence-producing tools", async () => {
  const executions: string[] = [];
  let calls = 0;
  const readTool: RuntimeTool<unknown> = {
    name: "computer_read_file",
    description: "Read a file",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`read:${JSON.stringify(input)}`);
      return "read";
    },
  };
  const searchTool: RuntimeTool<unknown> = {
    name: "computer_search_text",
    description: "Search text",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`search:${JSON.stringify(input)}`);
      return "matches";
    },
  };
  const writeTool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write artifact source",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`write:${JSON.stringify(input)}`);
      return JSON.stringify({ path: "outline.json", fileChanges: [{ path: "outline.json", changeType: "created" }] });
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "read-brief", name: "computer_read_file", arguments: { path: "agent_brief.md" } }],
        };
      }
      if (calls === 2) {
        assert.match(request.runtimeContext?.content ?? "", /Do not reread just-written artifact content/);
        assert.match(request.runtimeContext?.content ?? "", /complete but lacks required acceptance evidence/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "read-schema", name: "computer_read_file", arguments: { path: "references/outline_schema.md" } }],
        };
      }
      if (calls === 3) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "search-variant", name: "computer_search_text", arguments: { path: "references/outline_schema.md", query: "variant" } }],
        };
      }
      if (calls === 4) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "search-table", name: "computer_search_text", arguments: { path: "references/outline_schema.md", query: "table" } }],
        };
      }
      if (calls === 5) {
        assert.match(request.runtimeContext?.content ?? "", /runtime_tool_progress_repair/);
        assert.match(request.runtimeContext?.content ?? "", /Required evidence kinds: artifact_path, artifact_acceptance/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "write-outline", name: "computer_write_file", arguments: { path: "outline.json", content: "{}" } }],
        };
      }
      return { content: "artifact source authored", finishReason: "stop", toolCalls: [] };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["computer_read_file", "computer_search_text", "computer_write_file"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Produce an artifact.",
    input: "make deck",
    model,
    tools: new ToolRegistry([readTool, searchTool, writeTool]),
    grant,
    maxSteps: 1,
    convergenceGraceSteps: 6,
    progressPolicy: artifactStepToolProgressPolicy(["artifact_path", "artifact_acceptance"]),
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "artifact source authored");
  assert.equal(calls, 6);
  assert.deepEqual(executions.map((entry) => entry.split(":", 1)[0]), ["read", "read", "search", "write"]);
  const noProgress = events.filter((event) => event.type === "loop.no_progress");
  assert.equal(noProgress.length, 1);
  assert.equal(noProgress[0]?.data.stalled, false);
  assert.equal(events.filter((event) => event.type === "loop.limit_exceeded").length, 0);
});

test("artifact progress policy rejects excessive read-only exploration before grace", async () => {
  const executions: string[] = [];
  let calls = 0;
  const readTool: RuntimeTool<unknown> = {
    name: "computer_read_file",
    description: "Read a file",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`read:${JSON.stringify(input)}`);
      return JSON.stringify({ path: "reference.md", content: "reference" });
    },
  };
  const writeTool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write the artifact",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`write:${JSON.stringify(input)}`);
      return JSON.stringify({ path: "outline.json", fileChanges: [{ path: "outline.json", changeType: "created" }] });
    },
  };
  const verifyTool: RuntimeTool<unknown> = {
    name: "verify_artifact_acceptance",
    description: "Verify artifact acceptance",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`verify:${JSON.stringify(input)}`);
      return JSON.stringify({
        artifactPath: "outline.json",
        verdict: "accepted",
        evidenceKinds: {
          satisfied: ["artifact_acceptance"],
          caveated: [],
          failed: [],
        },
      });
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls <= 4) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: `read-${calls}`,
            name: "computer_read_file",
            arguments: { path: `references/${calls}.md` },
          }],
        };
      }
      if (calls === 5) {
        assert.match(request.runtimeContext?.content ?? "", /runtime_tool_progress_repair/);
        assert.match(request.runtimeContext?.content ?? "", /bounded exploration budget/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "write-artifact", name: "computer_write_file", arguments: { path: "outline.json", content: "{}" } }],
        };
      }
      if (calls === 6) {
        const semanticState = runtimeStepSemanticState(request.runtimeContext?.content ?? "");
        assert.equal(semanticState.workProduct.status, "deliverable_available");
        assert.equal(semanticState.nextAction, "verify_existing_artifact");
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "verify-artifact", name: "verify_artifact_acceptance", arguments: { artifactPath: "outline.json" } }],
        };
      }
      return { content: "artifact source authored", finishReason: "stop", toolCalls: [] };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["computer_read_file", "computer_write_file", "verify_artifact_acceptance"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Produce an artifact.",
    input: "make deck",
    model,
    tools: new ToolRegistry([readTool, writeTool, verifyTool]),
    grant,
    maxSteps: 10,
    convergenceGraceSteps: 0,
    progressPolicy: artifactStepToolProgressPolicy(["artifact_path", "artifact_acceptance"]),
    shouldConvergeAfterToolStep: (context) => ({
      converge: context.toolEvidence.some((item) => item.toolName === "verify_artifact_acceptance" && !item.isError),
      reason: "artifact_acceptance_observed",
    }),
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (candidate) => ({
      approved: candidate.output.includes("Done and verified")
        && candidate.toolEvidence.some((item) => item.toolName === "verify_artifact_acceptance" && !item.isError),
      feedback: "",
    }),
  });

  assert.equal(result.output, "Done and verified for the current step.\nArtifact: outline.json.");
  assert.deepEqual(executions.map((entry) => entry.split(":", 1)[0]), ["read", "read", "read", "write", "verify"]);
  const rejected = events.find((event) =>
    event.type === "tool.rejected" && event.data.toolCallId === "read-4"
  );
  assert.equal(rejected?.data.reason, "Read-only exploratory tool calls exceeded the artifact step primary budget");
  assert.equal(events.filter((event) => event.type === "loop.limit_exceeded").length, 0);
});

test("artifact progress policy redirects read-only exploration to acceptance after artifact evidence", async () => {
  const executions: string[] = [];
  let calls = 0;
  const writeTool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write the artifact",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`write:${JSON.stringify(input)}`);
      return JSON.stringify({
        path: "report.html",
        artifactReceipt: {
          schema: "agentloop.artifactReceipt/v1",
          artifact: { path: "report.html", kind: "html" },
          evidenceKinds: {
            satisfied: ["artifact_path", "artifact_non_empty"],
            caveated: [],
            failed: [],
          },
        },
      });
    },
  };
  const readTool: RuntimeTool<unknown> = {
    name: "computer_read_file",
    description: "Read artifact",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`read:${JSON.stringify(input)}`);
      return "artifact contents";
    },
  };
  const verifyTool: RuntimeTool<unknown> = {
    name: "verify_artifact_acceptance",
    description: "Verify artifact acceptance",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`verify:${JSON.stringify(input)}`);
      return JSON.stringify({
        schema: "agentloop.artifactAcceptance/v1",
        artifact: { path: "report.html", kind: "html" },
        verdict: "accepted",
        evidenceKinds: {
          satisfied: ["artifact_acceptance", "artifact_openable", "format_matches_request"],
          caveated: [],
          failed: [],
        },
      });
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "write-report",
            name: "computer_write_file",
            arguments: { path: "report.html", content: "<html></html>" },
          }],
        };
      }
      if (calls === 2) {
        const runtimeContext = request.runtimeContext?.content ?? "";
        const semanticState = runtimeStepSemanticState(runtimeContext);
        assert.equal(semanticState.schema, "agentloop.runtimeStepEvidenceState/v1");
        assert.equal(semanticState.nextAction, "verify_existing_artifact");
        assert.deepEqual(semanticState.knownArtifacts.map((artifact) => artifact.path), ["report.html"]);
        assert.equal(semanticState.missingRequiredEvidenceKinds.includes("artifact_acceptance"), true);
        assert.deepEqual(semanticState.evidenceProducingToolNames, ["verify_artifact_acceptance"]);
        assert.deepEqual(semanticState.exploratoryToolNames, []);
        assert.match(runtimeContext, /Verify the artifact next; do not reread the same artifact merely to decide whether to verify it\./);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "read-report",
            name: "computer_read_file",
            arguments: { path: "report.html" },
          }],
        };
      }
      if (calls === 3) {
        assert.match(request.runtimeContext?.content ?? "", /runtime_artifact_acceptance_repair/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "verify-report",
            name: "verify_artifact_acceptance",
            arguments: { artifactPath: "report.html" },
          }],
        };
      }
      assert.deepEqual(request.tools, []);
      return { content: "report.html accepted", finishReason: "stop", toolCalls: [] };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["computer_write_file", "computer_read_file", "verify_artifact_acceptance"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Produce and verify an artifact.",
    input: "make report",
    model,
    tools: new ToolRegistry([writeTool, readTool, verifyTool]),
    grant,
    maxSteps: 4,
    convergenceGraceSteps: 0,
    progressPolicy: artifactStepToolProgressPolicy(["artifact_path", "artifact_acceptance"]),
    shouldConvergeAfterToolStep: (context) => ({
      converge: context.toolEvidence.some((item) => item.toolName === "verify_artifact_acceptance" && !item.isError),
      reason: "artifact_acceptance_observed",
    }),
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "report.html accepted");
  assert.deepEqual(executions.map((entry) => entry.split(":", 1)[0]), ["write", "verify"]);
  const rejected = events.find((event) =>
    event.type === "tool.rejected" && event.data.toolCallId === "read-report"
  );
  assert.equal(rejected?.data.reason, "Artifact path evidence exists but artifact acceptance is still missing");
  assert.equal(events.filter((event) => event.type === "loop.limit_exceeded").length, 0);
});

test("artifact execution keeps multi-tool provider choice auto while Runtime evidence is missing", async () => {
  const executions: string[] = [];
  let calls = 0;
  const writeTool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write the artifact",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`write:${JSON.stringify(input)}`);
      return JSON.stringify({
        path: "poster.png",
        artifactReceipt: {
          artifact: { path: "poster.png", artifactKind: "image" },
          evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty", "format_matches_request"] },
        },
      });
    },
  };
  const verifyTool: RuntimeTool<unknown> = {
    name: "verify_artifact_acceptance",
    description: "Verify artifact acceptance",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`verify:${JSON.stringify(input)}`);
      return JSON.stringify({
        artifactPath: "poster.png",
        verdict: "accepted",
        evidenceKinds: {
          satisfied: ["artifact_acceptance", "artifact_openable", "format_matches_request"],
          caveated: [],
          failed: [],
        },
      });
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(request.toolChoice, "auto");
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "write-poster", name: "computer_write_file", arguments: { path: "poster.png" } }],
        };
      }
      if (calls === 2) {
        assert.equal(request.toolChoice, "auto");
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "verify-poster", name: "verify_artifact_acceptance", arguments: { artifactPath: "poster.png" } }],
        };
      }
      assert.equal(request.toolChoice, undefined);
      assert.deepEqual(request.tools, []);
      return { content: "Done and verified for the current step.\nArtifact: poster.png.", finishReason: "stop", toolCalls: [] };
    },
  };
  const grant = makeGrant(["computer_write_file", "verify_artifact_acceptance"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Produce and verify an image artifact.",
    input: "create poster",
    model,
    tools: new ToolRegistry([writeTool, verifyTool]),
    grant,
    maxSteps: 4,
    convergenceGraceSteps: 0,
    progressPolicy: artifactStepToolProgressPolicy(
      ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"],
      { expectedArtifactKind: "image" },
    ),
    shouldConvergeAfterToolStep: (context) => ({
      converge: context.toolEvidence.some((item) => item.toolName === "verify_artifact_acceptance" && !item.isError),
      reason: "artifact_acceptance_observed",
    }),
  });

  assert.equal(result.output, "Done and verified for the current step.\nArtifact: poster.png.");
  assert.deepEqual(executions.map((entry) => entry.split(":", 1)[0]), ["write", "verify"]);
});

test("artifact progress policy treats generated build scripts as source until a deliverable exists", async () => {
  const executions: string[] = [];
  let calls = 0;
  const writeTool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write generated files",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`write:${JSON.stringify(input)}`);
      return JSON.stringify({
        path: "build_html_from_markdown.py",
        artifactReceipt: {
          schema: "agentloop.artifactReceipt/v1",
          artifact: { path: "build_html_from_markdown.py", bytes: 120, sha256: "script-hash" },
          evidenceKinds: {
            satisfied: ["artifact_path", "artifact_non_empty"],
            caveated: [],
            failed: [],
          },
        },
      });
    },
  };
  const readTool: RuntimeTool<unknown> = {
    name: "computer_read_file",
    description: "Read generated source",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`read:${JSON.stringify(input)}`);
      return "source";
    },
  };
  const runTool: RuntimeTool<unknown> = {
    name: "computer_run_command",
    description: "Run build command",
    inputSchema: { type: "object" },
    executionMode: "exclusive",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`run:${JSON.stringify(input)}`);
      return JSON.stringify({
        exitCode: 0,
        stdout: "report.html\n",
        artifactReceipt: {
          schema: "agentloop.artifactReceipt/v1",
          artifact: { path: "report.html", kind: "html", bytes: 240, sha256: "html-hash" },
          evidenceKinds: {
            satisfied: ["artifact_path", "artifact_non_empty"],
            caveated: [],
            failed: [],
          },
        },
      });
    },
  };
  const verifyTool: RuntimeTool<unknown> = {
    name: "verify_artifact_acceptance",
    description: "Verify the final artifact",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`verify:${JSON.stringify(input)}`);
      return JSON.stringify({
        artifactPath: "report.html",
        verdict: "accepted",
        evidenceKinds: {
          satisfied: ["artifact_acceptance", "artifact_openable", "format_matches_request"],
          caveated: [],
          failed: [],
        },
      });
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "write-script",
            name: "computer_write_file",
            arguments: { path: "build_html_from_markdown.py", content: "print('report.html')" },
          }],
        };
      }
      if (calls === 2) {
        const semanticState = runtimeStepSemanticState(request.runtimeContext?.content ?? "");
        assert.equal(semanticState.nextAction, "produce_artifact");
        assert.deepEqual(semanticState.knownArtifacts, []);
        assert.deepEqual(semanticState.processArtifacts.map((artifact) => artifact.path), ["build_html_from_markdown.py"]);
        assert.ok(semanticState.evidenceProducingToolNames.includes("computer_run_command"));
        assert.match(request.runtimeContext?.content ?? "", /Process artifacts already exist/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "reread-script",
            name: "computer_read_file",
            arguments: { path: "build_html_from_markdown.py" },
          }],
        };
      }
      if (calls === 3) {
        assert.match(request.runtimeContext?.content ?? "", /runtime_artifact_source_production_repair/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "run-build",
            name: "computer_run_command",
            arguments: { command: "python3 build_html_from_markdown.py" },
          }],
        };
      }
      if (calls === 4) {
        const semanticState = runtimeStepSemanticState(request.runtimeContext?.content ?? "");
        assert.equal(semanticState.nextAction, "verify_existing_artifact");
        assert.deepEqual(semanticState.knownArtifacts.map((artifact) => artifact.path), ["report.html"]);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{
            id: "verify-report",
            name: "verify_artifact_acceptance",
            arguments: { artifactPath: "report.html", artifactKind: "html" },
          }],
        };
      }
      return { content: "report.html accepted", finishReason: "stop", toolCalls: [] };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["computer_write_file", "computer_read_file", "computer_run_command", "verify_artifact_acceptance"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Produce and verify an HTML artifact.",
    input: "convert markdown to html",
    model,
    tools: new ToolRegistry([writeTool, readTool, runTool, verifyTool]),
    grant,
    maxSteps: 6,
    convergenceGraceSteps: 0,
    progressPolicy: artifactStepToolProgressPolicy(["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"]),
    shouldConvergeAfterToolStep: (context) => ({
      converge: context.toolEvidence.some((item) => item.toolName === "verify_artifact_acceptance" && !item.isError),
      reason: "artifact_acceptance_observed",
    }),
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "report.html accepted");
  assert.deepEqual(executions.map((entry) => entry.split(":", 1)[0]), ["write", "run", "verify"]);
  const rejected = events.find((event) =>
    event.type === "tool.rejected" && event.data.toolCallId === "reread-script"
  );
  assert.equal(rejected?.data.reason, "Intermediate artifact/source evidence exists but final artifact evidence is still missing");
  assert.equal(events.filter((event) => event.type === "loop.limit_exceeded").length, 0);
});

test("artifact progress policy treats mismatched typed intermediates as source until the requested artifact kind exists", async () => {
  const executions: string[] = [];
  let calls = 0;
  const writeTool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write generated files",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      const path = String((input as { path: string }).path);
      executions.push(`write:${path}`);
      return JSON.stringify({
        path,
        artifactReceipt: {
          schema: "agentloop.artifactReceipt/v1",
          artifact: { path, bytes: 120, sha256: `${path}-hash` },
          evidenceKinds: {
            satisfied: ["artifact_path", "artifact_non_empty"],
            caveated: [],
            failed: [],
          },
        },
      });
    },
  };
  const readJsonTool: RuntimeTool<unknown> = {
    name: "computer_read_json",
    description: "Read intermediate spec",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`read-json:${JSON.stringify(input)}`);
      return JSON.stringify({ ok: true });
    },
  };
  const runTool: RuntimeTool<unknown> = {
    name: "computer_run_command",
    description: "Render requested image",
    inputSchema: { type: "object" },
    executionMode: "exclusive",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`run:${JSON.stringify(input)}`);
      return JSON.stringify({
        exitCode: 0,
        stdout: "poster.png\n",
        artifactReceipt: {
          schema: "agentloop.artifactReceipt/v1",
          artifact: { path: "poster.png", bytes: 240, sha256: "poster-hash" },
          evidenceKinds: {
            satisfied: ["artifact_path", "artifact_non_empty"],
            caveated: [],
            failed: [],
          },
        },
      });
    },
  };
  const verifyTool: RuntimeTool<unknown> = {
    name: "verify_artifact_acceptance",
    description: "Verify the requested image",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`verify:${JSON.stringify(input)}`);
      return JSON.stringify({
        artifactPath: "poster.png",
        verdict: "accepted",
        evidenceKinds: {
          satisfied: ["artifact_acceptance", "artifact_openable", "format_matches_request"],
          caveated: [],
          failed: [],
        },
      });
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "write-philosophy",
              name: "computer_write_file",
              arguments: { path: "design-philosophy.md", content: "# direction" },
            },
            {
              id: "write-spec",
              name: "computer_write_file",
              arguments: { path: "poster-spec.json", content: "{\"title\":\"National Day\"}" },
            },
          ],
        };
      }
      if (calls === 2) {
        const semanticState = runtimeStepSemanticState(request.runtimeContext?.content ?? "");
        assert.equal(semanticState.nextAction, "produce_artifact");
        assert.deepEqual(semanticState.knownArtifacts, []);
        assert.deepEqual(semanticState.processArtifacts.map((artifact) => artifact.path), [
          "design-philosophy.md",
          "poster-spec.json",
        ]);
        assert.ok(semanticState.evidenceProducingToolNames.includes("computer_run_command"));
        assert.match(request.runtimeContext?.content ?? "", /Process artifacts already exist/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "reread-spec", name: "computer_read_json", arguments: { path: "poster-spec.json" } }],
        };
      }
      if (calls === 3) {
        assert.match(request.runtimeContext?.content ?? "", /runtime_artifact_source_production_repair/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "rewrite-philosophy",
              name: "computer_write_file",
              arguments: { path: "design-philosophy.md", content: "# revised direction", mode: "overwrite" },
            },
            {
              id: "rewrite-spec",
              name: "computer_write_file",
              arguments: { path: "poster-spec.json", content: "{\"title\":\"Revised National Day\"}", mode: "overwrite" },
            },
          ],
        };
      }
      if (calls === 4) {
        assert.match(request.runtimeContext?.content ?? "", /runtime_artifact_source_production_repair/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "render-poster", name: "computer_run_command", arguments: { command: "render poster-spec.json" } }],
        };
      }
      if (calls === 5) {
        const semanticState = runtimeStepSemanticState(request.runtimeContext?.content ?? "");
        assert.equal(semanticState.nextAction, "verify_existing_artifact");
        assert.deepEqual(semanticState.knownArtifacts.map((artifact) => artifact.path), ["poster.png"]);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "verify-poster", name: "verify_artifact_acceptance", arguments: { artifactPath: "poster.png", artifactKind: "image" } }],
        };
      }
      return { content: "poster.png accepted", finishReason: "stop", toolCalls: [] };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["computer_write_file", "computer_read_json", "computer_run_command", "verify_artifact_acceptance"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Produce and verify an image artifact.",
    input: "create a poster image",
    model,
    tools: new ToolRegistry([writeTool, readJsonTool, runTool, verifyTool]),
    grant,
    maxSteps: 7,
    convergenceGraceSteps: 0,
    progressPolicy: artifactStepToolProgressPolicy(
      ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"],
      { expectedArtifactKind: "image" },
    ),
    shouldConvergeAfterToolStep: (context) => ({
      converge: context.toolEvidence.some((item) => item.toolName === "verify_artifact_acceptance" && !item.isError),
      reason: "artifact_acceptance_observed",
    }),
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "poster.png accepted");
  assert.deepEqual(executions.map((entry) => entry.split(":", 1)[0]), ["write", "write", "run", "verify"]);
  const rejected = events.find((event) =>
    event.type === "tool.rejected" && event.data.toolCallId === "reread-spec"
  );
  assert.equal(rejected?.data.reason, "Intermediate artifact/source evidence exists but final artifact evidence is still missing");
  const rejectedRewrite = events.find((event) =>
    event.type === "tool.rejected" && event.data.toolCallId === "rewrite-spec"
  );
  assert.equal(rejectedRewrite?.data.reason, "Intermediate artifact/source evidence exists but final artifact evidence is still missing");
  assert.equal(events.some((event) =>
    (event.type === "tool.effect_pending" || event.type === "tool.dispatched" || event.type === "tool.completed")
    && event.data.toolCallId === "rewrite-spec"
  ), false);
  assert.equal(events.filter((event) => event.type === "loop.limit_exceeded").length, 0);
});

test("artifact progress policy allows a targeted rebase read after patch precondition failure", async () => {
  const executions: string[] = [];
  let calls = 0;
  const writeTool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write generated files",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      const path = String((input as { path: string }).path);
      executions.push(`write:${path}`);
      return JSON.stringify({
        path,
        artifactReceipt: {
          schema: "agentloop.artifactReceipt/v1",
          artifact: { path, bytes: 120, sha256: `${path}-hash`, artifactKind: "code" },
          evidenceKinds: {
            satisfied: ["artifact_path", "artifact_non_empty"],
            caveated: [],
            failed: [],
          },
        },
      });
    },
  };
  const patchTool: RuntimeTool<unknown> = {
    name: "computer_patch_file",
    description: "Patch generated source",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`patch:${JSON.stringify(input)}`);
      throw new AppError("NOT_FOUND", "oldText was not found in the patch target", 404);
    },
  };
  const readTool: RuntimeTool<unknown> = {
    name: "computer_read_file",
    description: "Read generated source",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`read:${JSON.stringify(input)}`);
      return JSON.stringify({ path: "poster-spec.json", content: "{\"texture\":0.18}", sha256: "current" });
    },
  };
  const runTool: RuntimeTool<unknown> = {
    name: "computer_run_command",
    description: "Render requested image",
    inputSchema: { type: "object" },
    executionMode: "exclusive",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`run:${JSON.stringify(input)}`);
      return JSON.stringify({
        exitCode: 0,
        stdout: "poster.png\n",
        artifactReceipt: {
          schema: "agentloop.artifactReceipt/v1",
          artifact: { path: "poster.png", bytes: 240, sha256: "poster-hash", artifactKind: "image" },
          evidenceKinds: {
            satisfied: ["artifact_path", "artifact_non_empty"],
            caveated: [],
            failed: [],
          },
        },
      });
    },
  };
  const verifyTool: RuntimeTool<unknown> = {
    name: "verify_artifact_acceptance",
    description: "Verify the requested image",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`verify:${JSON.stringify(input)}`);
      return JSON.stringify({
        artifactPath: "poster.png",
        verdict: "accepted",
        evidenceKinds: {
          satisfied: ["artifact_acceptance", "artifact_openable", "format_matches_request"],
          caveated: [],
          failed: [],
        },
      });
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "write-spec", name: "computer_write_file", arguments: { path: "poster-spec.json", content: "{\"texture\":0.18}" } }],
        };
      }
      if (calls === 2) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "stale-patch", name: "computer_patch_file", arguments: { path: "poster-spec.json", oldText: "{\"texture\":0.35}", newText: "{\"texture\":0.2}" } }],
        };
      }
      if (calls === 3) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "rebase-read", name: "computer_read_file", arguments: { path: "poster-spec.json", offset: 1, limit: 20 } }],
        };
      }
      if (calls === 4) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "rewrite-spec", name: "computer_write_file", arguments: { path: "poster-spec.json", content: "{\"texture\":0.2}", mode: "overwrite" } }],
        };
      }
      if (calls === 5) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "render-poster", name: "computer_run_command", arguments: { command: "render poster-spec.json" } }],
        };
      }
      if (calls === 6) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "verify-poster", name: "verify_artifact_acceptance", arguments: { artifactPath: "poster.png", artifactKind: "image" } }],
        };
      }
      return { content: "poster.png accepted", finishReason: "stop", toolCalls: [] };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["computer_write_file", "computer_patch_file", "computer_read_file", "computer_run_command", "verify_artifact_acceptance"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Produce and verify an image artifact.",
    input: "create a poster image",
    model,
    tools: new ToolRegistry([writeTool, patchTool, readTool, runTool, verifyTool]),
    grant,
    maxSteps: 8,
    convergenceGraceSteps: 0,
    progressPolicy: artifactStepToolProgressPolicy(
      ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"],
      { expectedArtifactKind: "image" },
    ),
    shouldConvergeAfterToolStep: (context) => ({
      converge: context.toolEvidence.some((item) => item.toolName === "verify_artifact_acceptance" && !item.isError),
      reason: "artifact_acceptance_observed",
    }),
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "poster.png accepted");
  assert.deepEqual(executions.map((entry) => entry.split(":", 1)[0]), ["write", "patch", "read", "write", "run", "verify"]);
  assert.equal(events.some((event) =>
    event.type === "tool.completed" && event.data.toolCallId === "rebase-read"
  ), true);
  assert.equal(events.some((event) =>
    event.type === "tool.rejected" && event.data.toolCallId === "rebase-read"
  ), false);
});

test("artifact diagnostics reject a reread and redirect to source repair", async () => {
  const executions: string[] = [];
  let calls = 0;
  const runTool: RuntimeTool<unknown> = {
    name: "computer_run_command",
    description: "Run validator",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`run:${JSON.stringify(input)}`);
      return JSON.stringify({
        exitCode: 0,
        stdout: "",
        stderr: "outline validation failed: Expected ',' or ']' after array element in JSON at position 10377 (line 324 column 13)",
        fileChanges: [],
      });
    },
  };
  const readTool: RuntimeTool<unknown> = {
    name: "computer_read_file",
    description: "Read source",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`read:${JSON.stringify(input)}`);
      return "line 324: \"避免\"度量为了度量\"";
    },
  };
  const writeTool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write repaired source",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`write:${JSON.stringify(input)}`);
      return JSON.stringify({ path: "outline.json", fileChanges: [{ path: "outline.json", changeType: "modified" }] });
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "validate-outline", name: "computer_run_command", arguments: { command: "validate" } }],
        };
      }
      if (calls === 2) {
        assert.match(request.runtimeContext?.content ?? "", /runtime_execution_feedback/);
        assert.match(request.runtimeContext?.content ?? "", /Read-only exploration is no longer useful; patch, run, or verify next\./);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "read-error", name: "computer_read_file", arguments: { path: "outline.json", offset: 320, limit: 10 } }],
        };
      }
      if (calls === 3) {
        assert.match(request.runtimeContext?.content ?? "", /runtime_validation_diagnostic_repair/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "write-repair", name: "computer_write_file", arguments: { path: "outline.json", content: "{\"slides\":[]}" } }],
        };
      }
      return { content: "source repaired", finishReason: "stop", toolCalls: [] };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["computer_run_command", "computer_read_file", "computer_write_file"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Repair artifact source.",
    input: "fix outline",
    model,
    tools: new ToolRegistry([runTool, readTool, writeTool]),
    grant,
    maxSteps: 10,
    convergenceGraceSteps: 0,
    progressPolicy: artifactStepToolProgressPolicy(["artifact_path", "artifact_acceptance"]),
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "source repaired");
  assert.deepEqual(executions.map((entry) => entry.split(":", 1)[0]), ["run", "write"]);
  const rejected = events.find((event) =>
    event.type === "tool.rejected" && event.data.toolName === "computer_read_file"
  );
  assert.equal(rejected?.data.reason, "Read-only exploratory tool calls are not allowed after an actionable artifact diagnostic");
  assert.equal(events.filter((event) => event.type === "loop.limit_exceeded").length, 0);
});

test("artifact diagnostics do not allow a read-only grace turn after a concrete diagnostic", async () => {
  const executions: string[] = [];
  let calls = 0;
  const runTool: RuntimeTool<unknown> = {
    name: "computer_run_command",
    description: "Run validator",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`run:${JSON.stringify(input)}`);
      return JSON.stringify({
        exitCode: 0,
        stdout: "",
        stderr: "outline validation failed: Expected ',' or ']' after array element in JSON at position 10377 (line 324 column 13)",
        fileChanges: [],
      });
    },
  };
  const readJsonTool: RuntimeTool<unknown> = {
    name: "computer_read_json",
    description: "Read structured artifact",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`read-json:${JSON.stringify(input)}`);
      return JSON.stringify({ path: "outline.json", data: [] });
    },
  };
  const writeTool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write repaired source",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`write:${JSON.stringify(input)}`);
      return JSON.stringify({ path: "outline.json", fileChanges: [{ path: "outline.json", changeType: "modified" }] });
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "validate-outline", name: "computer_run_command", arguments: { command: "validate" } }],
        };
      }
      if (calls === 2) {
        const runtimeContext = request.runtimeContext?.content ?? "";
        assert.match(runtimeContext, /runtime_execution_feedback/);
        assert.match(runtimeContext, /Read-only exploration is no longer useful; patch, run, or verify next\./);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "read-json", name: "computer_read_json", arguments: { path: "outline.json" } }],
        };
      }
      if (calls === 3) {
        assert.match(request.runtimeContext?.content ?? "", /runtime_validation_diagnostic_repair/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "write-repair", name: "computer_write_file", arguments: { path: "outline.json", content: "{\"slides\":[]}" } }],
        };
      }
      return { content: "source repaired", finishReason: "stop", toolCalls: [] };
    },
  };
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["computer_run_command", "computer_read_json", "computer_write_file"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Repair artifact source.",
    input: "fix outline",
    model,
    tools: new ToolRegistry([runTool, readJsonTool, writeTool]),
    grant,
    maxSteps: 5,
    convergenceGraceSteps: 0,
    progressPolicy: artifactStepToolProgressPolicy(["artifact_path", "artifact_acceptance"]),
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "source repaired");
  assert.deepEqual(executions.map((entry) => entry.split(":", 1)[0]), ["run", "write"]);
  const rejected = events.find((event) =>
    event.type === "tool.rejected" && event.data.toolCallId === "read-json"
  );
  assert.equal(rejected?.data.reason, "Read-only exploratory tool calls are not allowed after an actionable artifact diagnostic");
  assert.equal(events.filter((event) => event.type === "loop.limit_exceeded").length, 0);
});

test("tool evidence can queue an early convergence turn before the hard limit", async () => {
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "render",
    description: "Render the artifact",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return { path: "poster.png", status: "ready" };
    },
  };
  const model = new EarlyConvergenceModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["render"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Render then submit a candidate.",
    input: "render",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 12,
    convergenceGraceSteps: 8,
    emit: (event) => { events.push(event); },
    shouldConvergeAfterToolStep: (context) => ({
      converge: context.toolEvidence.some((item) => item.toolName === "render" && item.result.includes("poster.png")),
      reason: "artifact_ready",
    }),
  });

  assert.equal(result.output, "poster artifact ready; evidence: render");
  assert.equal(executions, 1);
  assert.equal(model.calls, 2);
  assert.equal(events.filter((event) => event.type === "loop.convergence_queued").length, 1);
  const requested = events.find((event) => event.type === "loop.convergence_requested");
  assert.equal(requested?.data.reason, "artifact_ready");
  assert.equal(events.some((event) => event.type === "loop.limit_exceeded"), false);
});

test("next model turn receives explicit execution feedback for failures and file changes", async () => {
  let calls = 0;
  const tool: RuntimeTool<unknown> = {
    name: "run_step",
    description: "Run one scripted step",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, value) => {
      const action = (value as { action?: string }).action;
      if (action === "fail") {
        return {
          exitCode: 2,
          stdout: "",
          stderr: "No such file or directory: input.pdf",
          fileChanges: [],
        };
      }
      return {
        exitCode: 0,
        stdout: "Successfully exported 26 records to output.xlsx",
        stderr: "",
        fileChanges: [{ changeType: "created", path: "output.xlsx", bytes: 7364 }],
      };
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "run-fail", name: "run_step", arguments: { action: "fail" } }],
        };
      }
      if (calls === 2) {
        const runtimeContext = request.runtimeContext?.content ?? "";
        assert.match(runtimeContext, /runtime_execution_feedback/);
        assert.match(runtimeContext, /failed toolCallId=run-fail tool=run_step/);
        assert.match(runtimeContext, /No such file or directory/);
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "run-export", name: "run_step", arguments: { action: "export" } }],
        };
      }
      const runtimeContext = request.runtimeContext?.content ?? "";
      assert.match(runtimeContext, /runtime_execution_feedback/);
      assert.match(runtimeContext, /succeeded toolCallId=run-export tool=run_step/);
      assert.match(runtimeContext, /fileChanges=created:output\.xlsx/);
      assert.match(runtimeContext, /Successfully exported 26 records/);
      return { content: "output.xlsx is ready", finishReason: "stop", toolCalls: [] };
    },
  };
  const grant = makeGrant(["run_step"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Run until the artifact is ready.",
    input: "export",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 4,
  });

  assert.equal(result.output, "output.xlsx is ready");
  assert.equal(calls, 3);
});

test("repeated execution failures surface failure phases and a strategy switch directive", async () => {
  let calls = 0;
  const tool: RuntimeTool<unknown> = {
    name: "run_step",
    description: "Run one scripted step",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => {
      if (value === null || typeof value !== "object" || !("action" in value)) {
        throw new Error("action is required");
      }
      return value;
    },
    execute: async (_context, value) => {
      const action = (value as { action?: string }).action;
      if (action === "execute") {
        throw new AppError("TOOL_EXECUTION_ERROR", "spawn . EACCES", 409);
      }
      return {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        fileChanges: [],
      };
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "run-prepare", name: "run_step", arguments: {} }],
        };
      }
      if (calls === 2) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "run-execute", name: "run_step", arguments: { action: "execute" } }],
        };
      }
      const runtimeContext = request.runtimeContext?.content ?? "";
      assert.match(runtimeContext, /runtime_execution_feedback/);
      assert.match(runtimeContext, /Recent failures by phase:/);
      assert.match(runtimeContext, /phase=prepare tool=run_step/);
      assert.match(runtimeContext, /phase=execute tool=run_step/);
      assert.match(runtimeContext, /switch subgoal or tool family/);
      return { content: "changed strategy", finishReason: "stop", toolCalls: [] };
    },
  };
  const grant = makeGrant(["run_step"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Run until the artifact is ready.",
    input: "export",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 4,
  });

  assert.equal(result.output, "changed strategy");
  assert.equal(calls, 3);
});

test("next model turn receives actionable feedback for Skill package mutation", async () => {
  let calls = 0;
  const tool: RuntimeTool<unknown> = {
    name: "run_package_script",
    description: "Run one Skill package script",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async () => {
      throw new AppError(
        "SKILL_PACKAGE_MUTATED",
        "Command modified read-only command root @skills/presentation-skill",
        409,
      );
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async (request) => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "mutate-skill", name: "run_package_script", arguments: {} }],
        };
      }
      const runtimeContext = request.runtimeContext?.content ?? "";
      assert.match(runtimeContext, /runtime_execution_feedback/);
      assert.match(runtimeContext, /SKILL_PACKAGE_MUTATED means a command wrote under a read-only Skill command root/);
      assert.match(runtimeContext, /writable --workspace\/--output\/--outdir arguments resolve under the writable workspace root/);
      assert.match(runtimeContext, /do not inspect package internals solely to diagnose/);
      return { content: "repaired with workspace-root output paths", finishReason: "stop", toolCalls: [] };
    },
  };
  const grant = makeGrant(["run_package_script"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Run package workflow.",
    input: "build a deck",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 3,
  });

  assert.equal(result.output, "repaired with workspace-root output paths");
  assert.equal(calls, 2);
});

test("a looping model stops extending grace once it repeats identical tool calls", async () => {
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "render",
    description: "Render the artifact",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return "rendered";
    },
  };
  const model = new LoopingGraceModel();
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["render"]);
  await assert.rejects(
    () => runAgentLoop({
      runId: grant.runId,
      systemPrompt: "Render the artifact.",
      input: "render",
      model,
      tools: new ToolRegistry([tool]),
      grant,
      maxSteps: 2,
      convergenceGraceSteps: 4,
      emit: (event) => { events.push(event); },
    }),
    (error: unknown) => error !== null
      && typeof error === "object"
      && "code" in error
      && (error as { code: unknown }).code === "RUN_LIMIT_EXCEEDED"
      && (error as unknown as { message: string }).message.includes("without forward progress"),
  );
  assert.equal(executions, 2);
  assert.equal(events.filter((event) => event.type === "loop.no_progress").length, 1);
  assert.equal(events.filter((event) => event.type === "loop.limit_exceeded").length, 1);
  const limitEvent = events.find((event) => event.type === "loop.limit_exceeded");
  assert.equal(limitEvent?.data.stalled, true);
});

test("a converged turn that emits an unexecuted tool invocation gets one no-tool repair before assessment", async () => {
  let executions = 0;
  let assessments = 0;
  const tool: RuntimeTool<unknown> = {
    name: "render",
    description: "Render the artifact",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return "ok";
    },
  };
  const model = new ConvergedToolInvocationModel(
    undefined,
    "render step completed from canonical tool evidence: render returned ok.",
  );
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["render"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Render the artifact.",
    input: "render",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 2,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (context) => {
      assessments += 1;
      assert.doesNotMatch(context.output, /tool_calls|DSML|invoke/);
      return { approved: true, feedback: "" };
    },
  });
  assert.match(result.output, /render step completed/);
  assert.equal(executions, 1);
  assert.equal(assessments, 1);
  assert.equal(model.calls, 3);
  assert.equal(events.filter((event) => event.type === "candidate.rejected").length, 1);
  assert.equal(events.some((event) => event.type === "candidate.approved"), true);
  assert.equal(events.filter((event) => event.type === "loop.limit_exceeded").length, 0);
});

test("a converged Kimi-style text tool invocation gets one no-tool repair before assessment", async () => {
  let executions = 0;
  let assessments = 0;
  const tool: RuntimeTool<unknown> = {
    name: "render",
    description: "Render the artifact",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => {
      executions += 1;
      return "ok";
    },
  };
  const model = new ConvergedToolInvocationModel(
    '我需要重新生成并验证海报。<|tool_calls_section_begin|><|tool_call_begin|>functions.verify_artifact_acceptance:1<|tool_call_argument_begin|>{"artifactPath":"poster_output.png"}<|tool_call_end|><|tool_calls_section_end|>',
    "海报验证步骤已根据现有工具证据完成：render 返回 ok。",
  );
  const events: RuntimeEvent[] = [];
  const grant = makeGrant(["render"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Verify the artifact.",
    input: "verify",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 2,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (context) => {
      assessments += 1;
      assert.doesNotMatch(context.output, /tool_calls_section|tool_call_begin|verify_artifact_acceptance/);
      return { approved: true, feedback: "" };
    },
  });
  assert.match(result.output, /海报验证步骤/);
  assert.equal(executions, 1);
  assert.equal(assessments, 1);
  assert.equal(model.calls, 3);
  assert.equal(events.filter((event) => event.type === "candidate.rejected").length, 1);
  assert.equal(events.some((event) => event.type === "candidate.approved"), true);
});

test("a no-tool candidate with embedded provider tool protocol is rejected before assessment", async () => {
  let assessments = 0;
  const events: RuntimeEvent[] = [];
  const grant = makeGrant([]);
  await assert.rejects(
    () => runAgentLoop({
      runId: grant.runId,
      systemPrompt: "Answer directly.",
      input: "regenerate the artifact",
      model: new TextToolInvocationOnlyModel(
        '我需要重新生成。<|tool_calls_section_begin|><|tool_call_begin|>functions.web_research:0<|tool_call_argument_begin|>{"query":"test"}<|tool_call_end|><|tool_calls_section_end|>',
      ),
      tools: new ToolRegistry([]),
      grant,
      maxSteps: 1,
      emit: (event) => { events.push(event); },
      evaluateCandidate: async () => {
        assessments += 1;
        return { approved: true, feedback: "never assessed" };
      },
    }),
    (error: unknown) => error !== null
      && typeof error === "object"
      && "code" in error
      && (error as { code: unknown }).code === "RUN_LIMIT_EXCEEDED",
  );
  assert.equal(assessments, 0);
  assert.equal(events.filter((event) => event.type === "candidate.rejected").length, 1);
  assert.equal(events.some((event) => event.type === "candidate.approved"), false);
});

test("a no-tool candidate with internal Runtime evidence markup is repaired before assessment", async () => {
  let assessments = 0;
  const events: RuntimeEvent[] = [];
  const grant = makeGrant([]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Answer directly.",
    input: "answer from evidence",
    model: new InternalEvidenceMarkupThenAnswerModel(),
    tools: new ToolRegistry([]),
    grant,
    maxSteps: 2,
    emit: (event) => { events.push(event); },
    evaluateCandidate: async (context) => {
      assessments += 1;
      assert.doesNotMatch(context.output, /runtime_evidence_record|agentloop\.runtimeEvidenceRecord/);
      return { approved: true, feedback: "" };
    },
  });

  assert.equal(result.output, "宝信软件董事长是夏雪松。");
  assert.equal(assessments, 1);
  assert.equal(events.filter((event) => event.type === "candidate.rejected").length, 1);
  assert.equal(events.some((event) => event.type === "candidate.approved"), true);
});

test("streaming turns emit live deltas before the durable assistant checkpoint", async () => {
  const events: RuntimeEvent[] = [];
  const tool: RuntimeTool<unknown> = {
    name: "echo",
    description: "Echo a value",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, value) => (value as { value: number }).value,
  };
  const model = new StreamingScenarioModel();
  const grant = makeGrant(["echo"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Stream",
    input: "echo",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 3,
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "done");
  const modelStarted = events.filter((event) => event.type === "model.request.started");
  const modelCompleted = events.filter((event) => event.type === "model.request.completed");
  const firstEvents = events.filter((event) => event.type === "model.stream.first_event");
  assert.equal(modelStarted.length, 2);
  assert.equal(modelCompleted.length, 2);
  assert.equal(firstEvents.length, 1);
  assert.equal(firstEvents[0].data.eventType, "text_delta");
  assert.equal((firstEvents[0].data.request as { canonicalMessageCount?: number }).canonicalMessageCount, 1);
  const streamingEvents = events.filter((event) => event.type === "assistant.streaming");
  assert.equal(streamingEvents.length >= 1, true);
  const committedIndex = events.findIndex((event) => event.type === "assistant.committed");
  assert.equal(committedIndex >= 0, true);
  assert.equal(events.findIndex((event) => event.type === "model.request.started") < events.findIndex((event) => event.type === "model.stream.first_event"), true);
  assert.equal(events.findIndex((event) => event.type === "model.stream.first_event") < events.findIndex((event) => event.type === "model.request.completed"), true);
  // Every transient delta must precede the durable checkpoint for that turn.
  const streamingIndices = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === "assistant.streaming")
    .map(({ index }) => index);
  assert.equal(streamingIndices.every((index) => index < committedIndex), true);
  assert.equal(events.some((event) => event.type === "tool.completed"), true);
});

test("assistant checkpoints persist provider reasoning continuation", async () => {
  const events: RuntimeEvent[] = [];
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async () => ({
      content: "done",
      finishReason: "stop",
      toolCalls: [],
      reasoningContent: "opaque-thinking-state",
    }),
  };

  const result = await runAgentLoop({
    runId: "run-reasoning-checkpoint",
    systemPrompt: "Reasoning checkpoint",
    input: "finish",
    model,
    tools: new ToolRegistry([]),
    grant: makeGrant([]),
    maxSteps: 1,
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "done");
  const committed = events.find((event) => event.type === "assistant.committed");
  assert.equal(committed?.data.reasoningContent, "opaque-thinking-state");
});

test("tool_call_ready dispatches the tool before the full assistant checkpoint", async () => {
  const events: RuntimeEvent[] = [];
  let executions = 0;
  const tool: RuntimeTool<unknown> = {
    name: "echo",
    description: "Echo a value",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, value) => {
      executions += 1;
      return (value as { value: number }).value;
    },
  };
  const model = new EarlyDispatchModel();
  const grant = makeGrant(["echo"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Early dispatch",
    input: "echo 7",
    model,
    tools: new ToolRegistry([tool]),
    grant,
    maxSteps: 3,
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "done");
  assert.equal(executions, 1);
  const committedIdx = events.findIndex((event) => event.type === "assistant.committed");
  const toolCallCommittedIdx = events.findIndex((event) => event.type === "assistant.tool_call.committed");
  const awaitingCompletionIdx = events.findIndex((event) => event.type === "model.stream.awaiting_completion");
  const modelCompletedIdx = events.findIndex((event) => event.type === "model.request.completed");
  const toolCompletedIdx = events.findIndex((event) => event.type === "tool.completed");
  assert.equal(toolCallCommittedIdx >= 0, true);
  assert.equal(awaitingCompletionIdx >= 0, true);
  assert.equal(modelCompletedIdx >= 0, true);
  assert.equal(toolCompletedIdx >= 0, true);
  // Per-call checkpoint precedes its effect, which precedes the full checkpoint.
  assert.equal(toolCallCommittedIdx < awaitingCompletionIdx, true);
  assert.equal(awaitingCompletionIdx < committedIdx, true);
  assert.equal(modelCompletedIdx < committedIdx, true);
  assert.equal(toolCallCommittedIdx < toolCompletedIdx, true);
  assert.equal(toolCompletedIdx < committedIdx, true);
  const perCallCommit = events[toolCallCommittedIdx];
  assert.equal(perCallCommit.data.toolCallId, "call-echo");
  assert.equal(perCallCommit.data.name, "echo");
  assert.deepEqual(perCallCommit.data.arguments, { value: 7 });
  const awaitingCompletion = events[awaitingCompletionIdx];
  assert.equal(awaitingCompletion.data.toolCallId, "call-echo");
  assert.equal(awaitingCompletion.data.toolName, "echo");
});

test("model request failures are emitted before the run fails", async () => {
  const events: RuntimeEvent[] = [];
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async () => {
      throw new AppError("MODEL_ERROR", "provider timeout", 502);
    },
  };

  await assert.rejects(
    () => runAgentLoop({
      runId: "run-model-failed-event",
      systemPrompt: "Fail",
      input: "fail",
      model,
      tools: new ToolRegistry([]),
      grant: makeGrant([]),
      maxSteps: 1,
      emit: (event) => { events.push(event); },
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "MODEL_ERROR");
      return true;
    },
  );

  const startedIdx = events.findIndex((event) => event.type === "model.request.started");
  const failedIdx = events.findIndex((event) => event.type === "model.request.failed");
  assert.equal(startedIdx >= 0, true);
  assert.equal(failedIdx > startedIdx, true);
  assert.equal(events[failedIdx].data.code, "MODEL_ERROR");
  assert.match(String(events[failedIdx].data.message), /provider timeout/);
});

test("progress policy admits streaming tool calls before dispatching side effects", async () => {
  const events: RuntimeEvent[] = [];
  const executions: string[] = [];
  let calls = 0;
  const writeTool: RuntimeTool<unknown> = {
    name: "computer_write_file",
    description: "Write intermediate source",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: false,
    parse: (value) => value,
    execute: async (_context, input) => {
      const path = String((input as { path: string }).path);
      executions.push(`write:${path}`);
      return JSON.stringify({
        path,
        artifactReceipt: {
          artifact: { path, artifactKind: "code" },
          evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty"] },
        },
      });
    },
  };
  const readJsonTool: RuntimeTool<unknown> = {
    name: "computer_read_json",
    description: "Read structured source",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`read-json:${JSON.stringify(input)}`);
      return JSON.stringify({ path: "poster-spec.json", data: {} });
    },
  };
  const runTool: RuntimeTool<unknown> = {
    name: "computer_run_command",
    description: "Render final image",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`run:${JSON.stringify(input)}`);
      return JSON.stringify({
        path: "poster.png",
        artifactReceipt: {
          artifact: { path: "poster.png", artifactKind: "image" },
          evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty", "format_matches_request"] },
        },
      });
    },
  };
  const verifyTool: RuntimeTool<unknown> = {
    name: "verify_artifact_acceptance",
    description: "Verify final image",
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async (_context, input) => {
      executions.push(`verify:${JSON.stringify(input)}`);
      return JSON.stringify({
        artifactReceipt: {
          artifact: { path: "poster.png", artifactKind: "image", acceptanceProfile: "image" },
          evidenceKinds: { satisfied: ["artifact_acceptance", "artifact_openable", "format_matches_request"] },
        },
      });
    },
  };
  const model: ModelAdapter = {
    limits: TEST_MODEL_LIMITS,
    complete: async () => {
      throw new Error("streaming path expected");
    },
    streamComplete: async (request, sink) => {
      calls += 1;
      if (calls === 1) {
        const call = {
          id: "write-spec",
          name: "computer_write_file",
          arguments: { path: "poster-spec.json", content: "{\"output\":\"poster.png\"}" },
        };
        await sink({ type: "tool_call_ready", index: 0, ...call });
        return { content: "", finishReason: "tool_calls", toolCalls: [call] };
      }
      if (calls === 2) {
        const call = {
          id: "read-spec",
          name: "computer_read_json",
          arguments: { path: "poster-spec.json" },
        };
        await sink({ type: "tool_call_ready", index: 0, ...call });
        return { content: "", finishReason: "tool_calls", toolCalls: [call] };
      }
      if (calls === 3) {
        assert.match(request.runtimeContext?.content ?? "", /runtime_artifact_source_production_repair/);
        const call = {
          id: "render-poster",
          name: "computer_run_command",
          arguments: { command: "render poster-spec.json" },
        };
        await sink({ type: "tool_call_ready", index: 0, ...call });
        return { content: "", finishReason: "tool_calls", toolCalls: [call] };
      }
      if (calls === 4) {
        const call = {
          id: "verify-poster",
          name: "verify_artifact_acceptance",
          arguments: { artifactPath: "poster.png", artifactKind: "image" },
        };
        await sink({ type: "tool_call_ready", index: 0, ...call });
        return { content: "", finishReason: "tool_calls", toolCalls: [call] };
      }
      return { content: "poster.png accepted", finishReason: "stop", toolCalls: [] };
    },
  };
  const grant = makeGrant(["computer_write_file", "computer_read_json", "computer_run_command", "verify_artifact_acceptance"]);
  const result = await runAgentLoop({
    runId: grant.runId,
    systemPrompt: "Produce and verify an image artifact.",
    input: "create a poster image",
    model,
    tools: new ToolRegistry([writeTool, readJsonTool, runTool, verifyTool]),
    grant,
    maxSteps: 6,
    convergenceGraceSteps: 0,
    progressPolicy: artifactStepToolProgressPolicy(
      ["artifact_path", "artifact_non_empty", "artifact_acceptance", "format_matches_request"],
      { expectedArtifactKind: "image" },
    ),
    shouldConvergeAfterToolStep: (context) => ({
      converge: context.toolEvidence.some((item) => item.toolName === "verify_artifact_acceptance" && !item.isError),
      reason: "artifact_acceptance_observed",
    }),
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "poster.png accepted");
  assert.deepEqual(executions.map((entry) => entry.split(":", 1)[0]), ["write", "run", "verify"]);
  assert.equal(events.some((event) =>
    event.type === "assistant.tool_call.committed" && event.data.toolCallId === "read-spec"
  ), true);
  assert.equal(events.some((event) =>
    (event.type === "tool.effect_pending" || event.type === "tool.dispatched" || event.type === "tool.completed")
    && event.data.toolCallId === "read-spec"
  ), false);
  const rejected = events.find((event) =>
    event.type === "tool.rejected" && event.data.toolCallId === "read-spec"
  );
  assert.equal(rejected?.data.reason, "Intermediate artifact/source evidence exists but final artifact evidence is still missing");
});

test("capability grants are immutable at runtime, not only in TypeScript", () => {
  const grant = createCapabilityGrant({
    actorUserId: "user-1",
    runId: "run-1",
    depth: 0,
    allowedToolNames: ["read"],
    allowedSkillIds: ["skill-1"],
  });
  assert.equal(grant.allowedToolNames.has("read"), true);
  assert.equal("add" in grant.allowedToolNames, false);
  assert.throws(() => {
    (grant.allowedToolNames as unknown as { add(value: string): void }).add("admin");
  }, TypeError);
  assert.equal(grant.allowedToolNames.has("admin"), false);
});

class ParallelScenarioModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          { id: "call-slow", name: "slow_double", arguments: { value: 3 } },
          { id: "call-fast", name: "fast_square", arguments: { value: 4 } },
        ],
      };
    }
    const tools = request.messages.filter((message) => message.role === "tool");
    assert.deepEqual(tools.map((message) => message.name), ["slow_double", "fast_square"]);
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }
}

class TruncatedScenarioModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "length",
        toolCalls: [{ id: "call-unsafe", name: "unsafe_write", arguments: { partial: true } }],
      };
    }
    return { content: "recovered", finishReason: "stop", toolCalls: [] };
  }
}

class EndlessToolModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    return {
      content: "I should keep going",
      finishReason: "tool_calls",
      toolCalls: [{ id: `call-${this.calls}`, name: "read_only", arguments: {} }],
    };
  }
}

class ConvergenceScenarioModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["collect_evidence"]);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "collect-1", name: "collect_evidence", arguments: {} }],
      };
    }
    assert.deepEqual(request.tools, []);
    assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
    assert.equal(request.maxOutputTokens, 4_096);
    const evidence = request.messages.find((message) => message.role === "tool" && message.name === "collect_evidence");
    assert.match(evidence?.content ?? "", /\"artifact\":\"ready\"/);
    return {
      content: "artifact ready; QA passed; evidence: collect_evidence",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class FinalEvidenceAtLimitModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.equal(request.tools.some((tool) => tool.name === "produce_artifact"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "produce-1", name: "produce_artifact", arguments: {} }],
      };
    }
    if (this.calls === 2) {
      assert.equal(request.tools.some((tool) => tool.name === "verify_artifact_acceptance"), true);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "accept-1", name: "verify_artifact_acceptance", arguments: { artifactPath: "poster.png" } }],
      };
    }
    assert.deepEqual(request.tools, []);
    assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
    return {
      content: "poster.png accepted with artifact_acceptance evidence",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class LengthCompletionRepairModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "collect", name: "collect_evidence", arguments: { value: 1 } }],
      };
    }
    if (this.calls === 2) {
      assert.deepEqual(request.tools, []);
      return {
        content: "long incomplete candidate",
        finishReason: "length",
        toolCalls: [],
      };
    }
    assert.match(request.runtimeContext?.content ?? "", /shorter completion candidate/);
    return {
      content: "short complete candidate",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class StructuredCandidateModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    return {
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "lookup-1", name: "lookup_api", arguments: { query: "合同备案" } }],
    };
  }
}

class EmptyThenConvergedModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["collect_evidence"]);
      assert.equal(request.maxOutputTokens, 8_192);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "collect-1", name: "collect_evidence", arguments: {} }],
      };
    }
    assert.deepEqual(request.tools, []);
    assert.equal(request.maxOutputTokens, 4_096);
    if (this.calls === 2) {
      return { content: "", finishReason: "stop", toolCalls: [] };
    }
    assert.match(request.runtimeContext?.content ?? "", /runtime_candidate_repair/);
    return {
      content: "artifact ready; QA passed; evidence: collect_evidence",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class CandidateRepairGraceModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["read_evidence"]);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "read-report", name: "read_evidence", arguments: { path: "report.md" } }],
      };
    }
    if (this.calls === 2) {
      return { content: "report readable but evidence not compared", finishReason: "stop", toolCalls: [] };
    }
    if (this.calls === 3) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["read_evidence"]);
      assert.match(request.runtimeContext?.content ?? "", /Need direct evidence comparison/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "read-json", name: "read_evidence", arguments: { path: "evidence/data.json" } }],
      };
    }
    return { content: "report verified; evidence consistent", finishReason: "stop", toolCalls: [] };
  }
}

class DeferredValidationModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "build", name: "render_probe", arguments: { action: "build" } }],
      };
    }
    if (this.calls === 2) {
      return { content: "deck.pptx exists, but visual validation has not run", finishReason: "stop", toolCalls: [] };
    }
    if (this.calls === 3) {
      assert.match(request.runtimeContext?.content ?? "", /Renderer missing/);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "probe", name: "render_probe", arguments: { action: "probe" } }],
      };
    }
    return { content: "deck.pptx exists, but renderer validation is unavailable", finishReason: "stop", toolCalls: [] };
  }
}

class GraceCompletionModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls <= 2) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: `render-${this.calls}`, name: "render", arguments: {} }],
      };
    }
    return { content: "rendered artifact", finishReason: "stop", toolCalls: [] };
  }
}

class DistinctGraceModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls <= 3) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: `work-${this.calls}`, name: "work", arguments: { step: this.calls } }],
      };
    }
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }
}

class EarlyConvergenceModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      assert.deepEqual(request.tools.map((tool) => tool.name), ["render"]);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "render-1", name: "render", arguments: {} }],
      };
    }
    assert.deepEqual(request.tools, []);
    assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
    return {
      content: "poster artifact ready; evidence: render",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class LoopingGraceModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;

  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    return {
      content: "still rendering",
      finishReason: "tool_calls",
      toolCalls: [{ id: `render-${this.calls}`, name: "render", arguments: {} }],
    };
  }
}

class ConvergedToolInvocationModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  calls = 0;
  private readonly textInvocation: string;
  private readonly repairedContent: string | undefined;

  constructor(
    textInvocation = '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="render">\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>',
    repairedContent?: string,
  ) {
    this.textInvocation = textInvocation;
    this.repairedContent = repairedContent;
  }

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "render-1", name: "render", arguments: {} }],
      };
    }
    assert.deepEqual(request.tools, []);
    if (this.calls === 2) {
      assert.match(request.runtimeContext?.content ?? "", /runtime_convergence/);
    }
    if (this.calls === 3 && this.repairedContent !== undefined) {
      assert.match(request.runtimeContext?.content ?? "", /runtime_candidate_repair/);
      return {
        content: this.repairedContent,
        finishReason: "stop",
        toolCalls: [],
      };
    }
    return {
      content: this.textInvocation,
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class TextToolInvocationOnlyModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private readonly content: string;

  constructor(content: string) {
    this.content = content;
  }

  async complete(): Promise<ModelResponse> {
    return {
      content: this.content,
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class InternalEvidenceMarkupThenAnswerModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    assert.deepEqual(request.tools, []);
    if (this.calls === 1) {
      return {
        content: [
          '<runtime_evidence_record source="server" kind="tool_call" encoding="json">',
          '{"schema":"agentloop.runtimeEvidenceRecord/v1","kind":"tool_call","toolCallId":"call-1","toolName":"webfetch","arguments":{"url":"https://example.test"}}',
          "</runtime_evidence_record>",
        ].join("\n"),
        finishReason: "stop",
        toolCalls: [],
      };
    }
    assert.match(request.runtimeContext?.content ?? "", /internal Runtime evidence markup/);
    return {
      content: "宝信软件董事长是夏雪松。",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class EarlyDispatchModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(): Promise<ModelResponse> {
    return this.next();
  }

  async streamComplete(_request: ModelInvocation, sink: ModelStreamSink): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      await sink({ type: "text_delta", text: "echoing" });
      await sink({ type: "tool_call_ready", index: 0, id: "call-echo", name: "echo", arguments: { value: 7 } });
      return {
        content: "echoing",
        finishReason: "tool_calls",
        toolCalls: [{ id: "call-echo", name: "echo", arguments: { value: 7 } }],
      };
    }
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }

  private next(): ModelResponse {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "call-echo", name: "echo", arguments: { value: 7 } }],
      };
    }
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }
}

class StreamingScenarioModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(): Promise<ModelResponse> {
    return this.next();
  }

  async streamComplete(
    _request: ModelInvocation,
    sink: (event: { type: "text_delta"; text: string } | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta: string }) => Promise<void> | void,
  ): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      await sink({ type: "text_delta", text: "echoing " });
      await sink({ type: "text_delta", text: "value" });
      await sink({ type: "tool_call_delta", index: 0, id: "call-echo", name: "echo", argumentsDelta: "{\"value\":7}" });
      return { content: "echoing value", finishReason: "tool_calls", toolCalls: [{ id: "call-echo", name: "echo", arguments: { value: 7 } }] };
    }
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }

  private next(): ModelResponse {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "call-echo", name: "echo", arguments: { value: 7 } }],
      };
    }
    return { content: "done", finishReason: "stop", toolCalls: [] };
  }
}

function numberTool(
  name: string,
  delayMs: number,
  operation: (value: number) => number,
): RuntimeTool<unknown> {
  return {
    name,
    description: name,
    inputSchema: {
      type: "object",
      required: ["value"],
      properties: { value: { type: "number" } },
    },
    executionMode: "parallel",
    replaySafe: true,
    parse: (input) => {
      if (input === null || typeof input !== "object" || !("value" in input)) throw new Error("value is required");
      const value = (input as { value: unknown }).value;
      if (typeof value !== "number") throw new Error("value must be a number");
      return { value };
    },
    execute: async (_context, input) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return operation((input as { value: number }).value);
    },
  };
}

function runtimeStepSemanticState(content: string): {
  readonly schema: string;
  readonly missingRequiredEvidenceKinds: readonly string[];
  readonly workProduct: { readonly status: string };
  readonly knownArtifacts: readonly Array<{ readonly path: string }>;
  readonly processArtifacts: readonly Array<{ readonly path: string }>;
  readonly nextAction: string;
  readonly evidenceProducingToolNames: readonly string[];
  readonly exploratoryToolNames: readonly string[];
} {
  const match = content.match(/<runtime_step_semantic_state>\n(.*?)\n<\/runtime_step_semantic_state>/s);
  assert.ok(match?.[1]);
  return JSON.parse(match[1]) as {
    readonly schema: string;
    readonly missingRequiredEvidenceKinds: readonly string[];
    readonly workProduct: { readonly status: string };
    readonly knownArtifacts: readonly Array<{ readonly path: string }>;
    readonly processArtifacts: readonly Array<{ readonly path: string }>;
    readonly nextAction: string;
    readonly evidenceProducingToolNames: readonly string[];
    readonly exploratoryToolNames: readonly string[];
  };
}

function makeGrant(toolNames: readonly string[]): CapabilityGrant {
  return {
    actorUserId: "user-1",
    runId: "run-1",
    depth: 0,
    allowedToolNames: new Set(toolNames),
    allowedSkillIds: new Set(),
    visibleDirectories: [],
    uploadedSources: [],
    skillExecutionRoots: [],
  };
}
