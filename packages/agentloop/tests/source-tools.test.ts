import { testOwner } from "./runtime-test-helpers.ts";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCapabilityGrant } from "../src/runtime/capability-grant.ts";
import { SourceIntakeService } from "../src/runtime/source-intake-service.ts";
import { createSourceTools } from "../src/tools/source-tools.ts";
import { AppDatabase } from "../src/storage/database.ts";
import { SourceRepository } from "../src/storage/repositories/source-repository.ts";

const require = createRequire(import.meta.url);
const JSZip = require("jszip") as {
  new(): {
    file(path: string, content: string): unknown;
    generateAsync(options: { type: "nodebuffer" }): Promise<Buffer>;
  };
};

test("read_source returns uploaded chunk content with receipt coverage and explicit caveats", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const owner = testOwner();
    const repository = new SourceRepository(database);
    const now = Date.now();
    const source = await repository.insertSource({
      id: "src_11111111111111111111111111111111",
      ownerUserId: owner.user.id,
      originalName: "plan.csv",
      mimeType: "text/csv",
      extension: ".csv",
      byteSize: 22,
      sha256: "source-sha",
      storagePath: "/server-owned/upload/original",
      status: "ready",
      summary: "plan.csv has one task row.",
      tokenEstimate: 8,
      characterCount: 22,
      truncated: false,
      createdAt: now,
    });
    await repository.replaceChunks(source.id, [{
      chunk_index: 0,
      kind: "text",
      locator: "chars=1-22",
      content: "task,owner\nrisk,alice\n",
      token_estimate: 8,
      sha256: "chunk-sha",
    }], now);
    const tool = createSourceTools(repository)[0];
    const grant = createCapabilityGrant({
      actorUserId: owner.user.id,
      runId: "run-read-source",
      depth: 0,
      uploadedSources: [{
        id: source.id,
        originalName: source.original_name,
        mimeType: source.mime_type,
        extension: source.extension,
        byteSize: source.byte_size,
        sha256: source.sha256,
        status: source.status,
        summary: source.summary ?? undefined,
        chunkCount: 1,
        truncated: false,
      }],
      allowedToolNames: ["read_source"],
      allowedSkillIds: [],
    });

    const full = await tool.execute({ grant }, tool.parse({
      sourceId: source.id,
      chunkIndex: 0,
      maxChunks: 1,
    })) as {
      schema: string;
      totalChunks: number;
      returnedChunks: number;
      chunks: Array<{ chunkIndex: number; content: string }>;
      evidenceReceipt: {
        facts: Array<{ returnedChunkIndexes: number[] }>;
        evidenceKinds: { satisfied: string[]; caveated: string[] };
      };
    };
    assert.equal(full.schema, "agentloop.uploadedSourceRead/v1");
    assert.equal(full.totalChunks, 1);
    assert.equal(full.returnedChunks, 1);
    assert.equal(full.chunks[0]?.chunkIndex, 0);
    assert.match(full.chunks[0]?.content ?? "", /risk,alice/);
    assert.deepEqual(full.evidenceReceipt.facts[0]?.returnedChunkIndexes, [0]);
    assert.ok(full.evidenceReceipt.evidenceKinds.satisfied.includes("source_summary"));
    assert.ok(full.evidenceReceipt.evidenceKinds.satisfied.includes("explicit_caveats"));
    assert.deepEqual(full.evidenceReceipt.evidenceKinds.caveated, []);

    const missing = await tool.execute({ grant }, tool.parse({
      sourceId: source.id,
      chunkIndex: 10,
      maxChunks: 1,
    })) as {
      chunks: unknown[];
      evidenceReceipt: { caveats: string[]; evidenceKinds: { satisfied: string[]; caveated: string[] } };
    };
    assert.deepEqual(missing.chunks, []);
    assert.match(missing.evidenceReceipt.caveats.join("\n"), /No source chunks matched/);
    assert.deepEqual(missing.evidenceReceipt.evidenceKinds.satisfied, []);
    assert.ok(missing.evidenceReceipt.evidenceKinds.caveated.includes("source_summary"));
    assert.ok(missing.evidenceReceipt.evidenceKinds.caveated.includes("explicit_caveats"));
  } finally {
    await database.close();
  }
});

test("extract_source_tables preserves sparse uploaded XLSX columns and embedded delimiters", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-uploaded-table-workspace-"));
  const storage = join(workspace, "server-owned-original");
  try {
    const owner = testOwner();
    const repository = new SourceRepository(database);
    const workbook = await sparsePlanWorkbook();
    await fs.writeFile(storage, workbook);
    const now = Date.now();
    const source = await repository.insertSource({
      id: "src_44444444444444444444444444444444",
      ownerUserId: owner.user.id,
      originalName: "7月产品组推进计划.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: ".xlsx",
      byteSize: workbook.length,
      sha256: "uploaded-workbook-sha",
      storagePath: storage,
      status: "ready",
      summary: "Uploaded workbook is ready.",
      tokenEstimate: 10,
      characterCount: 20,
      truncated: false,
      createdAt: now,
    });
    const tool = createSourceTools(repository).find((item) => item.name === "extract_source_tables");
    if (tool === undefined) throw new Error("extract_source_tables is missing");
    const grant = createCapabilityGrant({
      actorUserId: owner.user.id,
      runId: "run-uploaded-table",
      depth: 0,
      workspaceRoot: workspace,
      uploadedSources: [{
        id: source.id,
        originalName: source.original_name,
        mimeType: source.mime_type,
        extension: source.extension,
        byteSize: source.byte_size,
        sha256: source.sha256,
        status: source.status,
        summary: source.summary ?? undefined,
        chunkCount: 1,
        truncated: false,
      }],
      allowedToolNames: ["extract_source_tables"],
      allowedSkillIds: [],
    });

    const result = await tool.execute({ grant }, tool.parse({ sourceId: source.id })) as {
      sourceId: string;
      originalName: string;
      totalRecords: number;
      files: Array<{
        path: string;
        sheets: Array<{
          columns: Array<{ name: string; index: number }>;
          records: Array<{ row: number; values: Record<string, string | number | boolean> }>;
        }>;
      }>;
      artifact: { path: string; manifest: { tables: Array<{ recordsPointer: string; fields: Array<{ name: string }> }> } };
      evidenceReceipt: { sourceType: string; evidenceKinds: { satisfied: string[] } };
    };

    assert.equal(result.sourceId, source.id);
    assert.equal(result.originalName, "7月产品组推进计划.xlsx");
    assert.equal(result.totalRecords, 2);
    const sheet = result.files[0]?.sheets[0];
    assert.deepEqual(sheet?.columns.map((column) => [column.name, column.index]), [
      ["序号", 1], ["任务名称", 2], ["责任人", 3], ["月度目标", 4],
    ]);
    assert.deepEqual(sheet?.records[0]?.values, {
      "序号": 1,
      "任务名称": "平台建设",
      "责任人": "王明杰",
      "月度目标": "数据查询执行适配,标准化查询执行",
    });
    assert.deepEqual(sheet?.records[1]?.values, {
      "序号": 2,
      "责任人": "王乙茜",
      "月度目标": "连接器迁移适配",
    });
    assert.match(result.artifact.path, /^\.agentloop\/table-extractions\//);
    assert.equal(result.artifact.manifest.tables[0]?.recordsPointer, "/files/0/sheets/0/records");
    assert.deepEqual(result.artifact.manifest.tables[0]?.fields.map((field) => field.name), ["序号", "任务名称", "责任人", "月度目标"]);
    assert.equal(result.evidenceReceipt.sourceType, "uploaded_table_extraction");
    assert.ok(result.evidenceReceipt.evidenceKinds.satisfied.includes("structured_extraction_artifact"));
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("XLSX source preview keeps sparse physical columns as JSON rows", async () => {
  const database = new AppDatabase(":memory:");
  const workspace = await fs.mkdtemp(join(tmpdir(), "agentloop-uploaded-xlsx-preview-"));
  try {
    const owner = testOwner();
    const repository = new SourceRepository(database);
    const intake = new SourceIntakeService(repository, workspace);
    const source = await intake.upload({
      ownerUserId: owner.user.id,
      originalName: "7月产品组推进计划.xlsx",
      content: await sparsePlanWorkbook(),
    });

    const preview = (await repository.chunks(source.id)).map((chunk) => chunk.content).join("\n");
    assert.match(preview, /\["1","平台建设","王明杰","数据查询执行适配,标准化查询执行"\]/);
    assert.match(preview, /\["2","","王乙茜","连接器迁移适配"\]/);
    assert.doesNotMatch(preview, /2,王乙茜,连接器迁移适配/);
  } finally {
    await database.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("read_source treats chunkIndex and maxChunks as a consecutive read window", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const owner = testOwner();
    const repository = new SourceRepository(database);
    const now = Date.now();
    const source = await repository.insertSource({
      id: "src_22222222222222222222222222222222",
      ownerUserId: owner.user.id,
      originalName: "paper.txt",
      mimeType: "text/plain",
      extension: ".txt",
      byteSize: 60,
      sha256: "source-sha-window",
      storagePath: "/server-owned/upload/window-original",
      status: "ready",
      summary: "paper.txt has four chunks.",
      tokenEstimate: 20,
      characterCount: 60,
      truncated: false,
      createdAt: now,
    });
    await repository.replaceChunks(source.id, [
      {
        chunk_index: 0,
        kind: "text",
        locator: "chars=1-15",
        content: "chunk zero",
        token_estimate: 3,
        sha256: "chunk-sha-0",
      },
      {
        chunk_index: 1,
        kind: "text",
        locator: "chars=16-30",
        content: "chunk one",
        token_estimate: 3,
        sha256: "chunk-sha-1",
      },
      {
        chunk_index: 2,
        kind: "text",
        locator: "chars=31-45",
        content: "chunk two",
        token_estimate: 3,
        sha256: "chunk-sha-2",
      },
      {
        chunk_index: 3,
        kind: "text",
        locator: "chars=46-60",
        content: "chunk three",
        token_estimate: 3,
        sha256: "chunk-sha-3",
      },
    ], now);
    const tool = createSourceTools(repository)[0];
    const grant = createCapabilityGrant({
      actorUserId: owner.user.id,
      runId: "run-read-source-window",
      depth: 0,
      uploadedSources: [{
        id: source.id,
        originalName: source.original_name,
        mimeType: source.mime_type,
        extension: source.extension,
        byteSize: source.byte_size,
        sha256: source.sha256,
        status: source.status,
        summary: source.summary ?? undefined,
        chunkCount: 4,
        truncated: false,
      }],
      allowedToolNames: ["read_source"],
      allowedSkillIds: [],
    });

    const result = await tool.execute({ grant }, tool.parse({
      sourceId: source.id,
      chunkIndex: 1,
      maxChunks: 2,
    })) as {
      returnedChunks: number;
      selectedChunks: number;
      chunks: Array<{ chunkIndex: number; content: string }>;
      evidenceReceipt: {
        facts: Array<{ returnedChunkIndexes: number[] }>;
        caveats: string[];
        evidenceKinds: { satisfied: string[]; caveated: string[] };
      };
    };

    assert.equal(result.selectedChunks, 2);
    assert.equal(result.returnedChunks, 2);
    assert.deepEqual(result.chunks.map((chunk) => chunk.chunkIndex), [1, 2]);
    assert.deepEqual(result.chunks.map((chunk) => chunk.content), ["chunk one", "chunk two"]);
    assert.deepEqual(result.evidenceReceipt.facts[0]?.returnedChunkIndexes, [1, 2]);
    assert.deepEqual(result.evidenceReceipt.caveats, []);
    assert.ok(result.evidenceReceipt.evidenceKinds.satisfied.includes("source_summary"));
    assert.ok(result.evidenceReceipt.evidenceKinds.satisfied.includes("explicit_caveats"));
    assert.deepEqual(result.evidenceReceipt.evidenceKinds.caveated, []);

    const windowedQuery = await tool.execute({ grant }, tool.parse({
      sourceId: source.id,
      chunkIndex: 1,
      maxChunks: 2,
      query: "three",
    })) as {
      returnedChunks: number;
      selectedChunks: number;
      chunks: Array<{ chunkIndex: number; content: string }>;
      evidenceReceipt: { caveats: string[]; evidenceKinds: { satisfied: string[]; caveated: string[] } };
    };
    assert.equal(windowedQuery.selectedChunks, 0);
    assert.equal(windowedQuery.returnedChunks, 0);
    assert.deepEqual(windowedQuery.chunks, []);
    assert.match(windowedQuery.evidenceReceipt.caveats.join("\n"), /No source chunks matched/);
  } finally {
    await database.close();
  }
});

test("read_source treats blank query as omitted and defaults unfiltered reads to full small sources", async () => {
  const database = new AppDatabase(":memory:");
  try {

    const owner = testOwner();
    const repository = new SourceRepository(database);
    const now = Date.now();
    const source = await repository.insertSource({
      id: "src_33333333333333333333333333333333",
      ownerUserId: owner.user.id,
      originalName: "brief.md",
      mimeType: "text/markdown",
      extension: ".md",
      byteSize: 90,
      sha256: "source-sha-small-full",
      storagePath: "/server-owned/upload/small-full-original",
      status: "ready",
      summary: "brief.md has three chunks.",
      tokenEstimate: 30,
      characterCount: 90,
      truncated: false,
      createdAt: now,
    });
    await repository.replaceChunks(source.id, [
      {
        chunk_index: 0,
        kind: "text",
        locator: "chars=1-30",
        content: "alpha overview",
        token_estimate: 5,
        sha256: "chunk-sha-alpha",
      },
      {
        chunk_index: 1,
        kind: "text",
        locator: "chars=31-60",
        content: "beta details",
        token_estimate: 5,
        sha256: "chunk-sha-beta",
      },
      {
        chunk_index: 2,
        kind: "text",
        locator: "chars=61-90",
        content: "gamma caveats",
        token_estimate: 5,
        sha256: "chunk-sha-gamma",
      },
    ], now);
    const tool = createSourceTools(repository)[0];
    const grant = createCapabilityGrant({
      actorUserId: owner.user.id,
      runId: "run-read-source-blank-query",
      depth: 0,
      uploadedSources: [{
        id: source.id,
        originalName: source.original_name,
        mimeType: source.mime_type,
        extension: source.extension,
        byteSize: source.byte_size,
        sha256: source.sha256,
        status: source.status,
        summary: source.summary ?? undefined,
        chunkCount: 3,
        truncated: false,
      }],
      allowedToolNames: ["read_source"],
      allowedSkillIds: [],
    });

    const blankQuery = await tool.execute({ grant }, tool.parse({
      sourceId: source.id,
      query: "   ",
    })) as {
      returnedChunks: number;
      selectedChunks: number;
      chunks: Array<{ chunkIndex: number; content: string }>;
      evidenceReceipt: {
        facts: Array<{ selectedBy: string; returnedChunkIndexes: number[] }>;
        caveats: string[];
      };
    };

    assert.equal(blankQuery.selectedChunks, 3);
    assert.equal(blankQuery.returnedChunks, 3);
    assert.deepEqual(blankQuery.chunks.map((chunk) => chunk.chunkIndex), [0, 1, 2]);
    assert.deepEqual(blankQuery.evidenceReceipt.facts[0]?.returnedChunkIndexes, [0, 1, 2]);
    assert.equal(blankQuery.evidenceReceipt.facts[0]?.selectedBy, "chunkIndex");
    assert.deepEqual(blankQuery.evidenceReceipt.caveats, []);

    const windowFromSecondChunk = await tool.execute({ grant }, tool.parse({
      sourceId: source.id,
      chunkIndex: 1,
      query: "",
    })) as {
      returnedChunks: number;
      selectedChunks: number;
      chunks: Array<{ chunkIndex: number; content: string }>;
      evidenceReceipt: { facts: Array<{ selectedBy: string; returnedChunkIndexes: number[] }> };
    };

    assert.equal(windowFromSecondChunk.selectedChunks, 2);
    assert.equal(windowFromSecondChunk.returnedChunks, 2);
    assert.deepEqual(windowFromSecondChunk.chunks.map((chunk) => chunk.content), ["beta details", "gamma caveats"]);
    assert.deepEqual(windowFromSecondChunk.evidenceReceipt.facts[0]?.returnedChunkIndexes, [1, 2]);
    assert.equal(windowFromSecondChunk.evidenceReceipt.facts[0]?.selectedBy, "chunkIndex");
  } finally {
    await database.close();
  }
});

async function sparsePlanWorkbook(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="工作表1" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
    <worksheet><sheetData>
      <row r="1">
        <c r="A1" t="inlineStr"><is><t>序号</t></is></c>
        <c r="B1" t="inlineStr"><is><t>任务名称</t></is></c>
        <c r="C1" t="inlineStr"><is><t>责任人</t></is></c>
        <c r="D1" t="inlineStr"><is><t>月度目标</t></is></c>
      </row>
      <row r="2">
        <c r="A2"><v>1</v></c>
        <c r="B2" t="inlineStr"><is><t>平台建设</t></is></c>
        <c r="C2" t="inlineStr"><is><t>王明杰</t></is></c>
        <c r="D2" t="inlineStr"><is><t>数据查询执行适配,标准化查询执行</t></is></c>
      </row>
      <row r="3">
        <c r="A3"><v>2</v></c>
        <c r="C3" t="inlineStr"><is><t>王乙茜</t></is></c>
        <c r="D3" t="inlineStr"><is><t>连接器迁移适配</t></is></c>
      </row>
    </sheetData></worksheet>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
