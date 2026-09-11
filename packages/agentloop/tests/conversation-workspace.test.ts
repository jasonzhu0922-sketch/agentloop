import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PlanProposal, Planner, TaskSpec } from "../src/planning/contracts.ts";
import type { ModelAdapter, ModelInvocation, ModelResponse } from "../src/runtime/contracts.ts";
import { RunService } from "../src/runtime/run-service.ts";
import { SkillService } from "../src/skills/skill-service.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SourceRepository } from "../src/storage/repositories/source-repository.ts";
import { approvingTestAssessor, singleStepTestPlanner, TEST_MODEL_LIMITS, testOwner } from "./runtime-test-helpers.ts";

test("Computer Tool writes are isolated by conversation and reused by follow-up runs", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-conversation-workspace-"));
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
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
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Run visible directories are exposed as read-only planning and execution capability", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-workspace-"));
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-visible-materials-"));
  const database = new AppDatabase(":memory:");
  try {
    await fs.writeFile(join(visible, "market-brief.md"), "Quarterly signal: local visible directory evidence.\n");

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner = new VisibleDirectoryPlanner();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => new VisibleDirectoryReadModel(),
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });

    const run = await runs.execute(owner.user.id, "读取 market-brief.md", {
      allowDangerousTools: true,
      visibleDirectories: [visible],
    });

    assert.equal(run.status, "completed");
    assert.match(run.output ?? "", /local visible directory evidence/);
    assert.equal(planner.visibleDirectoryCount, 1);
    assert.equal(planner.visibleToolAvailable, true);
    const started = (await runs.events(owner.user.id, run.id)).find((event) => event.type === "run.started");
    assert.equal(Array.isArray(started?.data.visibleDirectories), true);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(visible, { recursive: true, force: true });
  }
});

test("Conversation visible directories persist across follow-up runs until explicitly cleared", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-bound-visible-workspace-"));
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-bound-visible-materials-"));
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner = new RecordingVisibleDirectoryPlanner();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => new NoToolCompletionModel(),
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });

    const first = await runs.execute(owner.user.id, "bind visible directory", {
      allowDangerousTools: true,
      visibleDirectories: [visible],
    });
    assert.ok(first.conversationId);
    const second = await runs.execute(owner.user.id, "reuse bound visible directory", {
      allowDangerousTools: true,
      conversationId: first.conversationId,
    });

    assert.equal(second.conversationId, first.conversationId);
    assert.deepEqual(planner.visibleDirectoryCounts, [1, 1]);
    assert.deepEqual((await runs.getConversation(owner.user.id, first.conversationId)).conversation.visibleDirectories, [
      await fs.realpath(visible),
    ]);

    await runs.updateConversationVisibleDirectories(owner.user.id, first.conversationId, []);
    await runs.execute(owner.user.id, "after user removed visible directory", {
      allowDangerousTools: true,
      conversationId: first.conversationId,
    });
    assert.deepEqual(planner.visibleDirectoryCounts, [1, 1, 0]);
    assert.deepEqual((await runs.getConversation(owner.user.id, first.conversationId)).conversation.visibleDirectories, []);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(visible, { recursive: true, force: true });
  }
});

test("Conversation entry classifies with Runtime-owned external context handles", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-auto-visible-workspace-"));
  const visible = await fs.mkdtemp(join(tmpdir(), "agentloop-auto-visible-materials-"));
  const database = new AppDatabase(":memory:");
  try {
    await fs.writeFile(join(visible, "performance.xlsx"), "xlsx-like fixture");

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner = new RecordingVisibleDirectoryPlanner();
    const model = new ContextAwareConversationIntentModel();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => model,
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });

    const executionRun = await runs.executeConversation(owner.user.id, "帮我分析一下这个绩效评价情况", {
      allowDangerousTools: true,
      visibleDirectories: [visible],
    });
    const replyRun = await runs.executeConversation(owner.user.id, "刚才我问了什么？", {
      allowDangerousTools: true,
      conversationId: executionRun.conversationId,
    });

    assert.equal(executionRun.status, "completed");
    assert.equal(replyRun.status, "completed");
    assert.equal(model.intentCalls, 2);
    assert.match(model.intentContexts[0] ?? "", /agentloop\.conversationIntentContext\/v1/);
    assert.match(model.intentContexts[0] ?? "", /"visibleDirectories":\[/);
    assert.deepEqual(planner.visibleDirectoryCounts, [1, 1]);
    assert.deepEqual(planner.responseOnlyFlags, [false, true]);
    assert.equal(planner.availableToolNameSnapshots[0]?.includes("visible_find_files"), true);
    assert.equal(planner.availableToolNameSnapshots[0]?.includes("visible_read_files"), true);
    assert.deepEqual(planner.availableToolNameSnapshots[1], []);
    assert.deepEqual((await runs.events(owner.user.id, executionRun.id)).find((event) => event.type === "conversation.intent.classified")?.data, { kind: "execute" });
    assert.deepEqual((await runs.events(owner.user.id, replyRun.id)).find((event) => event.type === "conversation.intent.classified")?.data, { kind: "reply" });
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(visible, { recursive: true, force: true });
  }
});

test("Generic Run execution does not opt into conversation intent classification", async () => {
  const database = new AppDatabase(":memory:");
  try {
    const skills = new SkillService(database);
    const owner = testOwner();
    const model = new ContextAwareConversationIntentModel();
    const runs = new RunService({
      database,
      skills,
      modelFactory: () => model,
      plannerFactory: () => singleStepTestPlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });

    await assert.rejects(
      () => runs.executeConversation(owner.user.id, "你好", { conversationIntent: "auto" }),
      /conversationIntent is Runtime-owned/,
    );
    const genericRun = await runs.execute(owner.user.id, "process this generic task");
    assert.equal(genericRun.status, "completed");
    assert.equal(model.intentCalls, 0);
    assert.equal((await runs.events(owner.user.id, genericRun.id)).some((event) => event.type === "conversation.intent.classified"), false);

    const conversationRun = await runs.executeConversation(owner.user.id, "你好");
    assert.equal(conversationRun.status, "completed");
    assert.equal(model.intentCalls, 1);
    assert.deepEqual((await runs.events(owner.user.id, conversationRun.id)).find((event) => event.type === "conversation.intent.classified")?.data, { kind: "reply" });
  } finally {
    await database.close();
  }
});

test("Uploaded sources are bound to a run and read through source tools", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-upload-source-workspace-"));
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const planner = new UploadedSourcePlanner();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => new UploadedSourceReadModel(),
      plannerFactory: () => planner,
      assessorFactory: () => approvingTestAssessor(),
    });
    const source = await runs.uploadSource(owner.user.id, {
      originalName: "revenue.csv",
      mimeType: "text/csv",
      content: Buffer.from("region,revenue\nNorth,120\nSouth,80\n", "utf8"),
    });

    const run = await runs.execute(owner.user.id, "分析上传文件中的收入", {
      allowDangerousTools: true,
      sourceIds: [source.id],
    });

    assert.equal(run.status, "completed");
    assert.equal(run.sources?.length, 1);
    assert.equal(run.sources?.[0]?.originalName, "revenue.csv");
    assert.match(run.output ?? "", /read_source/);
    assert.equal(planner.sourceCount, 1);
    assert.equal(planner.readSourceAvailable, true);
    const conversation = await runs.getConversation(owner.user.id, run.conversationId!);
    assert.equal(conversation.runs[0].sources?.length, 1);
    assert.equal(conversation.runs[0].sources?.[0]?.originalName, "revenue.csv");
    const started = (await runs.events(owner.user.id, run.id)).find((event) => event.type === "run.started");
    assert.equal(Array.isArray(started?.data.sources), true);
    const sourceRead = (await runs.events(owner.user.id, run.id)).find((event) =>
      event.type === "tool.completed" && event.data.toolName === "read_source"
    );
    assert.match(String(sourceRead?.data.result ?? ""), /North,120/);
    assert.equal((await runs.source(owner.user.id, source.id)).chunkCount, 1);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Uploaded source query matches separated search terms instead of one literal phrase", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-upload-source-query-"));
  const database = new AppDatabase(":memory:");
  try {

    const skills = new SkillService(database);
    const owner = testOwner();
    const runs = new RunService({
      database,
      skills,
      workspaceRoot: workspace,
      modelFactory: () => new UploadedSourceQueryModel(),
      plannerFactory: () => new UploadedSourcePlanner(),
      assessorFactory: () => approvingTestAssessor(),
    });
    const source = await runs.uploadSource(owner.user.id, {
      originalName: "foreign-affairs-plan.md",
      mimeType: "text/markdown",
      content: Buffer.from([
        "打造智能化因公出国数字化管理平台。",
        "应用RPA等技术自动化高频流程，利用AI进行风险预警与合规检查。",
        "第一阶段推进风险国别AI预警、照片AI质检和材料智能预审。",
      ].join("\n"), "utf8"),
    });

    const run = await runs.execute(owner.user.id, "总结外事业务 AI 规划", {
      allowDangerousTools: true,
      sourceIds: [source.id],
    });

    assert.equal(run.status, "completed");
    const sourceRead = (await runs.events(owner.user.id, run.id)).find((event) =>
      event.type === "tool.completed" && event.data.toolName === "read_source"
    );
    assert.match(String(sourceRead?.data.result ?? ""), /利用AI进行风险预警/);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Uploaded CID-font PDFs with ToUnicode maps become readable source chunks", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-upload-cid-pdf-"));
  const database = new AppDatabase(":memory:");
  try {

    const owner = testOwner();
    const runs = new RunService({
      database,
      skills: new SkillService(database),
      workspaceRoot: workspace,
      modelFactory: () => { throw new Error("model is not used"); },
    });
    const source = await runs.uploadSource(owner.user.id, {
      originalName: "评估报告案例.pdf",
      mimeType: "application/pdf",
      content: minimalUnicodeCmapPdf("上海虹桥站 碳减排评估报告"),
    });

    assert.equal(source.status, "ready");
    assert.equal(source.chunkCount, 1);
    assert.match(source.summary ?? "", /上海虹桥站\s*碳减排评估报告/);
    const chunks = await new SourceRepository(database).chunks(source.id);
    assert.match(chunks[0]?.content ?? "", /上海虹桥站\s*碳减排评估报告/);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

function minimalUnicodeCmapPdf(text: string): Buffer {
  const entries = [...text];
  const encoded = entries
    .map((_char, index) => (index + 1).toString(16).padStart(4, "0"))
    .join("");
  const cmapEntries = entries
    .map((char, index) => `<${(index + 1).toString(16).padStart(4, "0")}> <${utf16BeHex(char)}>`)
    .join("\n");
  const content = `BT /F1 12 Tf 72 720 Td <${encoded}> Tj ET`;
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${entries.length} beginbfchar
${cmapEntries}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /TestCID /Encoding /Identity-H /ToUnicode 6 0 R >>",
    `<< /Length ${Buffer.byteLength(cmap, "latin1")} >>\nstream\n${cmap}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function utf16BeHex(value: string): string {
  const utf16 = Buffer.from(value, "utf16le");
  const swapped = Buffer.alloc(utf16.length);
  for (let index = 0; index + 1 < utf16.length; index += 2) {
    swapped[index] = utf16[index + 1]!;
    swapped[index + 1] = utf16[index]!;
  }
  return swapped.toString("hex").toUpperCase();
}

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

class VisibleDirectoryPlanner implements Planner {
  visibleDirectoryCount = 0;
  visibleToolAvailable = false;

  async plan(task: TaskSpec): Promise<PlanProposal> {
    this.visibleDirectoryCount = task.visibleDirectories?.length ?? 0;
    this.visibleToolAvailable = task.availableToolNames.includes("visible_find_files")
      && task.availableToolNames.includes("visible_read_file");
    return {
      goal: "read visible material",
      selectedSkillIds: [],
      steps: [{
        id: "read_visible_material",
        objective: "Find and read market-brief.md from the authorized visible directory.",
        dependencies: [],
        skillIds: [],
        requiredCapabilities: ["visible_directory_read"],
        successCriteria: [{ id: "read", description: "The visible directory file content was read.", source: "planner" }],
      }],
    };
  }
}

class RecordingVisibleDirectoryPlanner implements Planner {
  readonly visibleDirectoryCounts: number[] = [];
  readonly availableToolNameSnapshots: string[][] = [];
  readonly responseOnlyFlags: boolean[] = [];
  lastAvailableToolNames: readonly string[] = [];

  async plan(task: TaskSpec): Promise<PlanProposal> {
    const hasVisibleTools = task.availableToolNames.includes("visible_find_files")
      && task.availableToolNames.includes("visible_read_file");
    this.visibleDirectoryCounts.push(task.visibleDirectories?.length ?? 0);
    this.availableToolNameSnapshots.push([...task.availableToolNames]);
    this.responseOnlyFlags.push(task.responseOnly === true);
    this.lastAvailableToolNames = task.availableToolNames;
    return {
      goal: "record visible directory binding",
      selectedSkillIds: [],
      steps: [{
        id: "record-visible-binding",
        objective: "Record whether visible directory bindings were supplied to this run.",
        dependencies: [],
        skillIds: [],
        requiredCapabilities: hasVisibleTools ? ["visible_directory_read"] : [],
        successCriteria: [{
          id: "recorded",
          description: "The visible directory binding count was observed by the planner.",
          source: "planner",
        }],
      }],
    };
  }
}

class VisibleDirectoryReadModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    assert.match(request.runtimeContext?.content ?? "", /"visibleDirectories":\[/);
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "find-visible",
          name: "visible_find_files",
          arguments: { rootId: "visible_dir_1", pattern: "**/market-brief.md" },
        }],
      };
    }
    if (this.calls === 2) {
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-visible",
          name: "visible_read_file",
          arguments: { rootId: "visible_dir_1", path: "market-brief.md" },
        }],
      };
    }
    return {
      content: "Read market-brief.md: local visible directory evidence.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class UploadedSourcePlanner implements Planner {
  sourceCount = 0;
  readSourceAvailable = false;

  async plan(task: TaskSpec): Promise<PlanProposal> {
    this.sourceCount = task.sources?.length ?? 0;
    this.readSourceAvailable = task.availableToolNames.includes("read_source");
    return {
      goal: "read uploaded source",
      selectedSkillIds: [],
      steps: [{
        id: "read-uploaded-source",
        objective: "Read the uploaded revenue source and summarize the observed rows.",
        dependencies: [],
        skillIds: [],
        requiredCapabilities: ["uploaded_source_read"],
        successCriteria: [{ id: "read-source", description: "The uploaded source chunk was read.", source: "planner" }],
      }],
    };
  }
}

class UploadedSourceReadModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    assert.match(request.runtimeContext?.content ?? "", /"sources":\[/);
    this.calls += 1;
    if (this.calls === 1) {
      const context = request.runtimeContext?.content ?? "";
      const sourceId = /"id":"(src_[a-f0-9]{32})"/.exec(context)?.[1];
      assert.ok(sourceId);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-source",
          name: "read_source",
          arguments: { sourceId, chunkIndex: 0 },
        }],
      };
    }
    return {
      content: "Uploaded source read through read_source.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class UploadedSourceQueryModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  private calls = 0;

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      const context = request.runtimeContext?.content ?? "";
      const sourceId = /"id":"(src_[a-f0-9]{32})"/.exec(context)?.[1];
      assert.ok(sourceId);
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: "read-source-query",
          name: "read_source",
          arguments: {
            sourceId,
            chunkIndex: 0,
            query: "人工智能 AI 智能化 规划",
            maxChunks: 10,
          },
        }],
      };
    }
    return {
      content: "Uploaded source query matched AI planning evidence.",
      finishReason: "stop",
      toolCalls: [],
    };
  }
}

class NoToolCompletionModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;

  async complete(): Promise<ModelResponse> {
    return { content: "visible directory binding recorded", finishReason: "stop", toolCalls: [] };
  }
}

class ContextAwareConversationIntentModel implements ModelAdapter {
  readonly limits = TEST_MODEL_LIMITS;
  intentCalls = 0;
  readonly intentContexts: string[] = [];

  async complete(request: ModelInvocation): Promise<ModelResponse> {
    if (request.runId.startsWith("conversation-intent:")) {
      this.intentCalls += 1;
      const context = request.runtimeContext?.content ?? "";
      this.intentContexts.push(context);
      assert.match(context, /agentloop\.conversationIntentContext\/v1/);
      const latest = request.messages.filter((message) => message.role === "user").at(-1)?.content ?? "";
      const kind = latest.includes("分析") ? "execute" : "reply";
      return {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{
          id: `intent-${this.intentCalls}`,
          name: "classify_conversation_intent",
          arguments: { kind },
        }],
      };
    }
    return { content: "conversation intent handled", finishReason: "stop", toolCalls: [] };
  }
}
