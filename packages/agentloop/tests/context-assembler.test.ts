import assert from "node:assert/strict";
import test from "node:test";
import { runAgentLoop } from "../src/runtime/agent-loop.ts";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { ContextAssembler, estimateTextTokens } from "../src/runtime/context-assembler.ts";
import type { ModelAdapter, ModelInvocation, ModelMessage, ModelResponse, RuntimeEvent } from "../src/runtime/contracts.ts";
import { ToolRegistry, type RuntimeTool } from "../src/tools/tool-registry.ts";

test("ContextAssembler rejects an unclosed ToolCall instead of cutting an invalid provider transcript", async () => {
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 32_000, maxOutputTokens: 2_048 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-unclosed",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });
  await assert.rejects(
    () => assembler.assemble([{
      role: "assistant",
      content: "",
      toolCalls: [{ id: "missing-result", name: "read", arguments: {} }],
    }], []),
    /ToolCalls without results/,
  );
});

test("ContextAssembler projects structured Tool evidence instead of raw read content", async () => {
  const events: RuntimeEvent[] = [];
  const rawContent = "raw knowledge body ".repeat(4_000);
  const toolResult = JSON.stringify({
    schema: "agentloop.visibleReadFiles/v1",
    files: [{ path: "kb.md", content: rawContent, sha256: "content-hash", bytes: rawContent.length, characters: rawContent.length, truncated: false }],
    requested: 1,
    returned: 1,
    truncated: false,
    maxTotalCharacters: 200_000,
    evidenceReceipt: {
      schema: "agentloop.toolEvidenceReceipt/v1",
      sourceType: "visible_files",
      receiptId: "receipt-1",
      sourceRefs: [{ path: "kb.md", sha256: "content-hash", bytes: rawContent.length, characters: rawContent.length, truncated: false }],
      facts: [{ path: "kb.md", title: "Travel", outline: [{ line: 1, text: "# Travel" }], fields: [], sections: [], excerpt: "structured travel fact", truncated: false }],
      caveats: ["canonical event retained"],
      evidenceKinds: { satisfied: ["source_read"], caveated: [], failed: [] },
    },
  });
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-structured-evidence",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
    emit: async (event) => { events.push(event); },
  });

  const assembly = await assembler.assemble([
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "visible_read_files", arguments: { rootId: "visible_dir_1", files: [{ path: "kb.md" }] } }] },
    { role: "tool", toolCallId: "call-1", name: "visible_read_files", content: toolResult, isError: false },
  ], []);
  const projected = assembly.messages.find((message) => message.role === "tool")?.content ?? "";

  assert.match(projected, /agentloop\.contextEvidenceProjection\/v1/);
  assert.match(projected, /excerptSha256/);
  assert.match(projected, /excerptCharacters/);
  assert.match(projected, /receipt-1/);
  assert.doesNotMatch(projected, /structured travel fact/);
  assert.doesNotMatch(projected, /raw knowledge body raw knowledge body raw knowledge body/);
  assert.equal(events.some((event) => event.type === "context.tool_outputs_projected" && event.data.reason === "structured_evidence"), true);
});

test("ContextAssembler preserves a bounded web-page preview in structured evidence", async () => {
  const textPreview = "The source describes measurable process controls and evidence requirements. ".repeat(40);
  const toolResult = JSON.stringify({
    schema: "agentloop.webFetch/v1",
    url: "https://example.test/dcmm",
    title: "DCMM guidance",
    content: "full page body omitted from the model context",
    evidenceReceipt: {
      schema: "agentloop.toolEvidenceReceipt/v1",
      sourceType: "web_page",
      receiptId: "web-receipt-1",
      sourceRefs: [{ sourceRefId: "web:dcmm", url: "https://example.test/dcmm", path: "https://example.test/dcmm" }],
      facts: [{
        kind: "source_summary",
        url: "https://example.test/dcmm",
        title: "DCMM guidance",
        characters: 9_000,
        textPreview,
      }],
      caveats: ["The full source remains in canonical events."],
      evidenceKinds: { satisfied: ["source_read", "source_summary"], caveated: ["explicit_caveats"], failed: [] },
    },
  });
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-web-preview-projection",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });

  const assembly = await assembler.assemble([
    { role: "assistant", content: "", toolCalls: [{ id: "fetch-web", name: "webfetch", arguments: { url: "https://example.test/dcmm" } }] },
    { role: "tool", toolCallId: "fetch-web", name: "webfetch", content: toolResult, isError: false },
  ], []);
  const projected = assembly.messages.find((message) => message.role === "tool")?.content ?? "";
  const projection = JSON.parse(projected.split("\n\n")[0]) as {
    evidenceReceipt: { facts: Array<{ url?: string; textPreview?: string; textPreviewCharacters?: number; textPreviewSha256?: string }> };
  };
  const fact = projection.evidenceReceipt.facts[0];

  assert.equal(fact?.url, "https://example.test/dcmm");
  assert.equal(fact?.textPreviewCharacters, textPreview.length);
  assert.ok(fact?.textPreviewSha256);
  assert.match(fact?.textPreview ?? "", /measurable process controls/);
  assert.ok((fact?.textPreview?.length ?? 0) <= 1_500);
});

test("ContextAssembler preserves uploaded source chunk content and read_source semantics", async () => {
  const uploadedContent = [
    "Sheet: 工作表1",
    "0,任务名称,责任人,月度目标",
    "1,风险分析,王明杰,完成全部任务拆解",
    "2,场景建设,代仲宇,完成场景开发",
  ].join("\n");
  const toolResult = JSON.stringify({
    schema: "agentloop.uploadedSourceRead/v1",
    sourceId: "src_11111111111111111111111111111111",
    originalName: "7月产品组推进计划.xlsx",
    totalChunks: 1,
    selectedChunks: 1,
    returnedChunks: 1,
    truncated: false,
    chunks: [{
      chunkIndex: 0,
      kind: "text",
      locator: "chars=1-96",
      sha256: "chunk-hash",
      content: uploadedContent,
    }],
    evidenceReceipt: {
      schema: "agentloop.toolEvidenceReceipt/v1",
      sourceType: "uploaded_source",
      receiptId: "uploaded-receipt",
      sourceRefs: [{ sourceId: "src_11111111111111111111111111111111", chunkIndex: 0, locator: "chars=1-96", sha256: "chunk-hash" }],
      facts: [{ kind: "source_chunks", sourceId: "src_11111111111111111111111111111111", totalChunkCount: 1, returnedChunkIndexes: [0] }],
      caveats: [],
      evidenceKinds: { satisfied: ["source_summary", "explicit_caveats"], caveated: [], failed: [] },
    },
  });
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-uploaded-source-projection",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });

  const assembly = await assembler.assemble([
    { role: "assistant", content: "", toolCalls: [{ id: "read-upload", name: "read_source", arguments: { sourceId: "src_11111111111111111111111111111111", chunkIndex: 0 } }] },
    { role: "tool", toolCallId: "read-upload", name: "read_source", content: toolResult, isError: false },
  ], []);
  const projected = assembly.messages.find((message) => message.role === "tool")?.content ?? "";
  const projection = JSON.parse(projected.split("\n\n")[0]) as {
    uploadedSource: {
      sourceId: string;
      totalChunks: number;
      returnedChunks: number;
      chunks: Array<{ chunkIndex: number; content: string; contentSha256: string }>;
    };
    evidenceReceipt: { evidenceKinds: { satisfied: string[] } };
    instruction: string;
  };

  assert.equal(projection.uploadedSource.sourceId, "src_11111111111111111111111111111111");
  assert.equal(projection.uploadedSource.totalChunks, 1);
  assert.equal(projection.uploadedSource.returnedChunks, 1);
  assert.equal(projection.uploadedSource.chunks[0]?.chunkIndex, 0);
  assert.equal(projection.uploadedSource.chunks[0]?.content, uploadedContent);
  assert.ok(projection.uploadedSource.chunks[0]?.contentSha256);
  assert.ok(projection.evidenceReceipt.evidenceKinds.satisfied.includes("explicit_caveats"));
  assert.match(projection.instruction, /chunkIndex plus maxChunks reads a consecutive window/);
  assert.match(projection.instruction, /not filesystem paths/);
  assert.doesNotMatch(projected, /workspace\/uploads/);
});

test("ContextAssembler keeps search evidence groups and limits source ref samples", async () => {
  const sourceRefs = Array.from({ length: 16 }, (_, index) => ({
    sourceRefId: `ref-${index}`,
    rootId: "visible_dir_1",
    path: `reports/category-${index}/source-${index}.md`,
    lines: [index + 1],
  }));
  const toolResult = JSON.stringify({
    schema: "agentloop.visibleSearchSummary/v1",
    rootId: "visible_dir_1",
    query: "预算",
    returnedMatches: 240,
    truncated: true,
    evidenceReceipt: {
      schema: "agentloop.toolEvidenceReceipt/v1",
      sourceType: "visible_search_text",
      receiptId: "receipt-search",
      sourceRefs,
      facts: [{
        kind: "text_search",
        rootId: "visible_dir_1",
        query: "预算",
        returnedMatches: 240,
        truncated: true,
        matchesRef: "visible-search:hash",
        textGroups: [
          { text: "预算执行情况良好 ".repeat(80), count: 180, samplePaths: ["reports/a.md", "reports/b.md", "reports/c.md"] },
          { text: "预算风险需要复核", count: 60, samplePaths: ["reports/d.md"] },
        ],
        pathGroups: [
          { prefix: "reports/finance", count: 120 },
          { prefix: "reports/risk", count: 80 },
        ],
        sampleMatches: Array.from({ length: 20 }, (_, index) => ({
          path: `reports/raw-${index}.md`,
          line: index + 1,
          text: `预算明细 ${index} ${"raw ".repeat(80)}`,
        })),
      }],
      caveats: ["Search stopped at maxMatches; additional matches may exist."],
      evidenceKinds: { satisfied: ["source_search", "source_refs"], caveated: ["explicit_caveats"], failed: [] },
    },
  });
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-search-projection",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });

  const assembly = await assembler.assemble([
    { role: "assistant", content: "", toolCalls: [{ id: "search", name: "visible_search_text", arguments: { rootId: "visible_dir_1", query: "预算" } }] },
    { role: "tool", toolCallId: "search", name: "visible_search_text", content: toolResult, isError: false },
  ], []);
  const projected = assembly.messages.find((message) => message.role === "tool")?.content ?? "";
  const projection = JSON.parse(projected.split("\n\n")[0]) as {
    evidenceReceipt: {
      sourceRefCount: number;
      sourceRefs?: unknown[];
      facts: Array<{ matchesRef?: string; textGroups?: unknown[]; pathGroups?: unknown[] }>;
    };
  };

  assert.equal(projection.evidenceReceipt.sourceRefCount, 16);
  assert.equal(projection.evidenceReceipt.sourceRefs?.length, 4);
  assert.equal(projection.evidenceReceipt.facts[0]?.matchesRef, "visible-search:hash");
  assert.ok((projection.evidenceReceipt.facts[0]?.textGroups?.length ?? 0) > 0);
  assert.ok((projection.evidenceReceipt.facts[0]?.pathGroups?.length ?? 0) > 0);
  assert.doesNotMatch(projected, /source-15\.md/);
  assert.doesNotMatch(projected, /raw raw raw raw raw raw raw raw raw raw/);
});

test("ContextAssembler projects large directory listings as structured counts", async () => {
  const entries = Array.from({ length: 350 }, (_, index) => ({
    name: `very-long-directory-entry-${String(index).padStart(3, "0")}-${"segment-".repeat(10)}.md`,
    type: index % 5 === 0 ? "directory" : "file",
    bytes: index * 17,
  }));
  const toolResult = JSON.stringify({ rootId: "visible_dir_1", entries });
  assert.ok(toolResult.length > 16_000);
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-directory-projection",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });

  const assembly = await assembler.assemble([
    { role: "assistant", content: "", toolCalls: [{ id: "list", name: "visible_list_directory", arguments: { rootId: "visible_dir_1" } }] },
    { role: "tool", toolCallId: "list", name: "visible_list_directory", content: toolResult, isError: false },
  ], []);
  const projected = assembly.messages.find((message) => message.role === "tool")?.content ?? "";
  const projection = JSON.parse(projected.split("\n\n")[0]) as {
    schema: string;
    entryCount: number;
    typeCounts: Record<string, number>;
    nameSamples: string[];
  };

  assert.equal(projection.schema, "agentloop.contextDirectoryListingProjection/v1");
  assert.equal(projection.entryCount, 350);
  assert.equal(projection.typeCounts.file, 280);
  assert.equal(projection.typeCounts.directory, 70);
  assert.equal(projection.nameSamples.length, 8);
  assert.match(projected, /structured projection/);
  assert.doesNotMatch(projected, /Large tool result projected/);
  assert.doesNotMatch(projected, /very-long-directory-entry-349/);
});

test("ContextAssembler projects artifact materialization receipts before raw inspection enters context", async () => {
  const events: RuntimeEvent[] = [];
  const rawHtmlSample = "<!doctype html>\n" + "<section>raw generated html sample</section>\n".repeat(80);
  const toolResult = JSON.stringify({
    schema: "agentloop.paginatedHtmlMaterialization/v1",
    artifactKind: "html",
    renderMode: "slides",
    acceptanceProfile: "html_ppt",
    pageCount: 19,
    specSha256: "spec-hash",
    path: "dcmm4-training.html",
    bytes: 26_318,
    sha256: "artifact-hash",
    characters: 19_357,
    totalLines: 358,
    inspection: {
      sha256: "artifact-hash",
      characters: 19_357,
      totalLines: 358,
      outline: [],
      outlineTruncated: false,
      sampleRanges: [{ startLine: 1, endLine: 90, content: rawHtmlSample }],
    },
    artifactReceipt: {
      schema: "agentloop.artifactReceipt/v1",
      receiptId: "artifact:materialized",
      sourceTool: "materialize_paginated_html",
      artifact: {
        path: "dcmm4-training.html",
        artifactKind: "html",
        renderMode: "slides",
        acceptanceProfile: "html_ppt",
        pageCount: 19,
        bytes: 26_318,
        characters: 19_357,
        totalLines: 358,
        sha256: "artifact-hash",
        specSha256: "spec-hash",
      },
      inspection: {
        sha256: "artifact-hash",
        characters: 19_357,
        totalLines: 358,
        outline: [],
        outlineTruncated: false,
        sampleRangeCount: 1,
      },
      evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty", "artifact_integrity"], caveated: [], failed: [] },
      canonicalEvidence: { fullInspectionInToolResult: true },
    },
  });
  assert.ok(toolResult.length < 16_000);
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-artifact-receipt-projection",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
    emit: (event) => { events.push(event); },
  });

  const assembly = await assembler.assemble([
    { role: "assistant", content: "", toolCalls: [{ id: "materialize", name: "materialize_paginated_html", arguments: { path: "dcmm4-training.html" } }] },
    { role: "tool", toolCallId: "materialize", name: "materialize_paginated_html", content: toolResult, isError: false },
  ], []);
  const projected = assembly.messages.find((message) => message.role === "tool")?.content ?? "";
  const projection = JSON.parse(projected.split("\n\n")[0]) as {
    schema: string;
    artifactReceipt: {
      receiptId: string;
      artifact: { path: string; pageCount: number; sha256: string };
      inspection: { sampleRangeCount: number };
    };
  };

  assert.equal(projection.schema, "agentloop.contextArtifactProjection/v1");
  assert.equal(projection.artifactReceipt.receiptId, "artifact:materialized");
  assert.equal(projection.artifactReceipt.artifact.path, "dcmm4-training.html");
  assert.equal(projection.artifactReceipt.artifact.pageCount, 19);
  assert.equal(projection.artifactReceipt.artifact.sha256, "artifact-hash");
  assert.equal(projection.artifactReceipt.inspection.sampleRangeCount, 1);
  assert.match(projected, /structured projection/);
  assert.doesNotMatch(projected, /raw generated html sample/);
  assert.equal(events.some((event) => event.type === "context.tool_outputs_projected" && event.data.reason === "structured_tool_result"), true);
});

test("ContextAssembler projects generic written artifact receipts before file samples enter context", async () => {
  const rawFileSample = "raw written file sample ".repeat(120);
  const toolResult = JSON.stringify({
    path: "deliverables/report.md",
    bytes: 8_192,
    sha256: "written-artifact-hash",
    characters: 8_192,
    totalLines: 120,
    inspection: {
      sha256: "written-artifact-hash",
      characters: 8_192,
      totalLines: 120,
      outline: [{ line: 1, text: "# Report" }],
      outlineTruncated: false,
      sampleRanges: [{ startLine: 1, endLine: 40, content: rawFileSample }],
    },
    artifactReceipt: {
      schema: "agentloop.artifactReceipt/v1",
      receiptId: "artifact:written",
      sourceTool: "computer_write_file",
      artifact: {
        path: "deliverables/report.md",
        bytes: 8_192,
        characters: 8_192,
        totalLines: 120,
        sha256: "written-artifact-hash",
      },
      inspection: {
        sha256: "written-artifact-hash",
        characters: 8_192,
        totalLines: 120,
        outline: [{ line: 1, text: "# Report" }],
        outlineTruncated: false,
        sampleRangeCount: 1,
      },
      evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty", "artifact_integrity"], caveated: [], failed: [] },
      canonicalEvidence: { fullInspectionInToolResult: true },
    },
  });
  assert.ok(toolResult.length < 16_000);
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-written-artifact-receipt-projection",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });

  const assembly = await assembler.assemble([
    { role: "assistant", content: "", toolCalls: [{ id: "write", name: "computer_write_file", arguments: { path: "deliverables/report.md" } }] },
    { role: "tool", toolCallId: "write", name: "computer_write_file", content: toolResult, isError: false },
  ], []);
  const projected = assembly.messages.find((message) => message.role === "tool")?.content ?? "";
  const projection = JSON.parse(projected.split("\n\n")[0]) as {
    schema: string;
    artifactReceipt: {
      sourceTool: string;
      artifact: { path: string; sha256: string };
      inspection: { sampleRangeCount: number };
    };
  };

  assert.equal(projection.schema, "agentloop.contextArtifactProjection/v1");
  assert.equal(projection.artifactReceipt.sourceTool, "computer_write_file");
  assert.equal(projection.artifactReceipt.artifact.path, "deliverables/report.md");
  assert.equal(projection.artifactReceipt.artifact.sha256, "written-artifact-hash");
  assert.equal(projection.artifactReceipt.inspection.sampleRangeCount, 1);
  assert.doesNotMatch(projected, /raw written file sample/);
});

test("ContextAssembler projects successful artifact write arguments out of model context", async () => {
  const generatedMarkdown = "# Report\n\n" + "analysis paragraph ".repeat(2_500);
  const toolResult = JSON.stringify({
    path: "deliverables/report.md",
    bytes: 42_000,
    sha256: "written-artifact-hash",
    characters: 42_000,
    totalLines: 180,
    artifactReceipt: {
      schema: "agentloop.artifactReceipt/v1",
      receiptId: "artifact:written",
      sourceTool: "computer_write_file",
      artifact: {
        path: "deliverables/report.md",
        bytes: 42_000,
        characters: 42_000,
        totalLines: 180,
        sha256: "written-artifact-hash",
      },
      inspection: {
        sha256: "written-artifact-hash",
        characters: 42_000,
        totalLines: 180,
        outline: [{ line: 1, text: "# Report" }],
        outlineTruncated: false,
        sampleRangeCount: 1,
      },
      evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty", "artifact_integrity"], caveated: [], failed: [] },
      canonicalEvidence: { fullInspectionInToolResult: true },
    },
  });
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-written-artifact-argument-projection",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });
  const canonical = [
    {
      role: "assistant" as const,
      content: "",
      toolCalls: [{
        id: "write",
        name: "computer_write_file",
        arguments: { path: "deliverables/report.md", content: generatedMarkdown },
      }],
    },
    { role: "tool" as const, toolCallId: "write", name: "computer_write_file", content: toolResult, isError: false },
  ];

  const assembly = await assembler.assemble(canonical, []);
  const projectedAssistant = assembly.messages.find(
    (message): message is Extract<ModelMessage, { role: "assistant" }> => message.role === "assistant",
  );
  if (projectedAssistant === undefined) assert.fail("Projected assistant message is missing");
  const projectedArguments = projectedAssistant.toolCalls?.[0]?.arguments as {
    schema?: string;
    artifact?: { path?: string; bytes?: number; sha256?: string; totalLines?: number };
    inspection?: { outline?: Array<{ line: number; text: string }> };
    originalArguments?: { contentCharacters?: number; canonicalArgumentsPersisted?: boolean };
  };

  assert.equal(projectedArguments.schema, "agentloop.contextArtifactToolCallArguments/v1");
  assert.equal(projectedArguments.artifact?.path, "deliverables/report.md");
  assert.equal(projectedArguments.artifact?.bytes, 42_000);
  assert.equal(projectedArguments.artifact?.sha256, "written-artifact-hash");
  assert.equal(projectedArguments.inspection?.outline?.[0]?.text, "# Report");
  assert.equal(projectedArguments.originalArguments?.contentCharacters, generatedMarkdown.length);
  assert.equal(projectedArguments.originalArguments?.canonicalArgumentsPersisted, true);
  assert.doesNotMatch(JSON.stringify(assembly.messages), /analysis paragraph analysis paragraph analysis paragraph/);
  assert.equal((canonical[0] as unknown as { toolCalls: [{ arguments: { content: string } }] }).toolCalls[0].arguments.content, generatedMarkdown);
});

test("ContextAssembler defers proactive compaction after artifact evidence while context fits", async () => {
  const requests: ModelInvocation[] = [];
  const events: RuntimeEvent[] = [];
  const generatedMarkdown = "# Report\n\n" + "analysis paragraph ".repeat(2_500);
  const toolResult = JSON.stringify({
    path: "deliverables/report.md",
    bytes: 42_000,
    sha256: "written-artifact-hash",
    characters: 42_000,
    totalLines: 180,
    artifactReceipt: {
      schema: "agentloop.artifactReceipt/v1",
      receiptId: "artifact:written",
      sourceTool: "computer_write_file",
      artifact: {
        path: "deliverables/report.md",
        bytes: 42_000,
        characters: 42_000,
        totalLines: 180,
        sha256: "written-artifact-hash",
      },
      evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty", "artifact_integrity"], caveated: [], failed: [] },
      canonicalEvidence: { fullInspectionInToolResult: true },
    },
  });
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 80_000, maxOutputTokens: 4_096 },
    complete: async (request) => {
      requests.push(request);
      return { content: structuredSummary("should not be used"), toolCalls: [], finishReason: "stop" };
    },
  };
  const assembler = new ContextAssembler({
    runId: "run-defer-artifact-compaction",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
    policy: {
      proactiveCompactionTokens: 1_000,
      preserveRecentTokens: 1_000,
      pruneProtectTokens: 1_000,
      deferProactiveCompactionForArtifactEvidence: true,
    },
    emit: (event) => { events.push(event); },
  });

  const canonical = [
    { role: "user" as const, content: "historical source ".repeat(2_500) },
    {
      role: "assistant" as const,
      content: "",
      toolCalls: [{
        id: "write",
        name: "computer_write_file",
        arguments: { path: "deliverables/report.md", content: generatedMarkdown },
      }],
    },
    { role: "tool" as const, toolCallId: "write", name: "computer_write_file", content: toolResult, isError: false },
  ];
  const assembly = await assembler.assemble(canonical, []);

  assert.equal(requests.length, 0);
  assert.equal(assembly.contextEpoch, 0);
  assert.equal(assembly.runtimeContext.content.includes("should not be used"), false);
  assert.ok(assembly.estimatedInputTokens > 1_000);
  assert.ok(assembly.estimatedInputTokens <= assembly.usableInputTokens);
  assert.ok(events.some((event) =>
    event.type === "context.compaction.skipped"
    && event.data.reason === "artifact_evidence_within_usable_window"
  ));
  assert.equal(events.some((event) => event.type === "context.compacted"), false);
});

test("ContextAssembler keeps projected file workflow context below a large model budget", async () => {
  const events: RuntimeEvent[] = [];
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 131_072, maxOutputTokens: 16_384 },
    complete: async () => {
      throw new Error("In-window context must not invoke model-backed compaction");
    },
  };
  const assembler = new ContextAssembler({
    runId: "run-file-workflow-large-window",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
    emit: (event) => { events.push(event); },
  });
  const artifactContent = "slide content ".repeat(2_000);
  const artifactReceipt = JSON.stringify({
    path: "deliverables/training-deck.html",
    bytes: artifactContent.length,
    sha256: "file-workflow-hash",
    artifactReceipt: {
      schema: "agentloop.artifactReceipt/v1",
      sourceTool: "computer_write_file",
      artifact: {
        path: "deliverables/training-deck.html",
        bytes: artifactContent.length,
        sha256: "file-workflow-hash",
      },
      evidenceKinds: { satisfied: ["artifact_path", "artifact_non_empty"], caveated: [], failed: [] },
    },
  });

  const assembly = await assembler.assemble([
    { role: "user", content: "prior execution detail ".repeat(7_000) },
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "write-deck",
        name: "computer_write_file",
        arguments: { path: "deliverables/training-deck.html", content: artifactContent },
      }],
    },
    {
      role: "tool",
      toolCallId: "write-deck",
      name: "computer_write_file",
      content: artifactReceipt,
      isError: false,
    },
  ], []);

  assert.ok(assembly.estimatedInputTokens > 24_000);
  assert.ok(assembly.estimatedInputTokens <= assembly.usableInputTokens);
  assert.equal(events.some((event) => event.type === "context.compaction.started"), false);
  assert.equal(events.some((event) => event.type === "context.compacted"), false);
});

test("ContextAssembler projects artifact acceptance receipts without losing caveated evidence kinds", async () => {
  const toolResult = JSON.stringify({
    schema: "agentloop.artifactAcceptance/v1",
    artifact: {
      path: "dcmm4-training.html",
      requestedPath: "dcmm4-training.html",
      bytes: 26_318,
      sha256: "artifact-hash",
      kind: "html_ppt",
      profileId: "html_ppt",
      inspectionTruncated: false,
    },
    verdict: "caveated",
    checks: [
      { id: "artifact_path", status: "passed", evidence: { path: "dcmm4-training.html" } },
      { id: "basic_navigation", status: "skipped_unavailable", evidence: { staticSignals: ["button_controls"], reason: "No browser renderer is configured for this runtime." }, diagnostics: "Browser-rendered navigation was not executed." },
      { id: "rendered_interaction", status: "skipped_unavailable", evidence: { requiredCapability: "browser_or_renderer_driver" }, diagnostics: "Rendered visual and interaction acceptance is unavailable in this runtime." },
    ],
    evidenceKinds: {
      satisfied: ["artifact_acceptance", "artifact_openable", "artifact_path"],
      caveated: ["artifact_acceptance", "basic_navigation", "explicit_caveats"],
      failed: [],
    },
    caveats: [
      "Browser-rendered navigation was not executed.",
      "Rendered visual and interaction acceptance is unavailable in this runtime.",
    ],
  });
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 64_000, maxOutputTokens: 4_096 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-artifact-acceptance-projection",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });

  const assembly = await assembler.assemble([
    { role: "assistant", content: "", toolCalls: [{ id: "accept", name: "verify_artifact_acceptance", arguments: { artifactPath: "dcmm4-training.html" } }] },
    { role: "tool", toolCallId: "accept", name: "verify_artifact_acceptance", content: toolResult, isError: false },
  ], []);
  const projected = assembly.messages.find((message) => message.role === "tool")?.content ?? "";
  const projection = JSON.parse(projected.split("\n\n")[0]) as {
    schema: string;
    verdict: string;
    evidenceKinds: { caveated: string[]; failed: string[] };
    checks: Array<{ id: string; status: string }>;
  };

  assert.equal(projection.schema, "agentloop.contextArtifactAcceptanceProjection/v1");
  assert.equal(projection.verdict, "caveated");
  assert.deepEqual(projection.evidenceKinds.failed, []);
  assert.ok(projection.evidenceKinds.caveated.includes("basic_navigation"));
  assert.ok(projection.checks.some((check) => check.id === "basic_navigation" && check.status === "skipped_unavailable"));
  assert.match(projected, /structured projection/);
});

test("ContextAssembler summarizes structured evidence as a receipt ledger", async () => {
  const requests: ModelInvocation[] = [];
  const rawContent = "raw source paragraph ".repeat(5_000);
  const longExcerpt = "important extracted fact ".repeat(1_000);
  const toolResult = JSON.stringify({
    schema: "agentloop.visibleReadFiles/v1",
    files: [{ path: "kb.md", content: rawContent, sha256: "content-hash", bytes: rawContent.length, characters: rawContent.length, truncated: false }],
    requested: 1,
    returned: 1,
    truncated: false,
    maxTotalCharacters: 200_000,
    evidenceReceipt: {
      schema: "agentloop.toolEvidenceReceipt/v1",
      sourceType: "visible_files",
      receiptId: "receipt-ledger-1",
      sourceRefs: [{ path: "kb.md", sha256: "content-hash", bytes: rawContent.length, characters: rawContent.length, truncated: false }],
      facts: [{
        kind: "source_read",
        path: "kb.md",
        title: "Travel",
        outline: [{ line: 1, text: "# Travel" }],
        fields: [],
        sections: [],
        excerpt: longExcerpt,
        truncated: false,
      }],
      caveats: ["canonical event retained"],
      evidenceKinds: { satisfied: ["source_read"], caveated: [], failed: [] },
    },
  });
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 24_000, maxOutputTokens: 4_096 },
    complete: async (request) => {
      requests.push(request);
      assert.equal(request.phase, "compaction");
      const prompt = request.messages[0]?.content ?? "";
      assert.match(prompt, /agentloop\.contextEvidenceLedger\/v1/);
      assert.match(prompt, /receipt-ledger-1/);
      assert.doesNotMatch(prompt, /agentloop\.contextEvidenceProjection\/v1/);
      assert.doesNotMatch(prompt, /raw source paragraph raw source paragraph raw source paragraph/);
      assert.doesNotMatch(prompt, /important extracted fact important extracted fact important extracted fact/);
      return { content: structuredSummary("receipt-ledger-1"), toolCalls: [], finishReason: "stop" };
    },
  };
  const assembler = new ContextAssembler({
    runId: "run-structured-evidence-ledger",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
    policy: { proactiveCompactionTokens: 1_000, preserveRecentTokens: 1_000, pruneProtectTokens: 1_000 },
  });

  const assembly = await assembler.assemble([
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "visible_read_files", arguments: { rootId: "visible_dir_1", files: [{ path: "kb.md" }] } }] },
    { role: "tool", toolCallId: "call-1", name: "visible_read_files", content: toolResult, isError: false },
    { role: "assistant", content: "large candidate context ".repeat(4_000) },
  ], []);

  assert.equal(requests.length, 1);
  assert.match(assembly.runtimeContext.content, /receipt-ledger-1/);
});

test("ContextAssembler reduces an overlong persisted summary before treating compaction as successful", async () => {
  const requests: ModelInvocation[] = [];
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 20_000, maxOutputTokens: 16_384 },
    complete: async (request) => {
      requests.push(request);
      if (request.messages[0]?.content.includes("<summary_to_reduce>")) {
        return { content: structuredSummary("kept"), toolCalls: [], finishReason: "stop" };
      }
      return { content: structuredSummary("verbose ".repeat(2_000)), toolCalls: [], finishReason: "stop" };
    },
  };
  const assembler = new ContextAssembler({
    runId: "run-summary-reduction",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });
  const assembly = await assembler.assemble([
    { role: "user", content: "source ".repeat(7_000) },
    { role: "assistant", content: "latest action" },
  ], []);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].maxOutputTokens, 8_192);
  assert.match(requests[0].messages[0]?.content ?? "", /at most 1600 estimated tokens/);
  assert.match(requests[1].messages[0]?.content ?? "", /at most 1600 estimated tokens/);
  assert.ok(estimateTextTokens(assembly.runtimeContext.content) < 1_600);
});

test("ContextAssembler retries a length-truncated summary without accepting partial content", async () => {
  const requests: ModelInvocation[] = [];
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 20_000, maxOutputTokens: 16_384 },
    complete: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          content: structuredSummary("partial content that must be discarded"),
          toolCalls: [],
          finishReason: "length",
          usage: { inputTokens: 4_000, outputTokens: 8_192 },
        };
      }
      return {
        content: structuredSummary("retry success"),
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 4_000, outputTokens: 200 },
      };
    },
  };
  const assembler = new ContextAssembler({
    runId: "run-summary-length-retry",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });
  const assembly = await assembler.assemble([
    { role: "user", content: "source ".repeat(7_000) },
    { role: "assistant", content: "latest action" },
  ], []);

  assert.equal(requests.length, 2);
  assert.match(requests[0].messages[0]?.content ?? "", /at most 1600 estimated tokens/);
  assert.match(requests[1].messages[0]?.content ?? "", /previous summarization attempt exceeded the output limit/i);
  assert.match(assembly.runtimeContext.content, /retry success/);
  assert.doesNotMatch(assembly.runtimeContext.content, /partial content/);
});

test("ContextAssembler skips failed proactive compaction when context still fits the model", async () => {
  const requests: ModelInvocation[] = [];
  const events: RuntimeEvent[] = [];
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 80_000, maxOutputTokens: 4_096 },
    complete: async (request) => {
      requests.push(request);
      return {
        content: structuredSummary("partial compaction that must not be accepted"),
        toolCalls: [],
        finishReason: "length",
        usage: { inputTokens: 2_000, outputTokens: 4_096 },
      };
    },
  };
  const assembler = new ContextAssembler({
    runId: "run-nonessential-compaction",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
    policy: { proactiveCompactionTokens: 1_000, preserveRecentTokens: 1_000, pruneProtectTokens: 1_000 },
    emit: (event) => { events.push(event); },
  });
  const canonical = [
    { role: "user" as const, content: "historical source ".repeat(2_500) },
    { role: "assistant" as const, content: "continue with current step" },
  ];

  const assembly = await assembler.assemble(canonical, []);

  assert.equal(requests.length, 2);
  assert.deepEqual(assembly.messages, canonical);
  assert.equal(assembly.contextEpoch, 0);
  assert.equal(assembly.runtimeContext.content.includes("partial compaction"), false);
  assert.ok(assembly.estimatedInputTokens <= assembly.usableInputTokens);
  assert.ok(events.some((event) => event.type === "context.compaction.started"));
  assert.ok(events.some((event) =>
    event.type === "context.compaction.skipped"
    && event.data.reason === "nonessential_compaction_failed"
    && event.data.code === "MODEL_ERROR"
  ));
  assert.equal(events.some((event) => event.type === "context.compacted"), false);
  assert.ok(events.some((event) => event.type === "context.assembled"));
});

test("ContextAssembler summarizes an oversized terminal candidate instead of retaining an over-budget tail", async () => {
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 20_000, maxOutputTokens: 1_024 },
    complete: async () => ({ content: structuredSummary("the original candidate remains canonical evidence"), toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-oversized-candidate",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
  });
  const oversizedCandidate = `candidate ${"detail ".repeat(12_000)}`;
  const assembly = await assembler.assemble([
    { role: "user", content: "Produce a verifiable result." },
    { role: "assistant", content: oversizedCandidate },
  ], []);

  assert.deepEqual(assembly.messages, []);
  assert.match(assembly.runtimeContext.content, /<structured_summary>/);
  assert.match(assembly.runtimeContext.content, /original candidate remains canonical evidence/);
  assert.ok(assembly.runtimeContext.supersedesId !== undefined);
  assert.ok(assembly.estimatedInputTokens <= assembly.usableInputTokens);
});

test("ContextAssembler projects large ToolResults before they pollute the next model turn", async () => {
  const events: RuntimeEvent[] = [];
  const model: ModelAdapter = {
    limits: { contextWindowTokens: 80_000, maxOutputTokens: 4_096 },
    complete: async () => ({ content: "unused", toolCalls: [], finishReason: "stop" }),
  };
  const assembler = new ContextAssembler({
    runId: "run-large-tool-projection",
    systemPrompt: "system",
    runtimeContext: { phase: "execution", content: "server runtime state" },
    model,
    emit: (event) => { events.push(event); },
  });
  const largeProfile = JSON.stringify({ rows: Array.from({ length: 2_500 }, (_, index) => ({ index, value: "profile row" })) });
  assert.ok(largeProfile.length > 16_000);
  const canonical = [
    {
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: "read-profile", name: "computer_read_file", arguments: { path: "source_profile.json" } }],
    },
    {
      role: "tool" as const,
      toolCallId: "read-profile",
      name: "computer_read_file",
      content: largeProfile,
      isError: false,
    },
  ];

  const assembly = await assembler.assemble(canonical, []);
  const projectedTool = assembly.messages.find((message) => message.role === "tool");
  assert.equal(projectedTool?.role, "tool");
  assert.ok((projectedTool?.content.length ?? 0) < largeProfile.length);
  assert.match(projectedTool?.content ?? "", /Large tool result projected/);
  assert.match(projectedTool?.content ?? "", /canonical event retained/);
  assert.ok(canonical[1].content.length === largeProfile.length, "canonical ToolResult remains unchanged");
  assert.ok(events.some((event) => event.type === "context.tool_outputs_projected"));
});

test("the Loop prunes old Tool output, compacts complete exchanges, and reloads a Skill whose body left the tail", async () => {
  const model = new CompactingSkillModel();
  const events: RuntimeEvent[] = [];
  const largeEvidence = "renderer-source-line\n".repeat(450);
  const registry = new ToolRegistry([
    stringTool("load_skill", () => [
      '<skill_content id="skill-1" name="presentation-skill" version="1" sha256="skill-hash">',
      "EXACT THIRD PARTY SKILL BODY",
      "</skill_content>",
    ].join("\n")),
    stringTool("inspect_renderer", () => largeEvidence),
  ]);
  const result = await runAgentLoop({
    runId: "run-compaction",
    systemPrompt: [
      "Follow the current Plan step.",
      "The exact Skill body is authoritative.",
    ].join("\n"),
    input: "Create the requested artifact without modifying the third-party Skill.",
    model,
    tools: registry,
    grant: createCapabilityGrant({
      actorUserId: "user-1",
      runId: "run-compaction",
      depth: 0,
      allowedToolNames: ["load_skill", "inspect_renderer"],
      allowedSkillIds: ["skill-1"],
    }),
    availableSkills: [{ id: "skill-1", name: "presentation-skill", contentHash: "skill-hash" }],
    maxSteps: 20,
    emit: (event) => { events.push(event); },
  });

  assert.equal(result.output, "artifact candidate complete");
  assert.ok(model.summaryCalls >= 1);
  assert.ok(model.skillLoadCalls >= 2, "Skill must be loaded again after its exact body is compacted out");
  assert.ok(events.some((event) => event.type === "context.tool_outputs_pruned"));
  assert.ok(events.some((event) => event.type === "context.compacted"));
  assert.ok(events.some((event) => event.type === "skill.activation.expired"));
  assert.ok(events.filter((event) => event.type === "skill.activated").length >= 2);
  const pruneIndex = events.findIndex((event) => event.type === "context.tool_outputs_pruned");
  const compactionIndex = events.findIndex((event) => event.type === "context.compaction.started");
  assert.ok(pruneIndex >= 0 && compactionIndex > pruneIndex, "Tool output pruning must precede summarization");
  const compacted = events.find((event) => event.type === "context.compacted");
  assert.ok(Number(compacted?.data.estimatedTokensAfter) < Number(compacted?.data.estimatedTokensBefore));
  assert.match(String(compacted?.data.summary), /Goal/);
  assert.ok(
    result.messages.some((message) => message.role === "tool" && message.content === largeEvidence),
    "Canonical messages retain the full ToolResult even though the model projection was pruned",
  );
});

class CompactingSkillModel implements ModelAdapter {
  readonly limits = { contextWindowTokens: 20_000, maxOutputTokens: 16_384 } as const;
  summaryCalls = 0;
  skillLoadCalls = 0;
  private inspections = 0;
  private serial = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.systemPrompt.includes("context summarization component")) {
      this.summaryCalls += 1;
      assert.deepEqual(request.tools, []);
      assert.equal(request.maxOutputTokens, 8_192);
      return {
        content: [
          "## Goal",
          "Create the requested artifact.",
          "## Constraints & Preferences",
          "- Do not modify the third-party Skill.",
          "## Progress",
          "### Done",
          "- Renderer evidence was inspected.",
          "### In Progress",
          "- Continue the admitted step.",
          "### Blocked",
          "- none",
          "## Key Decisions",
          "- **Skill authority**: reload the exact body after compaction.",
          "## Evidence",
          "- Canonical ToolResults remain persisted.",
          "## Next Steps",
          "1. Continue inspection and submit a candidate.",
          "## Critical Context",
          "- presentation-skill must be reloaded when absent.",
        ].join("\n"),
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 2_000, outputTokens: 300 },
      };
    }

    const toolNames = request.tools.map((tool) => tool.name);
    const hasLoadedSkill = request.messages.some((message) =>
      message.role === "tool" && message.name === "load_skill" && !message.isError
    );
    if (!hasLoadedSkill && toolNames.includes("load_skill")) {
      this.skillLoadCalls += 1;
      this.serial += 1;
      return {
        content: "",
        toolCalls: [{
          id: `load-${this.serial}`,
          name: "load_skill",
          arguments: { name: "presentation-skill" },
        }],
        finishReason: "tool_calls",
      };
    }

    assert.ok(toolNames.includes("inspect_renderer"));
    if (this.inspections < 5) {
      this.inspections += 1;
      this.serial += 1;
      return {
        content: `Inspection reasoning ${this.inspections}: ${"analysis ".repeat(1_100)}`,
        toolCalls: [{
          id: `inspect-${this.serial}`,
          name: "inspect_renderer",
          arguments: { pass: this.inspections },
        }],
        finishReason: "tool_calls",
      };
    }
    return { content: "artifact candidate complete", toolCalls: [], finishReason: "stop" };
  }
}

function stringTool(name: string, execute: () => string): RuntimeTool<unknown> {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    executionMode: "parallel",
    replaySafe: true,
    parse: (value) => value,
    execute: async () => execute(),
  };
}

function structuredSummary(body: string): string {
  return [
    "## Goal",
    body,
    "## Constraints & Preferences",
    "- constraint",
    "## Progress",
    "### Done",
    "- done",
    "### In Progress",
    "- work",
    "### Blocked",
    "- none",
    "## Key Decisions",
    "- **Decision**: reason",
    "## Evidence",
    "- evidence",
    "## Next Steps",
    "1. continue",
    "## Critical Context",
    "- identifier",
  ].join("\n");
}
